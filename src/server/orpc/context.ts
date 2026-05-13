import { auth } from "~/server/auth";

export type RpcContext = {
  request: Request;
  user: { id: string; email: string; name: string } | null;
  sessionId: string | null;
};

export async function createRpcContext(request: Request): Promise<RpcContext> {
  const session = await auth.api.getSession({ headers: request.headers });
  return {
    request,
    user: session?.user
      ? {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
        }
      : null,
    sessionId: session?.session?.id ?? null,
  };
}
