import { ORPCError, os } from "@orpc/server";
import { eq } from "drizzle-orm";
import * as v from "valibot";
import { parse as parseYaml } from "yaml";
import { db } from "~/server/db";
import { dependabotTemplates, watchedRepos } from "~/server/db/schema";
import { invalidateDependenciesCache, listDependenciesOverview } from "~/server/dependencies";
import {
  type DependabotConfigFile,
  GithubAuthError,
  GithubRateLimitError,
  getDependabotConfig,
  getGithubTokenForUser,
  invalidateDependabotCache,
  listAccessibleRepos,
  listDependabotPrs,
} from "~/server/github";
import { cancelJob, enqueueJob, listActivePrKeysForUser, listJobsForUser } from "~/server/jobs";
import {
  assertAllowedUser,
  assertCanEnqueueJob,
  assertCanEnqueueRun,
  assertRateLimit,
} from "~/server/limits";
import { log } from "~/server/logger";
import {
  cancelOrchestratorRun,
  enqueueOrchestratorRun,
  getOrchestratorRun,
  listOrchestratorRuns,
} from "~/server/orchestrator";
import type { RpcContext } from "./context";

const base = os.$context<RpcContext>();

const authed = base.use(async ({ context, next }) => {
  if (!context.user) {
    throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
  }
  assertRateLimit(context.user.id);
  await assertAllowedUser(context.user.id);
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
        invalidateDependenciesCache(userId);
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

  dependencies: {
    overview: githubGuard.handler(async ({ context }) => {
      const watched = await getWatchedRepos(context.user.id);
      if (watched.length === 0) {
        return { repos: [], scannedAt: new Date().toISOString() };
      }
      const token = await getGithubTokenForUser(context.user.id);
      return listDependenciesOverview(context.user.id, token, watched);
    }),
  },

  orchestrator: {
    getTemplate: authed.handler(async ({ context }) => {
      const [row] = await db
        .select()
        .from(dependabotTemplates)
        .where(eq(dependabotTemplates.userId, context.user.id))
        .limit(1);
      return row ? { yamlContent: row.yamlContent, updatedAt: row.updatedAt.toISOString() } : null;
    }),

    saveTemplate: authed
      .input(
        v.object({
          yamlContent: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
        }),
      )
      .handler(async ({ context, input }) => {
        try {
          parseYaml(input.yamlContent);
        } catch (err) {
          throw new ORPCError("VALIDATION_FAILED", {
            message: err instanceof Error ? err.message : "Invalid YAML",
          });
        }
        const now = new Date();
        await db
          .insert(dependabotTemplates)
          .values({
            userId: context.user.id,
            yamlContent: input.yamlContent,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: dependabotTemplates.userId,
            set: { yamlContent: input.yamlContent, updatedAt: now },
          });
        return { updatedAt: now.toISOString() };
      }),

    getCurrent: githubGuard.handler(async ({ context }) => {
      const watched = await getWatchedRepos(context.user.id);
      if (watched.length === 0) return { repos: [] };
      const token = await getGithubTokenForUser(context.user.id);
      const concurrency = Math.min(6, watched.length);
      let cursor = 0;
      const results = new Array<{
        owner: string;
        name: string;
        config: { content: string; path: string } | null;
        error: string | null;
      }>(watched.length);
      let fatal: Error | null = null;

      async function worker() {
        while (cursor < watched.length && !fatal) {
          const i = cursor++;
          const repo = watched[i];
          if (!repo) continue;
          try {
            const config: DependabotConfigFile | null = await getDependabotConfig(
              token,
              repo.owner,
              repo.name,
            );
            results[i] = {
              owner: repo.owner,
              name: repo.name,
              config: config ? { content: config.content, path: config.path } : null,
              error: null,
            };
          } catch (err) {
            if (err instanceof GithubAuthError) {
              fatal = err;
              return;
            }
            // Rate limit on a single repo: record the error and keep scanning the
            // others. The orchestrator drift view is far more useful with partial
            // data than with nothing.
            results[i] = {
              owner: repo.owner,
              name: repo.name,
              config: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }

      await Promise.all(Array.from({ length: concurrency }, worker));
      if (fatal) throw fatal;
      return { repos: results.filter(Boolean) };
    }),

    startRun: githubGuard
      .input(
        v.object({
          repos: v.pipe(v.array(RepoRef), v.minLength(1), v.maxLength(50)),
          commitMessage: v.optional(
            v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
            "chore(deps): sync dependabot config",
          ),
          prTitle: v.optional(
            v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
            "chore(deps): sync dependabot config",
          ),
          prBody: v.optional(
            v.pipe(v.string(), v.maxLength(2_000)),
            "Synced via DMO orchestrator.",
          ),
        }),
      )
      .handler(async ({ context, input }) => {
        await assertCanEnqueueRun(context.user.id);
        const [template] = await db
          .select()
          .from(dependabotTemplates)
          .where(eq(dependabotTemplates.userId, context.user.id))
          .limit(1);
        if (!template) {
          throw new ORPCError("VALIDATION_FAILED", {
            message: "Save a template before starting a run",
          });
        }
        const watched = await getWatchedRepos(context.user.id);
        const watchedKeys = new Set(watched.map((r) => `${r.owner}/${r.name}`));
        const requested = input.repos.filter((r) => watchedKeys.has(`${r.owner}/${r.name}`));
        if (requested.length === 0) {
          throw new ORPCError("VALIDATION_FAILED", {
            message: "None of the selected repositories are in your watch list",
          });
        }
        const runId = await enqueueOrchestratorRun({
          userId: context.user.id,
          templateSnapshot: template.yamlContent,
          commitMessage: input.commitMessage,
          prTitle: input.prTitle,
          prBody: input.prBody,
          repos: requested,
        });
        return { runId, count: requested.length };
      }),

    listRuns: authed.handler(async ({ context }) => {
      return listOrchestratorRuns(context.user.id);
    }),

    getRun: authed
      .input(v.object({ runId: v.pipe(v.string(), v.minLength(1)) }))
      .handler(async ({ context, input }) => {
        const run = await getOrchestratorRun(context.user.id, input.runId);
        if (!run) throw new ORPCError("NOT_FOUND", { message: "Run not found" });
        return run;
      }),

    cancelRun: authed
      .input(v.object({ runId: v.pipe(v.string(), v.minLength(1)) }))
      .handler(async ({ context, input }) => {
        const ok = await cancelOrchestratorRun(context.user.id, input.runId);
        if (!ok) throw new ORPCError("NOT_FOUND", { message: "Run not found or already done" });
        return { ok: true };
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
        await assertCanEnqueueJob(context.user.id);
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
