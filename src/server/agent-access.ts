import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { db } from "~/server/db";
import { agentTokens } from "~/server/db/schema";

const TOKEN_PREFIX = "dmo_mcp_";
const TOKEN_LIFETIME_MS = 180 * 24 * 60 * 60_000;
const MAX_ACTIVE_TOKENS = 10;

export type AgentTokenView = {
  id: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readBearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim() ?? "";
  if (!token.startsWith(TOKEN_PREFIX) || token.length > 256) return null;
  return token;
}

export async function authenticateAgentToken(token: string): Promise<{
  userId: string;
  tokenId: string;
  tokenName: string;
} | null> {
  const now = new Date();
  const [row] = await db
    .select({
      id: agentTokens.id,
      userId: agentTokens.userId,
      name: agentTokens.name,
    })
    .from(agentTokens)
    .where(
      and(
        eq(agentTokens.tokenHash, hashAgentToken(token)),
        isNull(agentTokens.revokedAt),
        gt(agentTokens.expiresAt, now),
      ),
    )
    .limit(1);
  if (!row) return null;
  await db.update(agentTokens).set({ lastUsedAt: now }).where(eq(agentTokens.id, row.id));
  return { userId: row.userId, tokenId: row.id, tokenName: row.name };
}

export async function createAgentToken(
  userId: string,
  name: string,
): Promise<AgentTokenView & { token: string }> {
  const now = new Date();
  const active = await db
    .select({ id: agentTokens.id })
    .from(agentTokens)
    .where(
      and(
        eq(agentTokens.userId, userId),
        isNull(agentTokens.revokedAt),
        gt(agentTokens.expiresAt, now),
      ),
    );
  if (active.length >= MAX_ACTIVE_TOKENS) {
    throw new Error(`Revoke an existing agent token first (limit: ${MAX_ACTIVE_TOKENS})`);
  }

  const token = `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const row = {
    id: crypto.randomUUID(),
    userId,
    name: name.trim(),
    tokenHash: hashAgentToken(token),
    createdAt: now,
    expiresAt: new Date(now.getTime() + TOKEN_LIFETIME_MS),
  };
  await db.insert(agentTokens).values(row);
  return {
    id: row.id,
    name: row.name,
    token,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: null,
  };
}

export async function listAgentTokens(userId: string): Promise<AgentTokenView[]> {
  const rows = await db
    .select()
    .from(agentTokens)
    .where(
      and(
        eq(agentTokens.userId, userId),
        isNull(agentTokens.revokedAt),
        gt(agentTokens.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(agentTokens.createdAt));
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  }));
}

export async function revokeAgentToken(userId: string, tokenId: string): Promise<boolean> {
  const rows = await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(agentTokens.id, tokenId),
        eq(agentTokens.userId, userId),
        isNull(agentTokens.revokedAt),
      ),
    )
    .returning({ id: agentTokens.id });
  return rows.length > 0;
}
