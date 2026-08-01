import { and, asc, eq } from "drizzle-orm";
import { db } from "~/server/db";
import { maintenanceRunResults, maintenanceRuns, watchedRepos } from "~/server/db/schema";
import { listDependenciesOverview, type RepoAutomationProfile } from "~/server/dependencies";
import {
  type DependabotPr,
  getDependabotConfig,
  getGithubTokenForUser,
  listDependabotPrs,
  type WatchedRepoRef,
} from "~/server/github";
import { assertMutationsEnabled } from "~/server/limits";

export type FleetRepo = {
  fullName: string;
  owner: string;
  name: string;
  automation: RepoAutomationProfile;
  dependencyCount: number;
  prs: DependabotPr[];
};

export type FleetSnapshot = {
  scannedAt: string;
  watchedCount: number;
  totalPrs: number;
  repos: FleetRepo[];
};

export type MaintenanceEvidence = {
  commitShas?: string[];
  pullRequests?: string[];
  checks?: Array<{ name: string; status: string; url?: string }>;
  deployment?: {
    provider?: string;
    status: string;
    deploymentId?: string;
    url?: string;
    healthUrl?: string;
    healthStatus?: number;
    version?: string;
  };
  blockers?: string[];
};

export type MaintenanceResultStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "skipped";

type StoredSnapshot = {
  scannedAt: string;
  totalPrs: number;
  repos: Array<{
    fullName: string;
    owner: string;
    name: string;
    automation: RepoAutomationProfile;
    prs: DependabotPr[];
  }>;
};

async function watchedForUser(userId: string): Promise<WatchedRepoRef[]> {
  return db
    .select({ owner: watchedRepos.repoOwner, name: watchedRepos.repoName })
    .from(watchedRepos)
    .where(eq(watchedRepos.userId, userId));
}

function normalizedSet(values?: string[]): Set<string> | null {
  if (!values || values.length === 0) return null;
  return new Set(values.map((value) => value.trim().toLowerCase()));
}

export async function getFleetSnapshot(
  userId: string,
  repositories?: string[],
  pullRequests?: string[],
): Promise<FleetSnapshot> {
  const watched = await watchedForUser(userId);
  const token = await getGithubTokenForUser(userId);
  const [allPrs, overview] = await Promise.all([
    listDependabotPrs(userId, token, watched),
    listDependenciesOverview(userId, token, watched),
  ]);
  const requestedRepositories = normalizedSet(repositories);
  const requestedPullRequests = normalizedSet(pullRequests);
  const profiles = new Map(overview.repos.map((repo) => [repo.fullName.toLowerCase(), repo]));
  const prsByRepo = new Map<string, DependabotPr[]>();
  for (const pr of allPrs) {
    const key = pr.repoFullName.toLowerCase();
    if (requestedRepositories && !requestedRepositories.has(key)) continue;
    if (requestedPullRequests && !requestedPullRequests.has(`${key}#${pr.number}`)) continue;
    const items = prsByRepo.get(key) ?? [];
    items.push(pr);
    prsByRepo.set(key, items);
  }
  const repos = Array.from(prsByRepo.entries())
    .map(([key, prs]) => {
      const profile = profiles.get(key);
      const first = prs[0];
      if (!first) return null;
      return {
        fullName: first.repoFullName,
        owner: first.repoOwner,
        name: first.repoName,
        automation: profile?.automation ?? {
          archived: false,
          defaultBranch: "main",
          packageManager: "unknown" as const,
          installCommand: null,
          verifyCommands: [],
          deploymentProvider: "unknown" as const,
          healthcheckPath: null,
        },
        dependencyCount: profile?.dependencies.length ?? 0,
        prs: prs.sort((a, b) => a.number - b.number),
      };
    })
    .filter((repo): repo is FleetRepo => repo !== null)
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
  return {
    scannedAt: overview.scannedAt,
    watchedCount: watched.length,
    totalPrs: repos.reduce((sum, repo) => sum + repo.prs.length, 0),
    repos,
  };
}

export async function getRepoMaintenanceContext(userId: string, repository: string) {
  const watched = await watchedForUser(userId);
  const key = repository.trim().toLowerCase();
  const repo = watched.find((item) => `${item.owner}/${item.name}`.toLowerCase() === key);
  if (!repo) throw new Error(`${repository} is not in the DMO watch list`);
  const token = await getGithubTokenForUser(userId);
  const [allPrs, overview, dependabotConfig] = await Promise.all([
    listDependabotPrs(userId, token, watched),
    listDependenciesOverview(userId, token, watched),
    getDependabotConfig(token, repo.owner, repo.name).catch((error) => ({
      error: error instanceof Error ? error.message : String(error),
    })),
  ]);
  const profile = overview.repos.find((item) => item.fullName.toLowerCase() === key);
  return {
    repository: `${repo.owner}/${repo.name}`,
    scannedAt: overview.scannedAt,
    automation: profile?.automation ?? null,
    dependencies: profile?.dependencies ?? [],
    scanError: profile?.error ?? null,
    dependabotConfig,
    prs: allPrs.filter((pr) => pr.repoFullName.toLowerCase() === key),
  };
}

