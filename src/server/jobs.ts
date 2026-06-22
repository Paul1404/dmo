import { and, asc, desc, eq, inArray, or } from "drizzle-orm";
import { db } from "~/server/db";
import { mergeJobItems, mergeJobs } from "~/server/db/schema";
import {
  approveAndMergePr,
  GithubAuthError,
  GithubRateLimitError,
  getGithubTokenForUser,
  invalidateDependabotCache,
  probePrReadiness,
} from "~/server/github";
import { publishUserEvent } from "~/server/live";
import { log } from "~/server/logger";

export type MergeMethod = "merge" | "squash" | "rebase";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type ItemStatus = "queued" | "merging" | "waiting_rebase" | "merged" | "failed" | "skipped";

const TICK_INTERVAL_MS = 5_000;
const WAITING_TIMEOUT_MS = 15 * 60_000;

const inFlightJobs = new Map<string, Promise<void>>();
let tickHandle: ReturnType<typeof setInterval> | null = null;
let shuttingDown = false;

export type EnqueueInput = {
  userId: string;
  repoOwner: string;
  repoName: string;
  mergeMethod: MergeMethod;
  prs: { number: number; title: string; htmlUrl: string }[];
};

export async function enqueueJob(input: EnqueueInput): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(mergeJobs).values({
      id,
      userId: input.userId,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      mergeMethod: input.mergeMethod,
      status: "queued",
      totalCount: input.prs.length,
      createdAt: now,
      updatedAt: now,
    });
    if (input.prs.length > 0) {
      await tx.insert(mergeJobItems).values(
        input.prs.map((pr) => ({
          jobId: id,
          prNumber: pr.number,
          title: pr.title,
          htmlUrl: pr.htmlUrl,
          status: "queued" as ItemStatus,
          attempts: 0,
          updatedAt: now,
        })),
      );
    }
  });
  log.info("merge job enqueued", {
    jobId: id,
    userId: input.userId,
    repo: `${input.repoOwner}/${input.repoName}`,
    prs: input.prs.length,
  });
  publishUserEvent(input.userId, "jobs");
  setTimeout(() => {
    void tick();
  }, 50);
  return id;
}

export async function cancelJob(userId: string, jobId: string): Promise<boolean> {
  const [job] = await db
    .select()
    .from(mergeJobs)
    .where(and(eq(mergeJobs.id, jobId), eq(mergeJobs.userId, userId)))
    .limit(1);
  if (!job) return false;
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return false;
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(mergeJobs)
      .set({ status: "cancelled", updatedAt: now, finishedAt: now })
      .where(eq(mergeJobs.id, jobId));
    await tx
      .update(mergeJobItems)
      .set({ status: "skipped", updatedAt: now })
      .where(
        and(
          eq(mergeJobItems.jobId, jobId),
          inArray(mergeJobItems.status, ["queued", "waiting_rebase"]),
        ),
      );
  });
  publishUserEvent(userId, "jobs");
  return true;
}

export type JobView = {
  id: string;
  repoOwner: string;
  repoName: string;
  repoFullName: string;
  mergeMethod: MergeMethod;
  status: JobStatus;
  totalCount: number;
  mergedCount: number;
  failedCount: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  items: JobItemView[];
};

export type JobItemView = {
  prNumber: number;
  title: string;
  htmlUrl: string;
  status: ItemStatus;
  attempts: number;
  error: string | null;
  updatedAt: string;
};

export async function listJobsForUser(userId: string, limit = 50): Promise<JobView[]> {
  // Query newest first so we always show recent activity, then return ascending so
  // consumers that rely on chronological order (e.g. slice(-3) for the latest few) keep working.
  const recent = await db
    .select()
    .from(mergeJobs)
    .where(eq(mergeJobs.userId, userId))
    .orderBy(desc(mergeJobs.createdAt))
    .limit(limit);
  if (recent.length === 0) return [];
  const jobs = recent.slice().reverse();
  const items = await db
    .select()
    .from(mergeJobItems)
    .where(
      inArray(
        mergeJobItems.jobId,
        jobs.map((j) => j.id),
      ),
    );
  const byJob = new Map<string, JobItemView[]>();
  for (const it of items) {
    const arr = byJob.get(it.jobId) ?? [];
    arr.push({
      prNumber: it.prNumber,
      title: it.title,
      htmlUrl: it.htmlUrl,
      status: it.status as ItemStatus,
      attempts: it.attempts,
      error: it.error,
      updatedAt: it.updatedAt.toISOString(),
    });
    byJob.set(it.jobId, arr);
  }
  return jobs.map((j) => ({
    id: j.id,
    repoOwner: j.repoOwner,
    repoName: j.repoName,
    repoFullName: `${j.repoOwner}/${j.repoName}`,
    mergeMethod: j.mergeMethod as MergeMethod,
    status: j.status as JobStatus,
    totalCount: j.totalCount,
    mergedCount: j.mergedCount,
    failedCount: j.failedCount,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    startedAt: j.startedAt ? j.startedAt.toISOString() : null,
    finishedAt: j.finishedAt ? j.finishedAt.toISOString() : null,
    items: (byJob.get(j.id) ?? []).sort((a, b) => a.prNumber - b.prNumber),
  }));
}

