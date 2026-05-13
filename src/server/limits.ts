import { ORPCError } from "@orpc/server";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "~/server/db";
import { mergeJobs, orchestratorRuns } from "~/server/db/schema";
import { getGithubLoginForUser } from "~/server/github";
import { log } from "~/server/logger";

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBool(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  return raw === "1" || raw.toLowerCase() === "true";
}

function readList(name: string): string[] {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export const limits = {
  reqPerMin: readInt("RATE_LIMIT_REQUESTS_PER_MIN", 240),
  reqPerHour: readInt("RATE_LIMIT_REQUESTS_PER_HOUR", 4000),
  maxActiveRunsPerUser: readInt("LIMIT_ACTIVE_RUNS_PER_USER", 5),
  maxActiveJobsPerUser: readInt("LIMIT_ACTIVE_JOBS_PER_USER", 5),
  maxDailyRunsPerUser: readInt("LIMIT_DAILY_RUNS_PER_USER", 50),
  maxDailyJobsPerUser: readInt("LIMIT_DAILY_JOBS_PER_USER", 100),
  historyRetentionDays: readInt("HISTORY_RETENTION_DAYS", 30),
  historyMaxPerUser: readInt("HISTORY_MAX_PER_USER", 100),
  mutationsDisabled: readBool("DISABLE_MUTATIONS"),
  allowedLogins: readList("ALLOWED_GITHUB_LOGINS"),
};

type Bucket = {
  minuteCount: number;
  minuteStart: number;
  hourCount: number;
  hourStart: number;
};

const buckets = new Map<string, Bucket>();

export function checkRateLimit(
  userId: string,
): { allowed: true } | { allowed: false; retryAfter: number; window: "minute" | "hour" } {
  const now = Date.now();
  let bucket = buckets.get(userId);
  if (!bucket) {
    bucket = { minuteCount: 0, minuteStart: now, hourCount: 0, hourStart: now };
    buckets.set(userId, bucket);
  }
  if (now - bucket.minuteStart > 60_000) {
    bucket.minuteCount = 0;
    bucket.minuteStart = now;
  }
  if (now - bucket.hourStart > 3_600_000) {
    bucket.hourCount = 0;
    bucket.hourStart = now;
  }
  if (bucket.minuteCount >= limits.reqPerMin) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((bucket.minuteStart + 60_000 - now) / 1000)),
      window: "minute",
    };
  }
  if (bucket.hourCount >= limits.reqPerHour) {
    return {
      allowed: false,
      retryAfter: Math.max(1, Math.ceil((bucket.hourStart + 3_600_000 - now) / 1000)),
      window: "hour",
    };
  }
  bucket.minuteCount++;
  bucket.hourCount++;
  return { allowed: true };
}

export function assertRateLimit(userId: string): void {
  const result = checkRateLimit(userId);
  if (result.allowed) return;
  throw new ORPCError("TOO_MANY_REQUESTS", {
    message: `Rate limit exceeded (per-${result.window}). Try again in ${result.retryAfter}s.`,
    data: { retryAfterSeconds: result.retryAfter },
  });
}

// Evict idle buckets so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.hourStart > 3_600_000 && now - b.minuteStart > 60_000) {
      buckets.delete(k);
    }
  }
}, 5 * 60_000);

const allowlistCache = new Map<string, { login: string; allowed: boolean }>();

export async function assertAllowedUser(userId: string): Promise<void> {
  if (limits.allowedLogins.length === 0) return;
  let entry = allowlistCache.get(userId);
  if (!entry) {
    let login: string;
    try {
      login = (await getGithubLoginForUser(userId)).toLowerCase();
    } catch (err) {
      log.warn("allowlist check failed to fetch github login", { userId, err });
      throw new ORPCError("FORBIDDEN", {
        message: "Unable to verify GitHub identity. Please sign in again.",
      });
    }
    entry = { login, allowed: limits.allowedLogins.includes(login) };
    allowlistCache.set(userId, entry);
  }
  if (!entry.allowed) {
    throw new ORPCError("FORBIDDEN", {
      message: "Access restricted. Contact the administrator to be added to the allowlist.",
    });
  }
}

