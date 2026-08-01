import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashAgentToken, readBearerToken } from "~/server/agent-access";
import {
  createDmoMcpServer,
  type DmoMcpServices,
  handleAuthenticatedMcpRequest,
} from "~/server/mcp";

const snapshot = {
  scannedAt: "2026-08-01T00:00:00.000Z",
  watchedCount: 2,
  totalPrs: 1,
  repos: [
    {
      fullName: "acme/app",
      owner: "acme",
      name: "app",
      automation: {
        archived: false,
        defaultBranch: "main",
        packageManager: "bun",
        installCommand: "bun install --frozen-lockfile",
        verifyCommands: ["bun run test"],
        deploymentProvider: "railway",
        healthcheckPath: "/api/health",
      },
      dependencyCount: 20,
      prs: [],
    },
  ],
} as const;

function fakeServices(): DmoMcpServices {
  return {
    getFleetSnapshot: vi.fn(async () => snapshot) as never,
    getRepoMaintenanceContext: vi.fn(async () => ({ repository: "acme/app" })) as never,
    createMaintenanceRun: vi.fn(async () => ({
      id: "58ea72ee-9093-46de-8d43-6e35e7e89921",
      totalPrs: 1,
      totalRepos: 1,
    })) as never,
    getMaintenanceRun: vi.fn(async () => null) as never,
    recordMaintenanceResult: vi.fn(async () => ({
      id: "58ea72ee-9093-46de-8d43-6e35e7e89921",
    })) as never,
  };
}

describe("agent bearer tokens", () => {
  it("accepts only the DMO bearer token format", () => {
    const valid = new Request("https://dmo.example/mcp", {
      headers: { authorization: "Bearer dmo_mcp_secret" },
    });
    const invalid = new Request("https://dmo.example/mcp", {
      headers: { authorization: "Basic dmo_mcp_secret" },
    });
    expect(readBearerToken(valid)).toBe("dmo_mcp_secret");
    expect(readBearerToken(invalid)).toBeNull();
  });

  it("hashes tokens deterministically without retaining plaintext", () => {
    const hash = hashAgentToken("dmo_mcp_secret");
    expect(hash).toBe(hashAgentToken("dmo_mcp_secret"));
    expect(hash).not.toContain("secret");
    expect(hash).toHaveLength(64);
  });
});

describe("DMO MCP server", () => {
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients.length = 0;
  });

  it("initializes over Web Standard Streamable HTTP", async () => {
    const request = new Request("https://dmo.example/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "dmo-test", version: "1.0.0" },
        },
      }),
    });
    const response = await handleAuthenticatedMcpRequest(request, "user-1", fakeServices());
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { serverInfo?: { name?: string } } };
    expect(payload.result?.serverInfo?.name).toBe("dmo");
  });

  it("advertises focused tools and returns structured fleet data", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createDmoMcpServer("user-1", fakeServices());
    await server.connect(serverTransport);
    const client = new Client({ name: "dmo-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(clientTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "get_fleet_snapshot",
      "get_repo_context",
      "create_maintenance_run",
      "get_maintenance_run",
      "record_run_result",
    ]);
    expect(
      listed.tools.find((tool) => tool.name === "get_fleet_snapshot")?.annotations,
    ).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
    });
    expect(
      listed.tools.find((tool) => tool.name === "record_run_result")?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });

    const result = await client.callTool({
      name: "get_fleet_snapshot",
      arguments: { pullRequests: ["acme/app#42"] },
    });
    expect(result.structuredContent).toEqual({ snapshot });
  });

  it("accepts exact pull-request scope for maintenance runs", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const services = fakeServices();
    const server = createDmoMcpServer("user-1", services);
    await server.connect(serverTransport);
    const client = new Client({ name: "dmo-test", version: "1.0.0" });
    clients.push(client);
    await client.connect(clientTransport);

    await client.callTool({
      name: "create_maintenance_run",
      arguments: { pullRequests: ["acme/app#42"], note: "single PR trial" },
    });
    expect(services.createMaintenanceRun).toHaveBeenCalledWith("user-1", {
      repositories: undefined,
      pullRequests: ["acme/app#42"],
      note: "single PR trial",
    });
  });
});
