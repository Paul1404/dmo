import type { Octokit } from "@octokit/rest";
import {
  GithubAuthError,
  GithubRateLimitError,
  octokitFor,
  type WatchedRepoRef,
} from "~/server/github";
import { log } from "~/server/logger";

export type DepEcosystem = "npm" | "docker" | "python";

export type Dependency = {
  name: string;
  version: string | null;
  ecosystem: DepEcosystem;
  dev: boolean;
};

export type RepoDependencies = {
  owner: string;
  name: string;
  fullName: string;
  dependencies: Dependency[];
  error: string | null;
  scanned: { npm: boolean; docker: boolean; python: boolean };
};

export type DependenciesOverview = {
  repos: RepoDependencies[];
  scannedAt: string;
};

const OVERVIEW_CACHE_TTL_MS = 5 * 60_000;
const overviewCache = new Map<string, { data: DependenciesOverview; expiresAt: number }>();

export function invalidateDependenciesCache(userId: string): void {
  overviewCache.delete(userId);
}

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
    return decodeBase64(data.content.replace(/\n/g, ""));
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return null;
    throw err;
  }
}

function parsePackageJson(content: string): Dependency[] {
  try {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    const out: Dependency[] = [];
    for (const [name, version] of Object.entries(parsed.dependencies ?? {})) {
      out.push({ name, version, ecosystem: "npm", dev: false });
    }
    for (const [name, version] of Object.entries(parsed.devDependencies ?? {})) {
      out.push({ name, version, ecosystem: "npm", dev: true });
    }
    for (const [name, version] of Object.entries(parsed.peerDependencies ?? {})) {
      if (!out.some((d) => d.name === name)) {
        out.push({ name, version, ecosystem: "npm", dev: false });
      }
    }
    return out;
  } catch {
    return [];
  }
}

function parseDockerfile(content: string): Dependency[] {
  const out: Dependency[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^FROM\s+(?:--platform=\S+\s+)?([^\s]+)(?:\s+AS\s+\S+)?$/i);
    if (!m?.[1]) continue;
    const image = m[1];
    if (image.startsWith("$")) continue;
    const atIdx = image.indexOf("@");
    const base = atIdx >= 0 ? image.slice(0, atIdx) : image;
    const colonIdx = base.lastIndexOf(":");
    const slashAfterColon = colonIdx >= 0 && base.indexOf("/", colonIdx) >= 0;
    let name: string;
    let version: string | null;
    if (colonIdx >= 0 && !slashAfterColon) {
      name = base.slice(0, colonIdx);
      version = base.slice(colonIdx + 1);
    } else {
      name = base;
      version = null;
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, version, ecosystem: "docker", dev: false });
  }
  return out;
}

function parseRequirementsTxt(content: string): Dependency[] {
  const out: Dependency[] = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.split("#")[0]?.trim();
    if (!line) continue;
    if (line.startsWith("-")) continue;
    const m = line.match(/^([A-Za-z0-9_.\-[\]]+)\s*([<>=!~].*)?$/);
    if (!m?.[1]) continue;
    const name = m[1].replace(/\[.*?\]$/, "");
    const version = m[2]?.trim() || null;
    out.push({ name, version, ecosystem: "python", dev: false });
  }
  return out;
}

function parsePyprojectToml(content: string): Dependency[] {
  const out: Dependency[] = [];
  const seen = new Set<string>();

  const pep621 = content.match(/\[project\][\s\S]*?dependencies\s*=\s*\[([\s\S]*?)\]/);
  if (pep621?.[1]) {
    const items = pep621[1].match(/"([^"]+)"|'([^']+)'/g) ?? [];
    for (const item of items) {
      const raw = item.slice(1, -1);
      const m = raw.match(/^([A-Za-z0-9_.\-[\]]+)\s*(.*)$/);
      if (m?.[1]) {
        const name = m[1].replace(/\[.*?\]$/, "");
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({
          name,
          version: m[2]?.trim() || null,
          ecosystem: "python",
          dev: false,
        });
      }
    }
  }

  const poetryBlock = content.match(/\[tool\.poetry\.dependencies\]([\s\S]*?)(?=\n\[|$)/);
  if (poetryBlock?.[1]) {
    for (const line of poetryBlock[1].split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const m = trimmed.match(
        /^([A-Za-z0-9_.-]+)\s*=\s*(?:"([^"]+)"|'([^']+)'|\{[^}]*?version\s*=\s*"([^"]+)")/,
      );
      if (!m?.[1]) continue;
      if (m[1].toLowerCase() === "python") continue;
      if (seen.has(m[1])) continue;
      seen.add(m[1]);
      out.push({
        name: m[1],
        version: m[2] ?? m[3] ?? m[4] ?? null,
        ecosystem: "python",
        dev: false,
      });
    }
  }

  return out;
}

