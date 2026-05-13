import { ORPCError, os } from "@orpc/server";
import * as v from "valibot";
import {
  approveAndMergePr,
  getGithubTokenForUser,
  listAccessibleRepos,
  listDependabotPrs,
} from "~/server/github";
import type { RpcContext } from "./context";

const base = os.$context<RpcContext>();

const authed = base.use(async ({ context, next }) => {
  if (!context.user) {
    throw new ORPCError("UNAUTHORIZED", { message: "Sign in required" });
  }
  return next({ context: { ...context, user: context.user } });
});

const MergeMethod = v.picklist(["merge", "squash", "rebase"]);

const PrRef = v.object({
  owner: v.pipe(v.string(), v.minLength(1)),
  repo: v.pipe(v.string(), v.minLength(1)),
  number: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const router = {
  me: authed.handler(async ({ context }) => context.user),

  repos: {
    list: authed.handler(async ({ context }) => {
      const token = await getGithubTokenForUser(context.user.id);
      return listAccessibleRepos(token);
    }),
  },

  dependabot: {
    list: authed.handler(async ({ context }) => {
      const token = await getGithubTokenForUser(context.user.id);
      return listDependabotPrs(token);
    }),

    approveAndMerge: authed
      .input(
        v.object({
          prs: v.pipe(v.array(PrRef), v.minLength(1), v.maxLength(100)),
          mergeMethod: v.optional(MergeMethod, "squash"),
        }),
      )
      .handler(async ({ context, input }) => {
        const token = await getGithubTokenForUser(context.user.id);
        const results = [];
        for (const pr of input.prs) {
          const r = await approveAndMergePr(token, pr.owner, pr.repo, pr.number, input.mergeMethod);
          results.push(r);
        }
        return {
          total: results.length,
          merged: results.filter((r) => r.merged).length,
          failed: results.filter((r) => !r.ok).length,
          results,
        };
      }),
  },
};

export type Router = typeof router;
