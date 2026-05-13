import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "~/server/db";
import { orchestratorRunItems, orchestratorRuns } from "~/server/db/schema";
import {
  type ConfigSyncResult,
  createConfigSyncPr,
  GithubAuthError,
  GithubRateLimitError,
  getGithubTokenForUser,
} from "~/server/github";
import { log } from "~/server/logger";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type RunItemStatus =
  | "queued"
  | "syncing"
  | "synced"
  | "pr_open"
  | "no_change"
  | "failed"
  | "skipped";

const TICK_INTERVAL_MS = 5_000;
const MAX_ITEM_ATTEMPTS = 3;

const inFlightRuns = new Map<string, Promise<void>>();
let tickHandle: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

export type EnqueueRunInput = {
  userId: string;
  templateSnapshot: string;
  commitMessage: string;
  prTitle: string;
  prBody: string;
  repos: { owner: string; name: string }[];
};

export async function enqueueOrchestratorRun(input: EnqueueRunInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(orchestratorRuns).values({
      id,
      userId: input.userId,
      status: "queued",
      totalCount: input.repos.length,
      templateSnapshot: input.templateSnapshot,
      commitMessage: input.commitMessage,
      prTitle: input.prTitle,
      prBody: input.prBody,
      createdAt: now,
      updatedAt: now,
    });
    if (input.repos.length > 0) {
      await tx.insert(orchestratorRunItems).values(
        input.repos.map((r) => ({
          runId: id,
          repoOwner: r.owner,
          repoName: r.name,
          status: "queued" as RunItemStatus,
          attempts: 0,
          updatedAt: now,
        })),
      );
    }
  });
  log.info("orchestrator run enqueued", {
    runId: id,
    userId: input.userId,
    repos: input.repos.length,
  });
  setTimeout(() => {
    void tick();
  }, 50);
  return id;
}

export async function cancelOrchestratorRun(userId: string, runId: string): Promise<boolean> {
  const [run] = await db
    .select()
    .from(orchestratorRuns)
    .where(and(eq(orchestratorRuns.id, runId), eq(orchestratorRuns.userId, userId)))
    .limit(1);
  if (!run) return false;
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return false;
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(orchestratorRuns)
      .set({ status: "cancelled", updatedAt: now, finishedAt: now })
      .where(eq(orchestratorRuns.id, runId));
    await tx
      .update(orchestratorRunItems)
      .set({ status: "skipped", updatedAt: now })
      .where(and(eq(orchestratorRunItems.runId, runId), eq(orchestratorRunItems.status, "queued")));
  });
  return true;
}

export type RunItemView = {
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  status: RunItemStatus;
  prNumber: number | null;
  prUrl: string | null;
  branchName: string | null;
  attempts: number;
  error: string | null;
  updatedAt: string;
};

export type RunView = {
  id: string;
  status: RunStatus;
  totalCount: number;
  syncedCount: number;
  skippedCount: number;
  failedCount: number;
  error: string | null;
  commitMessage: string;
  prTitle: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  items: RunItemView[];
};

function toItemView(row: typeof orchestratorRunItems.$inferSelect): RunItemView {
  return {
    repoOwner: row.repoOwner,
    repoName: row.repoName,
    repoFullName: `${row.repoOwner}/${row.repoName}`,
    status: row.status as RunItemStatus,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    branchName: row.branchName,
    attempts: row.attempts,
    error: row.error,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toRunView(
  run: typeof orchestratorRuns.$inferSelect,
  items: (typeof orchestratorRunItems.$inferSelect)[],
): RunView {
  return {
    id: run.id,
    status: run.status as RunStatus,
    totalCount: run.totalCount,
    syncedCount: run.syncedCount,
    skippedCount: run.skippedCount,
    failedCount: run.failedCount,
    error: run.error,
    commitMessage: run.commitMessage,
    prTitle: run.prTitle,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt ? run.startedAt.toISOString() : null,
    finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    items: items.map(toItemView).sort((a, b) => a.repoFullName.localeCompare(b.repoFullName)),
  };
}

export async function listOrchestratorRuns(userId: string, limit = 20): Promise<RunView[]> {
  const runs = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.userId, userId))
    .orderBy(desc(orchestratorRuns.createdAt))
    .limit(limit);
  if (runs.length === 0) return [];
  const items = await db
    .select()
    .from(orchestratorRunItems)
    .where(
      inArray(
        orchestratorRunItems.runId,
        runs.map((r) => r.id),
      ),
    );
  const byRun = new Map<string, (typeof orchestratorRunItems.$inferSelect)[]>();
  for (const it of items) {
    const arr = byRun.get(it.runId) ?? [];
    arr.push(it);
    byRun.set(it.runId, arr);
  }
  return runs.map((r) => toRunView(r, byRun.get(r.id) ?? []));
}

export async function getOrchestratorRun(userId: string, runId: string): Promise<RunView | null> {
  const [run] = await db
    .select()
    .from(orchestratorRuns)
    .where(and(eq(orchestratorRuns.id, runId), eq(orchestratorRuns.userId, userId)))
    .limit(1);
  if (!run) return null;
  const items = await db
    .select()
    .from(orchestratorRunItems)
    .where(eq(orchestratorRunItems.runId, runId));
  return toRunView(run, items);
}

export function startOrchestratorWorker(): void {
  if (tickHandle) return;
  log.info("orchestrator worker started", { intervalMs: TICK_INTERVAL_MS });
  tickHandle = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  void tick();
}

export function stopOrchestratorWorker(): void {
  shuttingDown = true;
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
}

