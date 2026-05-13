# DMO

Dependabot Mass Orchestration. Log in with GitHub, see every open Dependabot PR across your
repositories on a single dashboard, then approve and merge them in bulk.

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

After the first deploy, run migrations once:

```bash
railway run bun run db:migrate
```

## Environment variables

See `.env.example`.

## Scripts

- `bun run dev` — start the dev server on port 3000
- `bun run build` — production build into `dist/`
- `bun run start` — run the built server
- `bun run db:generate` — generate a migration from schema changes
- `bun run db:migrate` — apply migrations
- `bun run lint` — Biome
- `bun run typecheck` — `tsc --noEmit`
- `bun test` — Vitest
