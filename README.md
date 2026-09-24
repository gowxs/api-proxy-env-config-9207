# Noctiv

Multi-tenant "AI employee" for small businesses: reads a business mailbox, drafts
grounded replies from the tenant's knowledge base, gets owner approval via Telegram,
and follows up. See [PLAN.md](PLAN.md) for architecture, data model and build order.

**Status:** Phase 1 in progress — steps 1 (scaffold), 2 (schema + RLS), 3 (core safety logic), 4 (LLM providers), 5 (knowledge base), 6 (mailbox connections), 7 (IMAP ingest), 8 (processing pipeline), 9 (sending), 10 (owner email notifications), 11 (follow-ups) and 12 (web app) done.

## Repository layout

| Path                  | What                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`            | Fastify HTTP API (wizard, approvals, Telegram webhook)                                       |
| `apps/worker`         | IMAP listeners, job consumers, crons — the only process that can decrypt mailbox credentials |
| `apps/web`            | Next.js + Tailwind dashboard                                                                 |
| `packages/core`       | Pure domain logic, env loading, redacting logger                                             |
| `packages/llm`        | Gemini providers (AI Studio free tier for tests, Vertex AI EU for production), fake provider |
| `packages/kb`         | Knowledge base: file/website/note ingestion, SSRF-safe crawler, hybrid retrieval             |
| `packages/db`         | Postgres client, migration runner, `withTenant` helper                                       |
| `supabase/migrations` | SQL schema — source of truth (Supabase CLI compatible)                                       |
| `docker/`             | Local services (Supabase Postgres, GreenMail)                                                |

TypeScript runs directly on Node 22 (native type stripping) — there is no build step
for `api`, `worker` or the packages. Only `web` is built (`next build`).

## Prerequisites

- Node.js ≥ 22.18 (`.nvmrc`), pnpm 10 (`corepack enable`)
- Docker (local database, GreenMail, DB tests)

## Try it locally (one command)

```bash
corepack enable && pnpm install
pnpm dev:stack            # Docker: Postgres + GreenMail; then API, worker and web
```

Open http://localhost:3000 and choose **Sign in as the demo owner**. The demo
business has sample conversations: a draft to approve, a refund escalation, an
unverified suggestion, an answered thread and an ignored newsletter.

- From a phone on the same Wi-Fi, open `http://<computer's IP>:3000` (the address is printed at start).
- `pnpm dev:stack --empty` starts at the onboarding wizard instead.
- `pnpm dev:mail "Subject" "Text"` sends a customer email into the demo mailbox (`shop@demo.test`); the worker picks it up.
  With the default fake model it ends up handed to you. `pnpm dev:stack --gemini` uses the real model (free tier; only this
  test mailbox is processed).
- Owner notification emails go to GreenMail (IMAP `localhost:3143`, user `owner@noctiv.local`, any password).
- Ports taken? `GREENMAIL_SMTP_PORT=4025 GREENMAIL_IMAP_PORT=4143 pnpm dev:stack`.
- The dev login exists only in this local setup; the API refuses it when `NODE_ENV=production`.

## Local setup (manual)

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm services:up        # Supabase Postgres :54322, GreenMail :3025/:3143
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
| `pnpm check`                                         | Everything CI runs except DB tests: format, lint, typecheck, unit tests (stops at the first failure)                     |
| `pnpm test`                                          | Unit tests (no Docker needed)                                                                                            |
| `pnpm test:db`                                       | Database tests incl. tenant isolation. Starts a throwaway `supabase/postgres` container, or uses `TEST_DATABASE_URL`     |
| `pnpm lint` / `pnpm typecheck` / `pnpm format:check` | Static checks (also run in CI)                                                                                           |
| `pnpm test:live`                                     | Opt-in: runs the attack fixtures through the real model (needs `GEMINI_API_KEY` or GCP credentials; synthetic data only) |
| `pnpm db:migrate`                                    | Apply pending migrations to `MIGRATION_DATABASE_URL`                                                                     |

