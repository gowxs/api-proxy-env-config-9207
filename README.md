# Noctiv

Multi-tenant "AI employee" for small businesses: reads a business mailbox, drafts
grounded replies from the tenant's knowledge base, gets owner approval via Telegram,
and follows up. See [PLAN.md](PLAN.md) for architecture, data model and build order.

**Status:** Phase 1 in progress — steps 1 (scaffold), 2 (schema + RLS), 3 (core safety logic) and 4 (LLM providers) done.

## Repository layout

| Path                  | What                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`            | Fastify HTTP API (wizard, approvals, Telegram webhook)                                       |
| `apps/worker`         | IMAP listeners, job consumers, crons — the only process that can decrypt mailbox credentials |
| `apps/web`            | Next.js + Tailwind dashboard                                                                 |
| `packages/core`       | Pure domain logic, env loading, redacting logger                                             |
| `packages/llm`        | Gemini providers (AI Studio free tier for tests, Vertex AI EU for production), fake provider |
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

| Command                                              | Does                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm test`                                          | Unit tests (no Docker needed)                                                                                            |
| `pnpm test:db`                                       | Database tests incl. tenant isolation. Starts a throwaway `supabase/postgres` container, or uses `TEST_DATABASE_URL`     |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Static checks (also run in CI)                                                                                           |
| `pnpm test:live`                                     | Opt-in: runs the attack fixtures through the real model (needs `GEMINI_API_KEY` or GCP credentials; synthetic data only) |
| `pnpm db:migrate`                                    | Apply pending migrations to `MIGRATION_DATABASE_URL`                                                                     |

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
- Mailbox credentials: the dashboard and the API role cannot select
  `credentials_ciphertext`; only the worker can.
- Details: PLAN.md §3; schema notes in PLAN.md §11.

## Tenant isolation tests

`packages/db/test/tenant-isolation.db.test.ts` reads the list of tables from the
catalog and, for every table, checks that tenant A can't see or change tenant B's
rows as a dashboard user, as `noctiv_api` or as `noctiv_worker`, and that queries
without tenant context return nothing. It also covers knowledge-base search
(vector and full text), composite foreign keys, credential column privileges,
anonymous access and the duplicate-message constraints. A new table without
`tenant_id`, forced RLS or both policies fails the suite automatically.

## Core safety logic (`packages/core`)

Pure functions with no I/O. The pipeline in step 8 calls them in this order:

| Module                     | Job                                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `mail/loop-filter.ts`      | Never-reply rules: auto-reply/bulk/list headers, bounces, noreply-style senders, our own address                                            |
| `llm/schemas.ts`           | Strict zod schemas for the classifier and reply JSON; invalid output never throws                                                           |
| `prompt/build.ts`          | Prompts with the email and knowledge base in delimited blocks marked by a random nonce; `S1…Sn` source labels                               |
| `safety/injection.ts`      | Heuristic injection signals (EN/DE/NL/FR/ES/LV); any signal blocks auto-send                                                                |
| `safety/sanitize-reply.ts` | Removes links and addresses that aren't in the knowledge base, plus invisible characters                                                    |
| `claims/*`                 | Detects prices, percentages, durations, dates, times, weekdays and commitment wording in 6 languages; checks each against the cited sources |
| `policy/decide.ts`         | Final action: escalate > draft > auto_send                                                                                                  |
| `guard/guard-reply.ts`     | Runs all of the above on one model output; builds the recipient and threading headers from the original email only                          |
| `crypto/sealed-box.ts`     | X25519 + HKDF + AES-256-GCM credential sealing bound to tenant and connection                                                               |

Generate the credential key pair with
`node packages/core/scripts/generate-sealing-keys.ts secrets/sealing-private.key`.

Attack-email fixtures live in `packages/core/test/fixtures/attack-emails.ts`. The
suite in `test/injection-resistance.test.ts` runs each one as if the model obeyed
the attacker completely.

## LLM providers (`packages/llm`)

Both providers implement the same `LlmProvider` / `EmbeddingProvider` interfaces
(`packages/core/src/llm/types.ts`) on Google's `@google/genai` SDK.

| Provider                 | When                                                    | Data                                                     | Mailboxes processed    |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------------------- | ---------------------- |
| `VertexGeminiProvider`   | `GCP_PROJECT_ID` + `GOOGLE_APPLICATION_CREDENTIALS` set | Paid tier, `europe-west4` regional endpoint, no training | all                    |
| `GoogleAiStudioProvider` | only `GEMINI_API_KEY` set                               | **Free tier: Google may train on it**                    | only `is_test_mailbox` |
| `FakeProvider`           | `LLM_PROVIDER=fake` (never in production)               | stays local                                              | all                    |

Default models: `gemini-3.8-flash` (replies), `gemini-3.5-flash-lite`
(classification) and `gemini-embedding-001` at 768 dimensions. The same names
are used on both providers, so stored embeddings stay comparable.
`kb_chunks.embedding_model` records which model produced each vector.

**Test mailboxes.** Two independent locks keep customer data away from the free tier:

1. At startup the worker only takes on mailboxes flagged `is_test_mailbox`.
2. Every model call declares its data origin (`test_mailbox`, `test_fixture` or
   `customer_data`). The free-tier provider rejects `customer_data` before any
   network request.

Only the operator can set the flag, as the schema owner:

```sql
update public.email_connections set is_test_mailbox = true where email_address = 'test@example.com';
```

The API, the worker and tenants can't set or change it; a trigger blocks them.

To check a configured provider live (models served, embedding size, JSON output), run
`pnpm --filter @noctiv/llm check-models`.
