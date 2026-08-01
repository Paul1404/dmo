import type { DependenciesOverview, RepoAutomationProfile } from "~/server/dependencies";
import type { DependabotPr } from "~/server/github";

function profileLine(profile: RepoAutomationProfile): string {
  const verify =
    profile.verifyCommands.length > 0
      ? profile.verifyCommands.join(" && ")
      : "discover from CI/repo docs";
  const deploy =
    profile.deploymentProvider === "unknown"
      ? "deployment unknown, discover before claiming success"
      : `${profile.deploymentProvider}${profile.healthcheckPath ? `, health ${profile.healthcheckPath}` : ""}`;
  return `state=${profile.archived ? "ARCHIVED READ ONLY" : "active"}; branch=${profile.defaultBranch}; package-manager=${profile.packageManager}; install=${profile.installCommand ?? "discover"}; verify=${verify}; deploy=${deploy}`;
}

export function buildMaintenanceMission(
  prs: DependabotPr[],
  overview: DependenciesOverview | null,
): string {
  const byRepo = new Map<string, DependabotPr[]>();
  for (const pr of prs) {
    const items = byRepo.get(pr.repoFullName) ?? [];
    items.push(pr);
    byRepo.set(pr.repoFullName, items);
  }
  const profiles = new Map((overview?.repos ?? []).map((repo) => [repo.fullName, repo.automation]));
  const inventory = Array.from(byRepo.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([repo, items]) => {
      const profile = profiles.get(repo);
      const lines = items
        .sort((a, b) => a.number - b.number)
        .map(
          (pr) =>
            `- #${pr.number} ${pr.dependency ?? pr.title}: ${pr.fromVersion ?? "?"} -> ${pr.toVersion ?? "?"} [${pr.ecosystem}, ${pr.updateType}] ${pr.htmlUrl}`,
        );
      return `### ${repo}\n${profile ? profileLine(profile) : "execution contract unavailable, discover it first"}\n${lines.join("\n")}`;
    });

  return `Complete this Dependabot fleet maintenance mission autonomously. Work through every listed PR and do not stop for routine decisions. Preserve unrelated work, inspect status/diff/divergence first, and never force-push or merge through failed checks.

DMO snapshot: ${new Date().toISOString()}; ${prs.length} PRs across ${byRepo.size} repositories.

${inventory.join("\n\n")}

## Operating contract

1. Establish the real latest stable version from the authoritative registry and read release notes for every minor or major jump. Dependabot's target is a floor, not necessarily the target.
2. Batch PRs that share a lockfile or coupled package family. Prefer one direct default-branch update when sibling Dependabot branches conflict, regenerate the lockfile once, and let superseded PRs close. Keep React/runtime types, TanStack, Drizzle, Vite/tooling, and similar lockstep families aligned.
3. For patches and compatible minors, update to real latest and run the repository's install and verification contract. For every major, treat it as a migration: inspect breaking changes, update code/config, add or adjust tests, then exercise the affected behavior. If blocked by a real compatibility boundary, pin or add the narrowest Dependabot ignore with a durable reason.
4. Push only verified changes. Observe CI to terminal state. Then verify the actual deployment for each deployed repo: terminal platform status, logs, configured health endpoint, public hostname/TLS, and live version or changed behavior. A build, local HTTP 200, or platform acknowledgement alone is not deployment proof. Retry transient Railway cold-start 502/503/504 separately from application failures.
5. Archived repositories are read-only. Do not unarchive them. Do not merge without saying so first unless this prompt is the user's explicit authorization to complete the listed maintenance mission.
6. Keep going across repositories when one is blocked. Finish with a compact ledger per repo: landed versions and commit/PR, migration or pin decisions, checks run, deployment evidence, and anything genuinely blocked. Re-scan the owner-scoped Dependabot queue at the end so nothing from this snapshot was silently missed.

Start now and carry the mission through implementation, push, CI, deployment verification, and final queue reconciliation.`;
}
