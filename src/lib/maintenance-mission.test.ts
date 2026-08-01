import { describe, expect, it } from "vitest";
import { buildMaintenanceMission } from "~/lib/maintenance-mission";
import type { DependenciesOverview } from "~/server/dependencies";
import type { DependabotPr } from "~/server/github";

const pr: DependabotPr = {
  id: 1,
  nodeId: "PR_1",
  number: 42,
  title: "Bump react from 19.0.0 to 20.0.0",
  htmlUrl: "https://github.com/acme/app/pull/42",
  createdAt: "2026-07-31T00:00:00Z",
  updatedAt: "2026-07-31T00:00:00Z",
  repoFullName: "acme/app",
  repoOwner: "acme",
  repoName: "app",
  ecosystem: "npm",
  updateType: "major",
  dependency: "react",
  fromVersion: "19.0.0",
  toVersion: "20.0.0",
  draft: false,
  labels: [],
};

const overview: DependenciesOverview = {
  scannedAt: "2026-07-31T00:00:00Z",
  repos: [
    {
      owner: "acme",
      name: "app",
      fullName: "acme/app",
      dependencies: [],
      error: null,
      scanned: { npm: true, docker: false, python: false },
      automation: {
        archived: false,
        defaultBranch: "main",
        packageManager: "bun",
        installCommand: "bun install --frozen-lockfile",
        verifyCommands: ["bun run verify"],
        deploymentProvider: "railway",
        healthcheckPath: "/api/health",
      },
    },
  ],
};

describe("buildMaintenanceMission", () => {
  it("includes PR inventory, execution contract, migration policy, and deployment proof", () => {
    const mission = buildMaintenanceMission([pr], overview);
    expect(mission).toContain("acme/app");
    expect(mission).toContain("#42 react: 19.0.0 -> 20.0.0");
    expect(mission).toContain("bun install --frozen-lockfile");
    expect(mission).toContain("railway, health /api/health");
    expect(mission).toContain("For every major, treat it as a migration");
    expect(mission).toContain("actual deployment");
  });
});
