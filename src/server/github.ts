import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { and, eq } from "drizzle-orm";
import { db } from "~/server/db";
import { accounts } from "~/server/db/schema";
import { log } from "~/server/logger";

export async function getGithubTokenForUser(userId: string): Promise<string> {
  const [account] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "github")))
    .limit(1);

  if (!account?.accessToken) {
    throw new GithubAuthError("No GitHub access token linked to this account");
  }
  return account.accessToken;
}

export class GithubAuthError extends Error {
  readonly kind = "auth" as const;
}

export class GithubRateLimitError extends Error {
  readonly kind = "rate_limit" as const;
  retryAfterSeconds: number;
  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const ThrottledOctokit = Octokit.plugin(throttling);

export function octokitFor(token: string): Octokit {
  return new ThrottledOctokit({
    auth: token,
    userAgent: "dmo/0.1",
    throttle: {
      onRateLimit: (retryAfter, options, _octokit, retryCount) => {
        const ctx = {
          method: options.method,
          url: options.url,
          retryAfter,
          retryCount,
          kind: "primary" as const,
        };
        if (retryCount < 1 && retryAfter <= 60) {
          log.warn("github rate limit hit, retrying", ctx);
          return true;
        }
        log.error("github rate limit exhausted", ctx);
        throw new GithubRateLimitError(
          `GitHub rate limit hit on ${options.method} ${options.url}. Retry after ${retryAfter}s.`,
          retryAfter,
        );
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        const ctx = {
          method: options.method,
          url: options.url,
          retryAfter,
          retryCount,
          kind: "secondary" as const,
        };
        // Secondary rate limits on /search/* almost always return retryAfter ~60s.
        // Wait it out once rather than failing fast and asking the user to retry.
        if (retryCount < 1 && retryAfter <= 90) {
          log.warn("github secondary rate limit hit, waiting and retrying", ctx);
          return true;
        }
        log.error("github secondary rate limit exhausted", ctx);
        return false;
      },
    },
  });
}

export type UpdateType = "patch" | "minor" | "major" | "unknown";
export type Ecosystem =
  | "npm"
  | "docker"
  | "github-actions"
  | "pip"
  | "cargo"
  | "go"
  | "maven"
  | "gradle"
  | "bundler"
  | "composer"
  | "other";

export type DependabotPr = {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  repoFullName: string;
  repoOwner: string;
  repoName: string;
  ecosystem: Ecosystem;
  updateType: UpdateType;
  dependency: string | null;
  fromVersion: string | null;
  toVersion: string | null;
  draft: boolean;
  labels: string[];
};

const ECOSYSTEM_LABELS: Record<string, Ecosystem> = {
  npm_and_yarn: "npm",
  docker: "docker",
  "github-actions": "github-actions",
  github_actions: "github-actions",
  python: "pip",
  pip: "pip",
  rust: "cargo",
  cargo: "cargo",
  go: "go",
  go_modules: "go",
  java: "maven",
  maven: "maven",
  gradle: "gradle",
  ruby: "bundler",
  bundler: "bundler",
  php: "composer",
  composer: "composer",
};

function detectEcosystem(labels: string[]): Ecosystem {
  for (const label of labels) {
    const mapped = ECOSYSTEM_LABELS[label.toLowerCase()];
    if (mapped) return mapped;
  }
  return "other";
}

const BUMP_RE =
  /bump\s+(?:`)?([\w@./-]+)(?:`)?\s+from\s+(?:`)?([\w.+-]+)(?:`)?\s+to\s+(?:`)?([\w.+-]+)(?:`)?/i;

function classifyUpdate(from: string | null, to: string | null): UpdateType {
  if (!from || !to) return "unknown";
  const fromParts = from
    .replace(/^v/, "")
    .split(".")
    .map((p) => parseInt(p, 10));
  const toParts = to
    .replace(/^v/, "")
    .split(".")
    .map((p) => parseInt(p, 10));
  if (fromParts.some(Number.isNaN) || toParts.some(Number.isNaN)) return "unknown";
  if ((fromParts[0] ?? 0) !== (toParts[0] ?? 0)) return "major";
  if ((fromParts[1] ?? 0) !== (toParts[1] ?? 0)) return "minor";
  if ((fromParts[2] ?? 0) !== (toParts[2] ?? 0)) return "patch";
  return "unknown";
}

function parseTitle(title: string): {
  dependency: string | null;
  from: string | null;
  to: string | null;
} {
  const stripped = title.replace(/^chore\([^)]*\):\s*/i, "");
  const m = stripped.match(BUMP_RE);
  if (!m) return { dependency: null, from: null, to: null };
  return { dependency: m[1] ?? null, from: m[2] ?? null, to: m[3] ?? null };
}

const DEPENDABOT_CACHE_TTL_MS = 60_000;
const dependabotCache = new Map<string, { data: DependabotPr[]; expiresAt: number }>();

export function invalidateDependabotCache(userId: string): void {
  dependabotCache.delete(userId);
}

const DEPENDABOT_LOGIN = "dependabot[bot]";

export type WatchedRepoRef = { owner: string; name: string };

