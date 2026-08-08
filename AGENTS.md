# Repository guidance

This is the canonical instruction file for this repository. Claude Code loads it through
`CLAUDE.md`.

## Start here

- Inspect branch, upstream divergence, status, and diff before editing.
- Preserve pre-existing changes and keep unrelated work out of the patch.
- Use the repository's existing runtime, package manager, framework, and deployment model.
- Do not refactor an existing project into the preferred new-project stack unless explicitly requested.
- Verify current documentation before changing version-dependent dependencies or hosting behavior.

## Project

DMO orchestrates Dependabot maintenance across GitHub repositories and records evidence for each run.

It uses Bun, TanStack Start, React, oRPC, better-auth, Drizzle, PostgreSQL, GitHub integrations, MCP, Docker, and Railway.

## Project rules

- Keep GitHub and Railway credentials server-side and never expose them through MCP.
- Mutating GitHub, deployment, or maintenance-run actions require explicit user authorization and an auditable path.
- MCP tools must reuse application business logic instead of adding direct database or provider writes.
- Preserve exact repository and pull-request scope in generated missions.
- A passing build is not deployment proof. Record terminal CI and deployment evidence separately.

## Commands

- `bun run typecheck`: TypeScript validation
- `bun run lint`: Biome validation
- `bun run test`: tests
- `bun run build`: production build

## Verification

Run the relevant checks and exercise the affected workflow, endpoint, or generated artifact.
State clearly when authenticated, database, deployment, or live verification was not possible.

## Maintaining instructions

Update `AGENTS.md` when verified, durable repository behavior changes. Keep it concise and
move detailed explanations into `docs/`. Keep `CLAUDE.md` as the compatibility import
unless Claude-specific guidance is genuinely required.
