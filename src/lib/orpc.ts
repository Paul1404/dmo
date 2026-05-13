import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import type { Router } from "~/server/orpc/router";

const getHeaders = createIsomorphicFn()
  .server(() => Object.fromEntries(Object.entries(getRequestHeaders())))
  .client((): Record<string, string> => ({}));

const getBaseUrl = createIsomorphicFn()
  .server(() => `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/api/rpc`)
  .client(() => `${window.location.origin}/api/rpc`);

const link = new RPCLink({
  url: () => getBaseUrl(),
  headers: () => getHeaders(),
});

export const orpc: RouterClient<Router> = createORPCClient(link);
export const orpcQuery = createTanstackQueryUtils(orpc);
