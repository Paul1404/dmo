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

export async function getGithubLoginForUser(userId: string): Promise<string> {
  const token = await getGithubTokenForUser(userId);
  const octokit = octokitFor(token);
  const { data } = await octokit.users.getAuthenticated();
  return data.login;
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

export function detectEcosystem(labels: string[]): Ecosystem {
  for (const label of labels) {
    const mapped = ECOSYSTEM_LABELS[label.toLowerCase()];
    if (mapped) return mapped;
  }
  return "other";
}

const BUMP_RE =
  /bump\s+(?:`)?([\w@./-]+)(?:`)?\s+from\s+(?:`)?([\w.+-]+)(?:`)?\s+to\s+(?:`)?([\w.+-]+)(?:`)?/i;

export function classifyUpdate(from: string | null, to: string | null): UpdateType {
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

export function parseTitle(title: string): {
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

export type DependabotConfigFile = {
  content: string;
  sha: string;
  path: ".github/dependabot.yml" | ".github/dependabot.yaml";
};

const CONFIG_PATHS = [".github/dependabot.yml", ".github/dependabot.yaml"] as const;

function decodeBase64(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

function encodeBase64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

export async function getDependabotConfig(
  token: string,
  owner: string,
  repo: string,
): Promise<DependabotConfigFile | null> {
  const octokit = octokitFor(token);
  for (const path of CONFIG_PATHS) {
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) continue;
      return {
        content: decodeBase64(data.content.replace(/\n/g, "")),
        sha: data.sha,
        path,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) continue;
      throw mapGithubError(err, `read dependabot config for ${owner}/${repo}`);
    }
  }
  return null;
}

export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string,
): Promise<{ name: string; sha: string }> {
  const octokit = octokitFor(token);
  try {
    const { data: repository } = await octokit.rest.repos.get({ owner, repo });
    const branchName = repository.default_branch;
    const { data: ref } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branchName}`,
    });
    return { name: branchName, sha: ref.object.sha };
  } catch (err) {
    throw mapGithubError(err, `read default branch for ${owner}/${repo}`);
  }
}

export type ConfigSyncResult =
  | { kind: "synced"; prNumber: number; prUrl: string; branchName: string }
  | { kind: "pr_open"; prNumber: number; prUrl: string; branchName: string }
  | { kind: "no_change" };

const CONFIG_BRANCH_PREFIX = "dmo/sync-dependabot-config";

export async function findOpenConfigSyncPr(
  token: string,
  owner: string,
  repo: string,
): Promise<{ prNumber: number; prUrl: string; branchName: string } | null> {
  const octokit = octokitFor(token);
  try {
    const prs = await octokit.paginate(octokit.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });
    for (const pr of prs) {
      const branch = pr.head?.ref;
      if (branch?.startsWith(CONFIG_BRANCH_PREFIX)) {
        return { prNumber: pr.number, prUrl: pr.html_url, branchName: branch };
      }
    }
    return null;
  } catch (err) {
    throw mapGithubError(err, `search existing config PR for ${owner}/${repo}`);
  }
}

export async function createConfigSyncPr(
  token: string,
  owner: string,
  repo: string,
  options: {
    desiredYaml: string;
    commitMessage: string;
    prTitle: string;
    prBody: string;
    runId: string;
  },
): Promise<ConfigSyncResult> {
  const octokit = octokitFor(token);

  const existing = await findOpenConfigSyncPr(token, owner, repo);
  if (existing) return { kind: "pr_open", ...existing };

  const current = await getDependabotConfig(token, owner, repo);
  if (current && current.content === options.desiredYaml) {
    return { kind: "no_change" };
  }

  const targetPath = current?.path ?? ".github/dependabot.yml";
  const defaultBranch = await getDefaultBranch(token, owner, repo);
  const branchName = `${CONFIG_BRANCH_PREFIX}-${options.runId.slice(0, 8)}`;

  let branchExisted = false;
  try {
    await octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: defaultBranch.sha,
    });
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 422)
      throw mapGithubError(err, `create branch ${branchName} on ${owner}/${repo}`);
    branchExisted = true;
  }

  // When reusing a branch from a prior failed attempt, the file on that branch
  // may already differ from the default branch. We must commit against the
  // file SHA on the branch itself or GitHub rejects the update with 409.
  let commitSha: string | undefined = current?.sha;
  if (branchExisted) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: targetPath,
        ref: branchName,
      });
      if (!Array.isArray(data) && data.type === "file" && "sha" in data) {
        commitSha = data.sha;
      } else {
        commitSha = undefined;
      }
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        commitSha = undefined;
      } else {
        throw mapGithubError(err, `read ${targetPath} on ${owner}/${repo}@${branchName}`);
      }
    }
  }

  try {
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: targetPath,
      message: options.commitMessage,
      content: encodeBase64(options.desiredYaml),
      branch: branchName,
      sha: commitSha,
    });
  } catch (err) {
    throw mapGithubError(err, `commit ${targetPath} on ${owner}/${repo}@${branchName}`);
  }

  try {
    const { data: pr } = await octokit.rest.pulls.create({
      owner,
      repo,
      title: options.prTitle,
      head: branchName,
      base: defaultBranch.name,
      body: options.prBody,
    });
    return { kind: "synced", prNumber: pr.number, prUrl: pr.html_url, branchName };
  } catch (err) {
    throw mapGithubError(err, `open PR on ${owner}/${repo} from ${branchName}`);
  }
}

export type PrReadiness =
  | { kind: "ready" }
  | { kind: "computing" }
  | { kind: "conflict" }
  | { kind: "blocked"; reason: string }
  | { kind: "closed"; merged: boolean }
  | { kind: "draft" };

export async function probePrReadiness(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
): Promise<PrReadiness> {
  const octokit = octokitFor(token);
  try {
    const { data: pr } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    if (pr.state === "closed") return { kind: "closed", merged: Boolean(pr.merged) };
    if (pr.draft) return { kind: "draft" };
    if (pr.mergeable == null) return { kind: "computing" };
    const state = pr.mergeable_state;
    if (state === "dirty") return { kind: "conflict" };
    if (state === "behind") return { kind: "conflict" };
    if (state === "blocked") return { kind: "blocked", reason: "blocked by branch protection" };
    if (!pr.mergeable) return { kind: "conflict" };
    return { kind: "ready" };
  } catch (err) {
    throw mapGithubError(err, `probe PR ${owner}/${repo}#${pullNumber}`);
  }
}