async function scanRepo(octokit: Octokit, repo: WatchedRepoRef): Promise<RepoDependencies> {
  const fullName = `${repo.owner}/${repo.name}`;
  const result: RepoDependencies = {
    owner: repo.owner,
    name: repo.name,
    fullName,
    dependencies: [],
    error: null,
    scanned: { npm: false, docker: false, python: false },
  };

  const tasks = await Promise.allSettled([
    fetchFileContent(octokit, repo.owner, repo.name, "package.json"),
    fetchFileContent(octokit, repo.owner, repo.name, "Dockerfile"),
    fetchFileContent(octokit, repo.owner, repo.name, "pyproject.toml"),
    fetchFileContent(octokit, repo.owner, repo.name, "requirements.txt"),
  ]);

  for (const t of tasks) {
    if (t.status === "rejected" && t.reason instanceof GithubRateLimitError) {
      throw t.reason;
    }
  }

  const [pkgRes, dockerRes, pyprojectRes, requirementsRes] = tasks;

  if (pkgRes.status === "fulfilled" && pkgRes.value) {
    result.dependencies.push(...parsePackageJson(pkgRes.value));
    result.scanned.npm = true;
  }
  if (dockerRes.status === "fulfilled" && dockerRes.value) {
    result.dependencies.push(...parseDockerfile(dockerRes.value));
    result.scanned.docker = true;
  }
  if (pyprojectRes.status === "fulfilled" && pyprojectRes.value) {
    result.dependencies.push(...parsePyprojectToml(pyprojectRes.value));
    result.scanned.python = true;
  }
  if (requirementsRes.status === "fulfilled" && requirementsRes.value) {
    const reqs = parseRequirementsTxt(requirementsRes.value);
    const seen = new Set(
      result.dependencies.filter((d) => d.ecosystem === "python").map((d) => d.name),
    );
    for (const dep of reqs) {
      if (seen.has(dep.name)) continue;
      seen.add(dep.name);
      result.dependencies.push(dep);
    }
    result.scanned.python = true;
  }

  const errors = tasks
    .filter((t): t is PromiseRejectedResult => t.status === "rejected")
    .map((t) => (t.reason instanceof Error ? t.reason.message : String(t.reason)));
  if (errors.length === tasks.length) {
    result.error = errors[0] ?? "Failed to read manifests";
  }

  return result;
}

export async function listDependenciesOverview(
  userId: string,
  token: string,
  repos: WatchedRepoRef[],
): Promise<DependenciesOverview> {
  const now = Date.now();
  const cached = overviewCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.data;

  if (repos.length === 0) {
    const empty: DependenciesOverview = { repos: [], scannedAt: new Date().toISOString() };
    overviewCache.set(userId, { data: empty, expiresAt: now + OVERVIEW_CACHE_TTL_MS });
    return empty;
  }

  const octokit = octokitFor(token);
  const results = new Array<RepoDependencies>(repos.length);
  const concurrency = Math.min(4, repos.length);
  let cursor = 0;
  let fatal: Error | null = null;

  async function worker() {
    while (cursor < repos.length && !fatal) {
      const i = cursor++;
      const repo = repos[i];
      if (!repo) continue;
      try {
        results[i] = await scanRepo(octokit, repo);
      } catch (err) {
        if (err instanceof GithubRateLimitError) {
          fatal = err;
          return;
        }
        if (err instanceof GithubAuthError) {
          fatal = err;
          return;
        }
        log.warn("dependency scan failed for repo", {
          repo: `${repo.owner}/${repo.name}`,
          message: err instanceof Error ? err.message : String(err),
        });
        results[i] = {
          owner: repo.owner,
          name: repo.name,
          fullName: `${repo.owner}/${repo.name}`,
          dependencies: [],
          error: err instanceof Error ? err.message : String(err),
          scanned: { npm: false, docker: false, python: false },
        };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  if (fatal) throw fatal;

  const overview: DependenciesOverview = {
    repos: results.filter(Boolean),
    scannedAt: new Date().toISOString(),
  };
  overviewCache.set(userId, { data: overview, expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS });
  return overview;
}