export async function listActivePrKeysForUser(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({
      repoOwner: mergeJobs.repoOwner,
      repoName: mergeJobs.repoName,
      prNumber: mergeJobItems.prNumber,
      itemStatus: mergeJobItems.status,
    })
    .from(mergeJobItems)
    .innerJoin(mergeJobs, eq(mergeJobItems.jobId, mergeJobs.id))
    .where(
      and(
        eq(mergeJobs.userId, userId),
        inArray(mergeJobs.status, ["queued", "running"]),
        inArray(mergeJobItems.status, ["queued", "merging", "waiting_rebase"]),
      ),
    );
  return new Set(rows.map((r) => `${r.repoOwner}/${r.repoName}#${r.prNumber}`));
}

export function startWorker(): void {
  if (tickHandle) return;
  log.info("merge job worker started", { intervalMs: TICK_INTERVAL_MS });
  tickHandle = setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
  void tick();
}

export function stopWorker(): void {
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
      .select({ id: mergeJobs.id })
      .from(mergeJobs)
      .where(or(eq(mergeJobs.status, "queued"), eq(mergeJobs.status, "running")));
  } catch (err) {
    log.error("worker tick: failed to list active jobs", { err });
    return;
  }
  await Promise.all(
    active.map((j) => {
      const existing = inFlightJobs.get(j.id);
      if (existing) return existing;
      const p = processJob(j.id)
        .catch((err) => {
          log.error("processJob threw uncaught error", { jobId: j.id, err });
        })
        .finally(async () => {
          await notifyJobChanged(j.id);
          inFlightJobs.delete(j.id);
        });
      inFlightJobs.set(j.id, p);
      return p;
    }),
  );
}