export function assertMutationsEnabled(): void {
  if (limits.mutationsDisabled) {
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "The administrator has temporarily disabled write actions.",
    });
  }
}

export async function assertCanEnqueueRun(userId: string): Promise<void> {
  assertMutationsEnabled();
  const [activeRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(orchestratorRuns)
    .where(
      and(
        eq(orchestratorRuns.userId, userId),
        inArray(orchestratorRuns.status, ["queued", "running"]),
      ),
    );
  const active = activeRow?.c ?? 0;
  if (active >= limits.maxActiveRunsPerUser) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: `You already have ${active} active sync runs. Wait for one to finish (limit: ${limits.maxActiveRunsPerUser}).`,
    });
  }
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [dailyRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(orchestratorRuns)
    .where(and(eq(orchestratorRuns.userId, userId), gte(orchestratorRuns.createdAt, since)));
  const daily = dailyRow?.c ?? 0;
  if (daily >= limits.maxDailyRunsPerUser) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: `Daily sync run limit reached (${limits.maxDailyRunsPerUser} per 24h). Try again later.`,
    });
  }
}

export async function assertCanEnqueueJob(userId: string): Promise<void> {
  assertMutationsEnabled();
  const [activeRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(mergeJobs)
    .where(and(eq(mergeJobs.userId, userId), inArray(mergeJobs.status, ["queued", "running"])));
  const active = activeRow?.c ?? 0;
  if (active >= limits.maxActiveJobsPerUser) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: `You already have ${active} active merge jobs. Wait for one to finish (limit: ${limits.maxActiveJobsPerUser}).`,
    });
  }
  const since = new Date(Date.now() - 24 * 60 * 60_000);
  const [dailyRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(mergeJobs)
    .where(and(eq(mergeJobs.userId, userId), gte(mergeJobs.createdAt, since)));
  const daily = dailyRow?.c ?? 0;
  if (daily >= limits.maxDailyJobsPerUser) {
    throw new ORPCError("TOO_MANY_REQUESTS", {
      message: `Daily merge job limit reached (${limits.maxDailyJobsPerUser} per 24h). Try again later.`,
    });
  }
}

let cleanupHandle: ReturnType<typeof setInterval> | null = null;
const CLEANUP_INTERVAL_MS = 60 * 60_000;

export function startCleanupWorker(): void {
  if (cleanupHandle) return;
  log.info("history cleanup worker started", {
    retentionDays: limits.historyRetentionDays,
    maxPerUser: limits.historyMaxPerUser,
  });
  cleanupHandle = setInterval(() => {
    void runCleanup();
  }, CLEANUP_INTERVAL_MS);
  setTimeout(() => {
    void runCleanup();
  }, 30_000);
}

export function stopCleanupWorker(): void {
  if (cleanupHandle) {
    clearInterval(cleanupHandle);
    cleanupHandle = null;
  }
}

async function runCleanup(): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - limits.historyRetentionDays * 24 * 60 * 60_000);
    await db.execute(sql`
      DELETE FROM orchestrator_runs
      WHERE status IN ('completed','failed','cancelled')
        AND created_at < ${cutoff}
    `);
    await db.execute(sql`
      DELETE FROM merge_jobs
      WHERE status IN ('completed','failed','cancelled')
        AND created_at < ${cutoff}
    `);
    await db.execute(sql`
      DELETE FROM orchestrator_runs
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
          FROM orchestrator_runs
          WHERE status IN ('completed','failed','cancelled')
        ) ranked
        WHERE rn > ${limits.historyMaxPerUser}
      )
    `);
    await db.execute(sql`
      DELETE FROM merge_jobs
      WHERE id IN (
        SELECT id FROM (
          SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
          FROM merge_jobs
          WHERE status IN ('completed','failed','cancelled')
        ) ranked
        WHERE rn > ${limits.historyMaxPerUser}
      )
    `);
    log.info("history cleanup pass complete");
  } catch (err) {
    log.error("history cleanup failed", { err });
  }
}