export async function createMaintenanceRun(
  userId: string,
  input: { repositories?: string[]; pullRequests?: string[]; note?: string },
) {
  assertMutationsEnabled();
  const fleet = await getFleetSnapshot(userId, input.repositories, input.pullRequests);
  const requestedPullRequests = normalizedSet(input.pullRequests);
  if (requestedPullRequests) {
    const matched = new Set(
      fleet.repos.flatMap((repo) =>
        repo.prs.map((pr) => `${pr.repoFullName.toLowerCase()}#${pr.number}`),
      ),
    );
    const missing = Array.from(requestedPullRequests).filter(
      (pullRequest) => !matched.has(pullRequest),
    );
    if (missing.length > 0) {
      throw new Error(`Open watched Dependabot PRs not found: ${missing.join(", ")}`);
    }
  }
  if (fleet.totalPrs === 0) throw new Error("No open Dependabot PRs match this run");
  const id = crypto.randomUUID();
  const snapshot: StoredSnapshot = {
    scannedAt: fleet.scannedAt,
    totalPrs: fleet.totalPrs,
    repos: fleet.repos.map((repo) => ({
      fullName: repo.fullName,
      owner: repo.owner,
      name: repo.name,
      automation: repo.automation,
      prs: repo.prs,
    })),
  };
  const skippedRepos = snapshot.repos.filter((repo) => repo.automation.archived).length;
  const allSkipped = skippedRepos === snapshot.repos.length;
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(maintenanceRuns).values({
      id,
      userId,
      status: allSkipped ? "completed" : "active",
      note: input.note?.trim() || null,
      snapshot,
      totalRepos: snapshot.repos.length,
      totalPrs: snapshot.totalPrs,
      completedRepos: skippedRepos,
      createdAt: now,
      updatedAt: now,
      finishedAt: allSkipped ? now : null,
    });
    await tx.insert(maintenanceRunResults).values(
      snapshot.repos.map((repo) => ({
        runId: id,
        repoOwner: repo.owner,
        repoName: repo.name,
        status: repo.automation.archived ? "skipped" : "pending",
        summary: repo.automation.archived ? "Archived repository, read only" : null,
        evidence: {},
      })),
    );
  });
  return getMaintenanceRun(userId, id);
}

export async function getMaintenanceRun(userId: string, runId: string) {
  const [run] = await db
    .select()
    .from(maintenanceRuns)
    .where(and(eq(maintenanceRuns.id, runId), eq(maintenanceRuns.userId, userId)))
    .limit(1);
  if (!run) return null;
  const results = await db
    .select()
    .from(maintenanceRunResults)
    .where(eq(maintenanceRunResults.runId, run.id))
    .orderBy(asc(maintenanceRunResults.repoOwner), asc(maintenanceRunResults.repoName));
  return {
    id: run.id,
    status: run.status,
    note: run.note,
    totalRepos: run.totalRepos,
    totalPrs: run.totalPrs,
    completedRepos: run.completedRepos,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
    snapshot: run.snapshot as StoredSnapshot,
    results: results.map((result) => ({
      repository: `${result.repoOwner}/${result.repoName}`,
      status: result.status as MaintenanceResultStatus,
      summary: result.summary,
      evidence: result.evidence as MaintenanceEvidence,
      updatedAt: result.updatedAt.toISOString(),
    })),
  };
}

const TERMINAL_RESULT_STATUSES: MaintenanceResultStatus[] = ["completed", "blocked", "skipped"];

export async function recordMaintenanceResult(
  userId: string,
  input: {
    runId: string;
    repository: string;
    status: Exclude<MaintenanceResultStatus, "pending">;
    summary: string;
    evidence?: MaintenanceEvidence;
  },
) {
  assertMutationsEnabled();
  const [owner, name, extra] = input.repository.split("/");
  if (!owner || !name || extra) throw new Error("repository must use owner/name format");
  const [run] = await db
    .select({ id: maintenanceRuns.id })
    .from(maintenanceRuns)
    .where(and(eq(maintenanceRuns.id, input.runId), eq(maintenanceRuns.userId, userId)))
    .limit(1);
  if (!run) throw new Error("Maintenance run not found");
  const candidates = await db
    .select({
      owner: maintenanceRunResults.repoOwner,
      name: maintenanceRunResults.repoName,
    })
    .from(maintenanceRunResults)
    .where(eq(maintenanceRunResults.runId, run.id));
  const repositoryKey = input.repository.toLowerCase();
  const target = candidates.find(
    (candidate) => `${candidate.owner}/${candidate.name}`.toLowerCase() === repositoryKey,
  );
  if (!target) throw new Error("Repository is not part of this maintenance run");
  const updated = await db
    .update(maintenanceRunResults)
    .set({
      status: input.status,
      summary: input.summary.trim(),
      evidence: input.evidence ?? {},
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(maintenanceRunResults.runId, run.id),
        eq(maintenanceRunResults.repoOwner, target.owner),
        eq(maintenanceRunResults.repoName, target.name),
      ),
    )
    .returning({ runId: maintenanceRunResults.runId });
  if (updated.length === 0) throw new Error("Repository result could not be updated");

  const results = await db
    .select({ status: maintenanceRunResults.status })
    .from(maintenanceRunResults)
    .where(eq(maintenanceRunResults.runId, run.id));
  const completedRepos = results.filter((result) =>
    TERMINAL_RESULT_STATUSES.includes(result.status as MaintenanceResultStatus),
  ).length;
  const allTerminal = completedRepos === results.length;
  const hasBlockers = results.some((result) => result.status === "blocked");
  const now = new Date();
  await db
    .update(maintenanceRuns)
    .set({
      completedRepos,
      status: allTerminal ? (hasBlockers ? "completed_with_blockers" : "completed") : "active",
      updatedAt: now,
      finishedAt: allTerminal ? now : null,
    })
    .where(eq(maintenanceRuns.id, run.id));
  return getMaintenanceRun(userId, run.id);
}
