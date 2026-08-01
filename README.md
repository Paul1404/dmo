# DMO

Dependabot Mass Orchestration. Log in with GitHub, see every open Dependabot PR across your
repositories on a single dashboard, merge low-risk updates in bulk, or copy one autonomous Codex
mission for a full fleet maintenance pass.

The Codex mission scans each repository first and includes its package manager, frozen install
command, available verification scripts, default branch, archived state, deployment provider, and
configured Railway health path. The generated handoff tells the agent to coordinate shared
lockfiles, treat majors as migrations, pin only at real compatibility boundaries, watch CI and the
deployment to terminal state, and reconcile the Dependabot queue when finished.

## Codex MCP integration

DMO exposes an authenticated Streamable HTTP MCP server at `/mcp`. It gives Codex live fleet
context and an auditable maintenance ledger without exposing the GitHub OAuth token or duplicating
GitHub and Railway write operations.

Available tools:

- `get_fleet_snapshot`: current Dependabot PRs and repository execution contracts
- `get_repo_context`: dependencies, Dependabot config, verification commands, and deployment context
- `create_maintenance_run`: freeze the authorized PR scope in DMO
- `get_maintenance_run`: resume a run and inspect its evidence ledger
- `record_run_result`: record repository outcomes, checks, commits, deployments, and blockers

Create a token under **Repos → Codex agent access**. DMO shows the plaintext token once and stores
only its SHA-256 hash. Then configure Codex with the deployed DMO URL and an environment variable:

```toml
[mcp_servers.dmo]
url = "https://your-dmo.example/mcp"
bearer_token_env_var = "DMO_MCP_TOKEN"
default_tools_approval_mode = "writes"
tool_timeout_sec = 120
```

Restart Codex after changing MCP configuration. Inventory tools are marked read-only. Creating a
run and recording evidence are auditable DMO writes, but neither changes a repository or deployment.

## Stack

- TanStack Start (Vite) + TanStack Router + TanStack Query
- oRPC for type-safe RPC
- better-auth with GitHub OAuth
- Drizzle ORM + Postgres for the auth tables (sessions, accounts)
- Tailwind v4 + shadcn-style primitives + lucide icons
- Deployed on Railway via Dockerfile

PR data is not persisted. Everything comes live from the GitHub REST API using the user's session
access token.

## Run locally

```bash
bun install
cp .env.example .env
# fill in DATABASE_URL, BETTER_AUTH_SECRET, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET
bun run db:generate
bun run db:migrate
bun run dev
```

Open http://localhost:3000.

### GitHub OAuth app

Create one at https://github.com/settings/developers with:

- Homepage URL: `http://localhost:3000`
- Authorization callback URL: `http://localhost:3000/api/auth/callback/github`

The app requests `read:user`, `user:email`, and `repo` scopes. `repo` is required so DMO can
approve and merge pull requests on behalf of the signed-in user.

## Deploy

Railway picks up the `Dockerfile` automatically. The healthcheck path
`/api/health` is configured via `railway.toml`. Wire a Postgres service and reference its
`DATABASE_URL` from the app service. Set `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` (the deployed
URL), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` in the service variables.

Migrations run automatically before each deploy via `preDeployCommand` in `railway.toml`.

## Environment variables

See `.env.example`.

## Scripts

- `bun run dev`: start the dev server on port 3000
- `bun run build`: production build into `dist/`
- `bun run start`: run the built server
- `bun run db:generate`: generate a migration from schema changes
- `bun run db:migrate`: apply migrations
- `bun run lint`: Biome
- `bun run typecheck`: `tsc --noEmit`
- `bun run test`: Vitest
