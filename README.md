# Noctiv

Multi-tenant "AI employee" for small businesses: reads a business mailbox, drafts
grounded replies from the tenant's knowledge base, gets owner approval via Telegram,
and follows up. See [PLAN.md](PLAN.md) for architecture, data model and build order.

**Status:** Phase 1 in progress — step 1 (scaffold) done.

## Repository layout

| Path                  | What                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`            | Fastify HTTP API (wizard, approvals, Telegram webhook)                                       |
| `apps/worker`         | IMAP listeners, job consumers, crons — the only process that can decrypt mailbox credentials |
| `apps/web`            | Next.js + Tailwind dashboard                                                                 |
| `packages/core`       | Pure domain logic, env loading, redacting logger                                             |
| `packages/db`         | Postgres client, migration runner, `withTenant` helper                                       |
| `supabase/migrations` | SQL schema — source of truth (Supabase CLI compatible)                                       |
| `docker/`             | Local services (Supabase Postgres, GreenMail)                                                |

TypeScript runs directly on Node 22 (native type stripping) — there is no build step
for `api`, `worker` or the packages. Only `web` is built (`next build`).

## Prerequisites

- Node.js ≥ 22.18 (`.nvmrc`), pnpm 10 (`corepack enable`)
- Docker (local database, GreenMail, DB tests)

## Local setup

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm services:up        # Supabase Postgres on :54322, GreenMail on :3025/:3143
pnpm db:migrate         # applies supabase/migrations as the schema owner
# give the runtime roles a local password (matches .env.example):
psql postgres://postgres:postgres@localhost:54322/postgres \
  -c "alter role noctiv_api with login password 'change-me'" \
  -c "alter role noctiv_worker with login password 'change-me'"
pnpm dev:api            # http://localhost:4000/healthz
pnpm dev:worker
pnpm dev:web            # http://localhost:3000
```

## Commands

| Command                                              | Does                                                                                                                 |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `pnpm test`                                          | Unit tests (no Docker needed)                                                                                        |
| `pnpm test:db`                                       | Database tests incl. tenant isolation. Starts a throwaway `supabase/postgres` container, or uses `TEST_DATABASE_URL` |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Static checks (also run in CI)                                                                                       |
| `pnpm db:migrate`                                    | Apply pending migrations to `MIGRATION_DATABASE_URL`                                                                 |

## Environment variables

See [.env.example](.env.example) for the full, commented list. Current ones:

| Variable                 | Used by        | Purpose                                                               |
| ------------------------ | -------------- | --------------------------------------------------------------------- |
| `NODE_ENV`, `LOG_LEVEL`  | all            | runtime mode, pino log level                                          |
| `MIGRATION_DATABASE_URL` | migrate script | schema owner (`postgres`) — CI/deploy only, never given to api/worker |
| `API_HOST`, `API_PORT`   | api            | listen address                                                        |
| `API_DATABASE_URL`       | api            | connects as `noctiv_api` (RLS enforced)                               |
| `WORKER_DATABASE_URL`    | worker         | connects as `noctiv_worker` (RLS enforced)                            |
| `TEST_DATABASE_URL`      | tests          | optional; disposable DB instead of a container                        |

Secrets are never committed. Configuration errors name the variable but never print its value.

## Database access model (short version)

- Runtime processes never use the Supabase service role. They connect as
  `noctiv_api` / `noctiv_worker`, which are subject to Row Level Security.
- All tenant work runs in `withTenant(sql, tenantId, fn)`, which sets
  `app.tenant_id` for that transaction only. Without it, queries see zero rows.
- Dashboard users go through Supabase Auth + RLS (membership in `tenant_members`).
- Details: PLAN.md §3.