export type MergeOutcome =
  | { kind: "merged" }
  | { kind: "not_mergeable" }
  | { kind: "blocked"; reason: string };

export async function approveAndMergePr(
  token: string,
  owner: string,
  repo: string,
  pullNumber: number,
  mergeMethod: "merge" | "squash" | "rebase" = "squash",
): Promise<MergeOutcome> {
  const octokit = octokitFor(token);

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "APPROVE",
    });
  } catch (err) {
    // GitHub rejects self-approval with HTTP 422. Proceed to merge anyway.
    const status = (err as { status?: number }).status;
    if (status !== 422) throw mapGithubError(err, `approve PR ${owner}/${repo}#${pullNumber}`);
  }

  try {
    await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: pullNumber,
      merge_method: mergeMethod,
    });
    return { kind: "merged" };
  } catch (err) {
    const status = (err as { status?: number }).status;
    // 405: PR not currently mergeable (conflicts, behind, branch protection).
    // 409: SHA mismatch (someone else updated). Both are transient: try again later.
    if (status === 405 || status === 409) return { kind: "not_mergeable" };
    if (status === 403) {
      // A 403 can be a hard permission/branch-protection block OR a transient
      // secondary rate limit ("abuse detection"). Only the former is permanent.
      // Misreading a rate limit as "blocked" fails the PR for good instead of
      // letting the worker back off and retry.
      const rateLimit = detectRateLimit(err as OctokitErrorShape);
      if (rateLimit) throw rateLimit;
      const message = err instanceof Error ? err.message : String(err);
      return { kind: "blocked", reason: message };
    }
    throw mapGithubError(err, `merge PR ${owner}/${repo}#${pullNumber}`);
  }
}
