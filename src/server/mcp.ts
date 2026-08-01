import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import * as z from "zod/v4";
import { authenticateAgentToken, readBearerToken } from "~/server/agent-access";
import { assertAllowedUser, assertRateLimit } from "~/server/limits";
import {
  createMaintenanceRun,
  getFleetSnapshot,
  getMaintenanceRun,
  getRepoMaintenanceContext,
  type MaintenanceEvidence,
  type MaintenanceResultStatus,
  recordMaintenanceResult,
} from "~/server/maintenance-runs";

export type DmoMcpServices = {
  getFleetSnapshot: typeof getFleetSnapshot;
  getRepoMaintenanceContext: typeof getRepoMaintenanceContext;
  createMaintenanceRun: typeof createMaintenanceRun;
  getMaintenanceRun: typeof getMaintenanceRun;
  recordMaintenanceResult: typeof recordMaintenanceResult;
};

const defaultServices: DmoMcpServices = {
  getFleetSnapshot,
  getRepoMaintenanceContext,
  createMaintenanceRun,
  getMaintenanceRun,
  recordMaintenanceResult,
};

const repositorySchema = z
  .string()
  .regex(/^[^/\s]+\/[^/\s]+$/, "Use owner/name format")
  .describe("GitHub repository in owner/name format");

const evidenceSchema = z.object({
  commitShas: z.array(z.string().max(100)).max(50).optional(),
  pullRequests: z.array(z.url()).max(50).optional(),
  checks: z
    .array(
      z.object({
        name: z.string().max(200),
        status: z.string().max(100),
        url: z.url().optional(),
      }),
    )
    .max(100)
    .optional(),
  deployment: z
    .object({
      provider: z.string().max(100).optional(),
      status: z.string().max(100),
      deploymentId: z.string().max(200).optional(),
      url: z.url().optional(),
      healthUrl: z.url().optional(),
      healthStatus: z.number().int().min(100).max(599).optional(),
      version: z.string().max(200).optional(),
    })
    .optional(),
  blockers: z.array(z.string().max(1_000)).max(50).optional(),
});

function toolResult(key: string, value: unknown, summary: string) {
  return {
    structuredContent: { [key]: value },
    content: [{ type: "text" as const, text: summary }],
  };
}

export function createDmoMcpServer(userId: string, services: DmoMcpServices = defaultServices) {
  const server = new McpServer(
    { name: "dmo", version: "0.2.0" },
    {
      instructions:
        "DMO is the source of truth for Dependabot fleet scope and evidence. Before dependency work call get_fleet_snapshot. Create a maintenance run only when the user asks to execute the work, then call get_repo_context before editing each repo and record_run_result after CI and live deployment verification. Never mutate archived repositories. Use native GitHub and deployment tools for external changes; DMO records scope and results.",
    },
  );

  server.registerTool(
    "get_fleet_snapshot",
    {
      title: "Get Dependabot fleet snapshot",
      description:
        "Get current open Dependabot PRs with repository execution contracts. Use first when planning or starting fleet dependency maintenance.",
      inputSchema: {
        repositories: z.array(repositorySchema).max(100).optional(),
      },
      outputSchema: { snapshot: z.unknown() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ repositories }) => {
      const snapshot = await services.getFleetSnapshot(userId, repositories);
      return toolResult(
        "snapshot",
        snapshot,
        `Found ${snapshot.totalPrs} open Dependabot PRs across ${snapshot.repos.length} repositories.`,
      );
    },
  );

  server.registerTool(
    "get_repo_context",
    {
      title: "Get repository maintenance context",
      description:
        "Get one watched repository's dependencies, Dependabot configuration, open PRs, package manager, verification commands, and deployment contract before making changes.",
      inputSchema: { repository: repositorySchema },
      outputSchema: { context: z.unknown() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ repository }) => {
      const context = await services.getRepoMaintenanceContext(userId, repository);
      return toolResult("context", context, `Loaded maintenance context for ${repository}.`);
    },
  );

  server.registerTool(
    "create_maintenance_run",
    {
      title: "Create an authorized maintenance run",
      description:
        "Freeze the current matching Dependabot fleet into an auditable run after the user has asked to execute dependency maintenance. This records scope but does not modify GitHub or deployments.",
      inputSchema: {
        repositories: z.array(repositorySchema).max(100).optional(),
        note: z.string().max(1_000).optional(),
      },
      outputSchema: { run: z.unknown() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ repositories, note }) => {
      const run = await services.createMaintenanceRun(userId, { repositories, note });
      return toolResult(
        "run",
        run,
        `Created maintenance run ${run?.id} for ${run?.totalPrs} PRs across ${run?.totalRepos} repositories.`,
      );
    },
  );

  server.registerTool(
    "get_maintenance_run",
    {
      title: "Get maintenance run",
      description:
        "Resume or inspect an existing DMO maintenance run, including frozen scope and per-repository evidence.",
      inputSchema: { runId: z.uuid() },
      outputSchema: { run: z.unknown().nullable() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ runId }) => {
      const run = await services.getMaintenanceRun(userId, runId);
      return toolResult(
        "run",
        run,
        run
          ? `Maintenance run ${runId} is ${run.status}.`
          : `Maintenance run ${runId} was not found.`,
      );
    },
  );

  server.registerTool(
    "record_run_result",
    {
      title: "Record repository maintenance evidence",
      description:
        "Record the outcome and verification evidence for one repository in an authorized maintenance run. This updates only DMO's audit ledger.",
      inputSchema: {
        runId: z.uuid(),
        repository: repositorySchema,
        status: z.enum(["in_progress", "completed", "blocked", "skipped"]),
        summary: z.string().min(1).max(4_000),
        evidence: evidenceSchema.optional(),
      },
      outputSchema: { run: z.unknown().nullable() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ runId, repository, status, summary, evidence }) => {
      const run = await services.recordMaintenanceResult(userId, {
        runId,
        repository,
        status: status as Exclude<MaintenanceResultStatus, "pending">,
        summary,
        evidence: evidence as MaintenanceEvidence | undefined,
      });
      return toolResult(
        "run",
        run,
        `Recorded ${status} result for ${repository} in maintenance run ${runId}.`,
      );
    },
  );

  return server;
}

export async function handleAuthenticatedMcpRequest(
  request: Request,
  userId: string,
  services: DmoMcpServices = defaultServices,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  const server = createDmoMcpServer(userId, services);
  await server.connect(transport);
  return transport.handleRequest(request);
}

export async function handleMcpRequest(request: Request): Promise<Response> {
  const token = readBearerToken(request);
  if (!token) return unauthorized();
  const identity = await authenticateAgentToken(token);
  if (!identity) return unauthorized();
  assertRateLimit(identity.userId);
  await assertAllowedUser(identity.userId);
  return handleAuthenticatedMcpRequest(request, identity.userId);
}

function unauthorized(): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Invalid or expired DMO agent token" },
      id: null,
    },
    {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="dmo-mcp"' },
    },
  );
}
