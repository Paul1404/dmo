import { ORPCError, os } from "@orpc/server";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { db } from "~/server/db";
import { watchedRepos } from "~/server/db/schema";
import {
  GithubAuthError,
  GithubRateLimitError,
  getGithubTokenForUser,
  invalidateDependabotCache,
  listAccessibleRepos,
  listDependabotPrs,
} from "~/server/github";
import { cancelJob, enqueueJob, listActivePrKeysForUser, listJobsForUser } from "~/server/jobs";
import { log } from "~/server/logger";
import type { RpcContext } from "./context";

const base = os.$context<RpcContext>();

const authed = base.use(async ({ context, next }) => {
  if (!context.user) {
    throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
  }
  return next({ context: { ...context, user: context.user } });
});

const githubGuard = authed.use(async ({ context, next, path }) => {
  try {
    return await next();
  } catch (err) {
    const procedure = Array.isArray(path) ? path.join(".") : String(path);
    const userId = context.user.id;
    if (err instanceof GithubRateLimitError) {
      log.warn("github rate limit surfaced to client", {
        procedure,
        userId,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      throw new ORPCError("TOO_MANY_REQUESTS", {
        message: `GitHub rate limit hit. Try again in ${err.retryAfterSeconds}s.`,
        data: { retryAfterSeconds: err.retryAfterSeconds },
      });
    }
    if (err instanceof GithubAuthError) {
      log.warn("github auth error surfaced to client", {
        procedure,
        userId,
        message: err.message,
      });
      throw new ORPCError("FORBIDDEN", { message: err.message });
    }
    log.error("github procedure failed", { procedure, userId, err });
    throw err;
  }
});

const MergeMethod = v.picklist(["merge", "squash", "rebase"]);

const EnqueuePr = v.object({
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
  title: v.pipe(v.string(), v.maxLength(500)),
  htmlUrl: v.pipe(v.string(), v.maxLength(500)),
});

const RepoRef = v.object({
  owner: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
});

async function getWatchedRepos(userId: string): Promise<{ owner: string; name: string }[]> {
  const rows = await db
    .select({ owner: watchedRepos.repoOwner, name: watchedRepos.repoName })
    .from(watchedRepos)
    .where(eq(watchedRepos.userId, userId));
  return rows;
}

export const router = {
  me: authed.handler(async ({ context }) => context.user),

  repos: {
    list: githubGuard.handler(async ({ context }) => {
      const token = await getGithubTokenForUser(context.user.id);
      return listAccessibleRepos(token);
    }),

    getWatched: authed.handler(async ({ context }) => {
      return getWatchedRepos(context.user.id);
    }),

    setWatched: authed
      .input(v.object({ repos: v.pipe(v.array(RepoRef), v.maxLength(500)) }))
      .handler(async ({ context, input }) => {
        const userId = context.user.id;
        await db.transaction(async (tx) => {
          await tx.delete(watchedRepos).where(eq(watchedRepos.userId, userId));
          if (input.repos.length > 0) {
            await tx
              .insert(watchedRepos)
              .values(
                input.repos.map((r) => ({
                  userId,
                  repoOwner: r.owner,
                  repoName: r.name,
                })),
              )
              .onConflictDoNothing();
          }
        });
        invalidateDependabotCache(userId);
        return { count: input.repos.length };
      }),
  },

  dependabot: {
    list: githubGuard.handler(async ({ context }) => {
      const watched = await getWatchedRepos(context.user.id);
      const token = await getGithubTokenForUser(context.user.id);
      const [prs, activeKeys] = await Promise.all([
        listDependabotPrs(context.user.id, token, watched),
        listActivePrKeysForUser(context.user.id),
      ]);
      return {
        prs,
        watchedCount: watched.length,
        activeKeys: Array.from(activeKeys),
      };
    }),
  },

  jobs: {
    list: authed.handler(async ({ context }) => {
      return listJobsForUser(context.user.id);
    }),

    enqueue: authed
      .input(
        v.object({
          repo: RepoRef,
          prs: v.pipe(v.array(EnqueuePr), v.minLength(1), v.maxLength(100)),
          mergeMethod: v.optional(MergeMethod, "squash"),
        }),
      )
      .handler(async ({ context, input }) => {
        const jobId = await enqueueJob({
          userId: context.user.id,
          repoOwner: input.repo.owner,
          repoName: input.repo.name,
          mergeMethod: input.mergeMethod,
          prs: input.prs,
        });
        return { jobId };
      }),

    cancel: authed
      .input(v.object({ jobId: v.pipe(v.string(), v.minLength(1)) }))
      .handler(async ({ context, input }) => {
        const ok = await cancelJob(context.user.id, input.jobId);
        if (!ok) throw new ORPCError("NOT_FOUND", { message: "Job not found or already done" });
        return { ok: true };
      }),
  },
};

export type Router = typeof router;