## Environment variables

See [.env.example](.env.example) for the full, commented list. Current ones:

| Variable                                           | Used by        | Purpose                                                               |
| -------------------------------------------------- | -------------- | --------------------------------------------------------------------- |
| `NODE_ENV`, `LOG_LEVEL`                            | all            | runtime mode, pino log level                                          |
| `MIGRATION_DATABASE_URL`                           | migrate script | schema owner (`postgres`) — CI/deploy only, never given to api/worker |
| `API_HOST`, `API_PORT`                             | api            | listen address                                                        |
| `API_DATABASE_URL`                                 | api            | connects as `noctiv_api` (RLS enforced)                               |
| `WORKER_DATABASE_URL`                              | worker         | connects as `noctiv_worker` (RLS enforced)                            |
| `TEST_DATABASE_URL`                                | tests          | optional; disposable DB instead of a container                        |
| `SYSTEM_SMTP_*`, `SYSTEM_MAIL_FROM`, `ADMIN_EMAIL` | worker         | system mailer for owner/admin notifications (Brevo in production)     |
| `ACTION_LINK_SECRET`                               | api + worker   | signs Approve / Reject links (same value in both)                     |
| `PUBLIC_API_URL`, `PUBLIC_APP_URL`                 | worker, api    | base URLs used in notification links                                  |

Secrets are never committed. Configuration errors name the variable but never print its value.

## Web app (step 12)

Next.js (App Router) + Tailwind, English, mobile first. The browser talks only to its own
origin; `/api/*` is forwarded to the API (`API_INTERNAL_URL`). Sign-in is Supabase Auth
(email + password or a magic link; `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`). The API verifies the token and membership on
every request; the browser never reads the database directly.

- **Onboarding:** business + time zone (+ invite code) → mailbox (provider, App Password
  guide with screenshot placeholders, live test with the exact error) → knowledge (website,
  files, notes) → summary. Every business starts in draft-only mode.
- **Dashboard:** mailbox health, today's counts in the tenant's time zone, AI budget, open items.
- **Inbox:** "Needs you" / all; a conversation shows messages, reasons, and drafts to approve, edit or reject. Escalations are marked done.
- **Leads:** stage filter, stage changes (recorded), name and notes.
- **Knowledge base:** add, re-read, delete sources; status per source.
- **Settings:** automatic sending only after an explicit confirmation (and with a connected
  mailbox); follow-ups, limits, signature, privacy (full text in emails), retention.
  Mailboxes: reconnect a disconnected one with a new App Password (history is kept).
- Links in owner emails (`/drafts/:id`, `/escalations/:id`, `/settings/mailboxes`) open the right screen.

## Owner notifications (step 10)

Drafts, escalations, disconnected mailboxes, failed sends and budget stops are emailed
to the tenant owner's login address by the system mailer, never through the tenant's
own mailbox. Admin alerts go to `ADMIN_EMAIL`. Emails are in privacy mode unless the
tenant enables full text (`tenants.notify_full_text`). Privacy mode shows the sender
domain, subject, summary and reasons, but no draft body or customer name. Links
inside customer-derived text are removed. Every notification email carries
`Auto-Submitted: auto-generated`.

Draft emails carry **Approve** and **Reject** links, signed with HMAC and valid for
7 days (`/actions/<token>` on the API). Opening a link only shows a confirmation page;
the button (POST) acts, so link-scanning mail filters cannot approve anything. A draft
is decided once; later clicks show what happened. Editing is dashboard-only. Tokens
are redacted from request logs. Notifications go through a `NotificationChannel`
interface (email today). Delivery retries with backoff (1, 2, 4… minutes) and gives up
after 5 attempts.

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

**Free-tier limits:** 20 generate requests per day per model, and frequent 503s. `pnpm test:live`
spaces calls (`LIVE_CALL_GAP_MS`) and can resume from chosen cases (`LIVE_ONLY=A15-…,A19-…`).