async function processJob(jobId: string): Promise<void> {
  const [job] = await db.select().from(mergeJobs).where(eq(mergeJobs.id, jobId)).limit(1);
  if (!job) return;
  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") return;

  if (job.status === "queued") {
    await db
      .update(mergeJobs)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(mergeJobs.id, jobId));
    publishUserEvent(job.userId, "jobs");
  }

  let token: string;
  try {
    token = await getGithubTokenForUser(job.userId);
  } catch (err) {
    await finalizeJob(jobId, "failed", err instanceof Error ? err.message : String(err));
    return;
  }

  const items = await db
    .select()
    .from(mergeJobItems)
    .where(eq(mergeJobItems.jobId, jobId))
    .orderBy(asc(mergeJobItems.prNumber));

  const pending = items.filter((i) => i.status === "queued" || i.status === "waiting_rebase");
  if (pending.length === 0) {
    const failed = items.filter((i) => i.status === "failed").length;
    const finalStatus: JobStatus = failed === items.length ? "failed" : "completed";
    await finalizeJob(jobId, finalStatus);
    invalidateDependabotCache(job.userId);
    return;
  }

  // Sequential within the repo. Take one item per tick to keep the loop responsive
  // and to give Dependabot time to react between attempts.
  const item = pending[0];
  if (!item) return;

  try {
    const readiness = await probePrReadiness(token, job.repoOwner, job.repoName, item.prNumber);

    if (readiness.kind === "closed") {
      await markItem(jobId, item.prNumber, {
        status: readiness.merged ? "merged" : "skipped",
        error: readiness.merged ? null : "PR was closed without merging",
      });
      if (readiness.merged) {
        await db
          .update(mergeJobs)
          .set({ mergedCount: job.mergedCount + 1, updatedAt: new Date() })
          .where(eq(mergeJobs.id, jobId));
      }
      return;
    }

    if (readiness.kind === "draft") {
      await markItem(jobId, item.prNumber, {
        status: "failed",
        error: "PR is a draft",
      });
      await db
        .update(mergeJobs)
        .set({ failedCount: job.failedCount + 1, updatedAt: new Date() })
        .where(eq(mergeJobs.id, jobId));
      return;
    }

    if (readiness.kind === "blocked") {
      await markItem(jobId, item.prNumber, {
        status: "failed",
        error: readiness.reason,
      });
      await db
        .update(mergeJobs)
        .set({ failedCount: job.failedCount + 1, updatedAt: new Date() })
        .where(eq(mergeJobs.id, jobId));
      return;
    }

    if (readiness.kind === "computing") {
      // GitHub still resolving mergeability. Try again next tick.
      await touchItem(jobId, item.prNumber);
      return;
    }

    if (readiness.kind === "conflict") {
      const waitingSince = item.waitingSince ?? new Date();
      const waitedFor = Date.now() - waitingSince.getTime();
      if (waitedFor > WAITING_TIMEOUT_MS) {
        await markItem(jobId, item.prNumber, {
          status: "failed",
          error: "Timed out waiting for Dependabot to resolve conflicts",
        });
        await db
          .update(mergeJobs)
          .set({ failedCount: job.failedCount + 1, updatedAt: new Date() })
          .where(eq(mergeJobs.id, jobId));
        return;
      }
      await markItem(jobId, item.prNumber, {
        status: "waiting_rebase",
        waitingSince,
      });
      return;
    }

    // readiness.kind === "ready"
    await markItem(jobId, item.prNumber, {
      status: "merging",
      attempts: item.attempts + 1,
    });
    const outcome = await approveAndMergePr(
      token,
      job.repoOwner,
      job.repoName,
      item.prNumber,
      job.mergeMethod as MergeMethod,
    );

    if (outcome.kind === "merged") {
      await markItem(jobId, item.prNumber, { status: "merged", error: null });
      await db
        .update(mergeJobs)
        .set({ mergedCount: job.mergedCount + 1, updatedAt: new Date() })
        .where(eq(mergeJobs.id, jobId));
      invalidateDependabotCache(job.userId);
      return;
    }

    if (outcome.kind === "not_mergeable") {
      await markItem(jobId, item.prNumber, {
        status: "waiting_rebase",
        waitingSince: item.waitingSince ?? new Date(),
      });
      return;
    }

    // outcome.kind === "blocked"
    await markItem(jobId, item.prNumber, {
      status: "failed",
      error: outcome.reason,
    });
    await db
      .update(mergeJobs)
      .set({ failedCount: job.failedCount + 1, updatedAt: new Date() })
      .where(eq(mergeJobs.id, jobId));
  } catch (err) {
    if (err instanceof GithubRateLimitError) {
      log.warn("worker hit github rate limit, deferring", {
        jobId,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      await touchItem(jobId, item.prNumber);
      return;
    }
    if (err instanceof GithubAuthError) {
      await finalizeJob(jobId, "failed", err.message);
      return;
    }
    log.error("worker error while processing item", {
      jobId,
      prNumber: item.prNumber,
      err,
    });
    await markItem(jobId, item.prNumber, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      attempts: item.attempts + 1,
    });
    await db
      .update(mergeJobs)
      .set({ failedCount: job.failedCount + 1, updatedAt: new Date() })
      .where(eq(mergeJobs.id, jobId));
  }
}

async function markItem(
  jobId: string,
  prNumber: number,
  patch: Partial<{
    status: ItemStatus;
    error: string | null;
    attempts: number;
    waitingSince: Date | null;
  }>,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.error !== undefined) set.error = patch.error;
  if (patch.attempts !== undefined) set.attempts = patch.attempts;
  if (patch.waitingSince !== undefined) set.waitingSince = patch.waitingSince;
  await db
    .update(mergeJobItems)
    .set(set)
    .where(and(eq(mergeJobItems.jobId, jobId), eq(mergeJobItems.prNumber, prNumber)));
  await notifyJobChanged(jobId);
}

async function touchItem(jobId: string, prNumber: number): Promise<void> {
  await db
    .update(mergeJobItems)
    .set({ updatedAt: new Date() })
    .where(and(eq(mergeJobItems.jobId, jobId), eq(mergeJobItems.prNumber, prNumber)));
  await notifyJobChanged(jobId);
}

async function finalizeJob(jobId: string, status: JobStatus, error?: string): Promise<void> {
  const now = new Date();
  await db
    .update(mergeJobs)
    .set({
      status,
      updatedAt: now,
      finishedAt: now,
      error: error ?? null,
    })
    .where(eq(mergeJobs.id, jobId));
  log.info("merge job finalized", { jobId, status, error });
  await notifyJobChanged(jobId);
}

async function notifyJobChanged(jobId: string): Promise<void> {
  const [job] = await db
    .select({ userId: mergeJobs.userId })
    .from(mergeJobs)
    .where(eq(mergeJobs.id, jobId))
    .limit(1);
  if (job) publishUserEvent(job.userId, "jobs");
}