async function tick(): Promise<void> {
  if (shuttingDown) return;
  let active: { id: string }[];
  try {
    active = await db
      .select({ id: orchestratorRuns.id })
      .from(orchestratorRuns)
      .where(or(eq(orchestratorRuns.status, "queued"), eq(orchestratorRuns.status, "running")));
  } catch (err) {
    log.error("orchestrator tick: failed to list active runs", { err });
    return;
  }
  await Promise.all(
    active.map((r) => {
      const existing = inFlightRuns.get(r.id);
      if (existing) return existing;
      const p = processRun(r.id).finally(() => inFlightRuns.delete(r.id));
      inFlightRuns.set(r.id, p);
      return p;
    }),
  );
}

async function processRun(runId: string): Promise<void> {
  const [run] = await db
    .select()
    .from(orchestratorRuns)
    .where(eq(orchestratorRuns.id, runId))
    .limit(1);
  if (!run) return;
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;

  if (run.status === "queued") {
    await db
      .update(orchestratorRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(orchestratorRuns.id, runId));
  }

  let token: string;
  try {
    token = await getGithubTokenForUser(run.userId);
  } catch (err) {
    await finalizeRun(runId, "failed", err instanceof Error ? err.message : String(err));
    return;
  }

  const items = await db
    .select()
    .from(orchestratorRunItems)
    .where(eq(orchestratorRunItems.runId, runId))
    .orderBy(asc(orchestratorRunItems.repoOwner), asc(orchestratorRunItems.repoName));

  const pending = items.filter((i) => i.status === "queued");
  if (pending.length === 0) {
    await finalizeRun(runId, "completed");
    return;
  }

  // One repo per tick keeps throughput predictable and gives the throttling
  // plugin space to back off without spiking GitHub.
  const item = pending[0];
  if (!item) return;

  try {
    await markItem(runId, item.repoOwner, item.repoName, {
      status: "syncing",
      attempts: item.attempts + 1,
    });

    const outcome: ConfigSyncResult = await createConfigSyncPr(
      token,
      item.repoOwner,
      item.repoName,
      {
        desiredYaml: run.templateSnapshot,
        commitMessage: run.commitMessage,
        prTitle: run.prTitle,
        prBody: run.prBody,
        runId,
      },
    );

    if (outcome.kind === "synced") {
      await markItem(runId, item.repoOwner, item.repoName, {
        status: "synced",
        prNumber: outcome.prNumber,
        prUrl: outcome.prUrl,
        branchName: outcome.branchName,
        error: null,
      });
      await db
        .update(orchestratorRuns)
        .set({ syncedCount: run.syncedCount + 1, updatedAt: new Date() })
        .where(eq(orchestratorRuns.id, runId));
      return;
    }

    if (outcome.kind === "pr_open") {
      await markItem(runId, item.repoOwner, item.repoName, {
        status: "pr_open",
        prNumber: outcome.prNumber,
        prUrl: outcome.prUrl,
        branchName: outcome.branchName,
        error: null,
      });
      await db
        .update(orchestratorRuns)
        .set({ skippedCount: run.skippedCount + 1, updatedAt: new Date() })
        .where(eq(orchestratorRuns.id, runId));
      return;
    }

    // outcome.kind === "no_change"
    await markItem(runId, item.repoOwner, item.repoName, {
      status: "no_change",
      error: null,
    });
    await db
      .update(orchestratorRuns)
      .set({ skippedCount: run.skippedCount + 1, updatedAt: new Date() })
      .where(eq(orchestratorRuns.id, runId));
  } catch (err) {
    if (err instanceof GithubRateLimitError) {
      log.warn("orchestrator hit github rate limit, deferring", {
        runId,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      await markItem(runId, item.repoOwner, item.repoName, { status: "queued" });
      return;
    }
    if (err instanceof GithubAuthError) {
      await finalizeRun(runId, "failed", err.message);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = item.attempts + 1 >= MAX_ITEM_ATTEMPTS;
    log.error("orchestrator error while processing item", {
      runId,
      repo: `${item.repoOwner}/${item.repoName}`,
      message,
      giveUp,
    });
    await markItem(runId, item.repoOwner, item.repoName, {
      status: giveUp ? "failed" : "queued",
      error: message,
    });
    if (giveUp) {
      await db
        .update(orchestratorRuns)
        .set({ failedCount: run.failedCount + 1, updatedAt: new Date() })
        .where(eq(orchestratorRuns.id, runId));
    }
  }
}

async function markItem(
  runId: string,
  repoOwner: string,
  repoName: string,
  patch: Partial<{
    status: RunItemStatus;
    attempts: number;
    prNumber: number | null;
    prUrl: string | null;
    branchName: string | null;
    error: string | null;
  }>,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.attempts !== undefined) set.attempts = patch.attempts;
  if (patch.prNumber !== undefined) set.prNumber = patch.prNumber;
  if (patch.prUrl !== undefined) set.prUrl = patch.prUrl;
  if (patch.branchName !== undefined) set.branchName = patch.branchName;
  if (patch.error !== undefined) set.error = patch.error;
  await db
    .update(orchestratorRunItems)
    .set(set)
    .where(
      and(
        eq(orchestratorRunItems.runId, runId),
        eq(orchestratorRunItems.repoOwner, repoOwner),
        eq(orchestratorRunItems.repoName, repoName),
      ),
    );
}

async function finalizeRun(runId: string, status: RunStatus, error?: string): Promise<void> {
  const now = new Date();
  await db
    .update(orchestratorRuns)
    .set({
      status,
      updatedAt: now,
      finishedAt: now,
      error: error ?? null,
    })
    .where(eq(orchestratorRuns.id, runId));
  log.info("orchestrator run finalized", { runId, status, error });
}