async function fetchDependabotPrsFromRepo(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<DependabotPr[]> {
  const repoFullName = `${owner}/${repo}`;
  const all = await octokit.paginate(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "open",
    per_page: 100,
    sort: "created",
    direction: "desc",
  });
  const out: DependabotPr[] = [];
  for (const pr of all) {
    if (pr.user?.login !== DEPENDABOT_LOGIN) continue;
    const labels = pr.labels
      .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
      .filter(Boolean);
    const parsed = parseTitle(pr.title);
    out.push({
      id: pr.id,
      nodeId: pr.node_id,
      number: pr.number,
      title: pr.title,
      htmlUrl: pr.html_url,
      createdAt: pr.created_at,
      updatedAt: pr.updated_at,
      repoFullName,
      repoOwner: owner,
      repoName: repo,
      ecosystem: detectEcosystem(labels),
      updateType: classifyUpdate(parsed.from, parsed.to),
      dependency: parsed.dependency,
      fromVersion: parsed.from,
      toVersion: parsed.to,
      draft: Boolean(pr.draft),
      labels,
    });
  }
  return out;
}

export async function listDependabotPrs(
  userId: string,
  token: string,
  repos: WatchedRepoRef[],
): Promise<DependabotPr[]> {
  const now = Date.now();
  const cached = dependabotCache.get(userId);
  if (cached && cached.expiresAt > now) return cached.data;

  if (repos.length === 0) {
    dependabotCache.set(userId, { data: [], expiresAt: now + DEPENDABOT_CACHE_TTL_MS });
    return [];
  }

  const octokit = octokitFor(token);
  const results: DependabotPr[] = [];
  const concurrency = Math.min(6, repos.length);
  let cursor = 0;
  let fatal: Error | null = null;

  async function worker() {
    while (cursor < repos.length && !fatal) {
      const i = cursor++;
      const repo = repos[i];
      if (!repo) continue;
      try {
        const prs = await fetchDependabotPrsFromRepo(octokit, repo.owner, repo.name);
        results.push(...prs);
      } catch (err) {
        const mapped = mapGithubError(err, `list PRs for ${repo.owner}/${repo.name}`);
        if (mapped instanceof GithubRateLimitError) {
          fatal = mapped;
          return;
        }
        log.warn("dependabot fetch failed for repo", {
          repo: `${repo.owner}/${repo.name}`,
          message: mapped.message,
        });
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  if (fatal) throw fatal;

  results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  dependabotCache.set(userId, { data: results, expiresAt: Date.now() + DEPENDABOT_CACHE_TTL_MS });
  return results;
}

type OctokitErrorShape = {
  status?: number;
  response?: {
    headers?: Record<string, string | undefined>;
    data?: { message?: string };
  };
};

function detectRateLimit(err: OctokitErrorShape): GithubRateLimitError | null {
  const status = err.status;
  if (status !== 403 && status !== 429) return null;
  const headers = err.response?.headers ?? {};
  const remaining = headers["x-ratelimit-remaining"];
  const retryAfterHeader = headers["retry-after"];
  const body = err.response?.data?.message ?? "";
  const looksLikeRateLimit =
    remaining === "0" ||
    retryAfterHeader != null ||
    /rate limit/i.test(body) ||
    /abuse/i.test(body);
  if (!looksLikeRateLimit) return null;
  const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) || 60 : 60;
  return new GithubRateLimitError(`GitHub rate limit hit. Retry after ${retryAfter}s.`, retryAfter);
}

function mapGithubError(err: unknown, action: string): Error {
  if (err instanceof GithubRateLimitError || err instanceof GithubAuthError) return err;
  const e = err as OctokitErrorShape;
  const status = e.status;
  const message = err instanceof Error ? err.message : String(err);
  const rateLimit = detectRateLimit(e);
  if (rateLimit) return rateLimit;
  if (status === 401) return new GithubAuthError(`GitHub rejected the token. Sign in again.`);
  if (status === 403) {
    return new GithubAuthError(
      `GitHub denied access while trying to ${action}. Check token scopes (repo) and any org SAML SSO authorization.`,
    );
  }
  if (status === 422)
    return new Error(`GitHub validation failed while trying to ${action}: ${message}`);
  return new Error(`GitHub error while trying to ${action}: ${message}`);
}

export type RepoSummary = {
  fullName: string;
  owner: string;
  name: string;
  private: boolean;
  htmlUrl: string;
};

export async function listAccessibleRepos(token: string): Promise<RepoSummary[]> {
  const octokit = octokitFor(token);
  try {
    const repos = await octokit.paginate(octokit.rest.repos.listForAuthenticatedUser, {
      per_page: 100,
      sort: "pushed",
      affiliation: "owner,collaborator,organization_member",
    });
    return repos.map((r) => ({
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      private: r.private,
      htmlUrl: r.html_url,
    }));
  } catch (err) {
    throw mapGithubError(err, "list accessible repositories");
  }
}

export type PrActionResult = {
  repoFullName: string;
  number: number;
  ok: boolean;
  approved: boolean;
  merged: boolean;
  error?: string;
};

export async function approveAndMergePr(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
): Promise<PrActionResult> {
  const octokit = octokitFor(token);
  const result: PrActionResult = {
    repoFullName: `${owner}/${repo}`,
    number: pullNumber,
    ok: false,
    approved: false,
    merged: false,
  };

  try {
    try {
      await octokit.rest.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: "APPROVE",
      });
      result.approved = true;
    } catch (err) {
      // GitHub rejects self-approval with HTTP 422. Continue to merge if so.
      const status = (err as { status?: number }).status;
      if (status !== 422) throw err;
    }

    await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: mergeMethod,
    });
    result.merged = true;
    result.ok = true;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }
  return result;
}