To check a configured provider live (models served, embedding size, JSON output), run
`pnpm --filter @noctiv/llm check-models`.

## Knowledge base (`packages/kb`)

| Source                         | How it is read                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File (PDF, DOCX, TXT; ≤ 10 MB) | Type detected from the bytes, not the name. The upload waits in `kb_uploads` until its text is extracted, then it is **deleted**. Original files are never kept (founder decision). |
| Website                        | Same-site crawl: robots.txt respected, ≤ 50 pages, depth ≤ 3, 1 request/s, HTML only. Scripts, navigation, forms and CSS-hidden text are dropped.                                   |
| Note                           | Text stored on the source row (`kb_sources.note_text`).                                                                                                                             |

Then:

1. **Chunking.** About 500 tokens per chunk with overlap. Heading paths are repeated in each chunk.
2. **Embedding.** 768 dimensions, with the model recorded per chunk.
3. **Allowlist.** Links and addresses found in the knowledge base become the reply allowlist.
4. **Replace.** A source's old chunks are swapped for the new ones in one transaction. Unchanged content isn't re-embedded.

Retrieval combines vector search with keyword search (Reciprocal Rank Fusion).
Both are scoped to the tenant and to the current embedding model.

**Crawler network safety (SSRF).** Tenants choose the website URL, so the crawler must not become a way into our own network:

- only http/https on default ports, with no credentials in the URL;
- every connection's resolved IP must be public (checked at connect time, so DNS rebinding doesn't help);
- redirects are re-checked, and response size and time are capped.

**Free tier:** with a provider that may train on data, a tenant's knowledge base
is processed only if **all** its mailboxes are test mailboxes.

To ingest one source by hand (until step 7 adds the job queue):
`node --env-file=.env apps/worker/scripts/ingest-source.ts <tenant_id> <source_id>`.

## Mail flow (steps 6–9)

1. **Connect (API → worker).** The wizard's password is sealed at once with the worker's
   public key. A `connection.test` job logs in to IMAP and SMTP, then the tested
   mailbox is saved. Only the worker can open the password.
2. **Ingest (worker).** One IDLE listener per mailbox, plus a 3-minute poll, triggers
   `mail.fetch`. The INBOX is opened read-only; mail from before connecting is never
   processed. Each message is stored with its thread and its `mail.process` job in one
   transaction. A duplicate Message-ID is ignored.
3. **Process (worker).** Loop filter, lead, budget, classify, hard-list escalation,
   retrieval, reply, safety checks, fact-check (auto-send candidates only), then a
   draft, an approved reply or an escalation. The owner's email notification is queued
   in privacy mode.
4. **Send (worker, `mail.send`).** The draft is locked. Auto-sends re-check the tenant
   mode and rate caps; if either now fails, the reply goes back to the owner for
   approval. The outbound email is recorded with its Message-ID before the SMTP send,
   so a double approval or a repeated job can't send twice. Replies carry
   `In-Reply-To`/`References` and the tenant signature. Only auto-sends carry
   `Auto-Submitted: auto-replied`. After sending: the message is appended to Sent
   (unless Gmail saves it itself), the thread waits for the customer with the next
   follow-up time (Mon–Fri, 09:00–17:00 tenant time), and the lead moves to `sent`.
   If a worker crashed mid-send, the retry looks for the Message-ID in Sent; if that
   proves nothing, it never resends and the owner is told instead.
5. **Follow up (worker, every 15 min).** Threads where the customer has not answered
   get up to `followup_max` short check-ins, N business days apart, sent only
   Mon–Fri 09:00–17:00 tenant time. They pass the same checks as replies; anything
   doubtful becomes a draft or stops the follow-ups. A customer reply stops them.

Run a real mailbox check in development with `MAIL_ALLOW_INSECURE=false`; GreenMail needs `true`.
Hand-picked real-model pipeline run: `LIVE_PIPELINE=1 pnpm test:live apps/worker` (free-tier quota applies).
