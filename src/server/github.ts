import { throttling } from "@octokit/plugin-throttling";
import { Octokit } from "@octokit/rest";
import { and, eq } from "drizzle-orm";
import { db } from "~/server/db";
import { accounts } from "~/server/db/schema";

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
        if (retryCount < 1 && retryAfter <= 60) {
          return true;
        }
        throw new GithubRateLimitError(
          `GitHub rate limit hit on ${options.method} ${options.url}. Retry after ${retryAfter}s.`,
          retryAfter,
        );
      },
      onSecondaryRateLimit: (retryAfter, options, _octokit, retryCount) => {
        if (retryCount < 2 && retryAfter <= 30) {
          return true;
        }
        throw new GithubRateLimitError(
          `GitHub secondary rate limit hit on ${options.method} ${options.url}. Retry after ${retryAfter}s.`,
          retryAfter,
        );
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

export async function listDependabotPrs(token: string): Promise<DependabotPr[]> {
  const octokit = octokitFor(token);
  const query = "is:pr is:open author:app/dependabot archived:false";

  const results: DependabotPr[] = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    let data: Awaited<ReturnType<typeof octokit.rest.search.issuesAndPullRequests>>["data"];
    try {
      ({ data } = await octokit.rest.search.issuesAndPullRequests({
        q: query,
        per_page: perPage,
        page,
        advanced_search: "true",
      }));
    } catch (err) {
      throw mapGithubError(err, "search dependabot pull requests");
    }

    for (const item of data.items) {
      // repository_url is like https://api.github.com/repos/owner/repo
      const repoFullName = item.repository_url.replace("https://api.github.com/repos/", "");
      const [owner = "", name = ""] = repoFullName.split("/");
      const labels = item.labels
        .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
        .filter(Boolean);
      const parsed = parseTitle(item.title);
      results.push({
        id: item.id,
        nodeId: item.node_id,
        number: item.number,
        title: item.title,
        htmlUrl: item.html_url,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        repoFullName,
        repoOwner: owner,
        repoName: name,
        ecosystem: detectEcosystem(labels),
        updateType: classifyUpdate(parsed.from, parsed.to),
        dependency: parsed.dependency,
        fromVersion: parsed.from,
        toVersion: parsed.to,
        draft: Boolean(item.draft),
        labels,
      });
    }

    if (data.items.length < perPage) break;
    if (results.length >= data.total_count) break;
    page += 1;
    if (page > 10) break; // hard cap, 1000 PRs
    // Small pacing delay to stay under GitHub search secondary rate limits.
    await new Promise((r) => setTimeout(r, 250));
  }
  return results;
}

function mapGithubError(err: unknown, action: string): Error {
  if (err instanceof GithubRateLimitError || err instanceof GithubAuthError) return err;
  const status = (err as { status?: number }).status;
  const message = err instanceof Error ? err.message : String(err);
  if (status === 401) return new GithubAuthError(`GitHub rejected the token. Sign in again.`);
  if (status === 403) {
    // 403 without rate-limit handler hit typically means missing scope, SSO, or org access.
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
