# Data flow and retention (GDPR)

Noctiv is a **processor** for its tenants (the businesses). Their customers' emails are
personal data. This page lists what is stored, where, for how long, and who can see it.
Subprocessors: [../subprocessors.md](../subprocessors.md).

## Temporary test deployment (2026-09-24)

The founder's phone-review deployment differs from the target described below:

- **api + worker: Northflank, London (UK, outside the EU).** Northflank's EU regions have no free tier.
  The UK has an EU adequacy decision, but our rule is EU-only, so this is a recorded, temporary exception.
- **web: Cloudflare Workers** (global network, app.noctiv.io). It serves the pages and proxies `/api` requests to the api.
- **database: Supabase Frankfurt**, unchanged: data at rest stays in the EU.
- Both processes warn at every start while `DATA_REGION_IN_EU=false`; the worker also emails the admin.
- Only operator-flagged test mailboxes are processed; the free AI tier refuses all other mail.
- Owner notification emails and Supabase Auth emails go out through Brevo SMTP (sender noreply@noctiv.io).

Move api + worker to an EU region before any real customer mailbox is connected.

## Flow

```
Customer ──email──▶ Tenant's mailbox (Gmail / Yahoo / …)
                         │  IMAP, read-only (nothing marked read)
                         ▼
                    Worker (Hetzner, EU) ──▶ Postgres (Supabase, Frankfurt)
                         │                     messages, threads, leads, drafts …
                         │  prompt: email text + knowledge-base excerpts
                         ▼
                    LLM (Vertex AI, europe-west4, no training)
                         │  JSON only; code decides what happens
                         ▼
          draft ──▶ owner notification (Brevo, FR; privacy mode) ──▶ owner approves
          auto-send (only if every check passes) ──SMTP──▶ Customer
```

- The browser talks only to the Noctiv API (same origin); the API checks sign-in and
  tenant membership on every request, and every query runs inside the tenant's row-level
  security context.
- Mailbox App Passwords are sealed with the worker's public key (X25519 + AES-256-GCM);
  only the worker can decrypt them, in memory, for IMAP/SMTP sessions. Never logged,
  never returned by the API.
- Uploaded files are read once and deleted; only the extracted text is kept.

## What is stored

| Data                                                         | Where                                                   | Kept                                                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Email text, subject, sender name (inbound and outbound)      | `messages`                                              | `retention_days` (default 90), then removed                                          |
| Model classification and output (summaries, reply text)      | `message_processing`                                    | removed with the email text                                                          |
| Draft text                                                   | `drafts`                                                | `retention_days`, then removed                                                       |
| Escalation summaries                                         | `escalations`                                           | `retention_days`, then removed                                                       |
| Notification contents (subject, summary)                     | `notifications`                                         | deleted once delivered, after ≤ 30 days                                              |
| Message-IDs, addresses, statuses, timestamps, token counts   | `messages`, `threads`, `outbound_emails`, `usage_daily` | until the tenant is deleted (needed for deduplication, threading, leads and billing) |
| Leads (customer email, name, stage, owner notes)             | `leads`, `lead_events`                                  | until the owner changes them or the tenant is deleted                                |
| Knowledge base (the tenant's own business texts)             | `kb_sources`, `kb_chunks`                               | until the owner deletes a source or the tenant                                       |
| Mailbox credentials (sealed)                                 | `email_connections`                                     | until the mailbox or tenant is deleted                                               |
| Health checks                                                | `connection_health_checks`                              | 30 days                                                                              |
| Finished jobs / dead jobs                                    | `jobs`                                                  | 7 days / 30 days (connection tests: 1 hour)                                          |
| Audit log (who approved, changed settings; no email content) | `audit_log`                                             | until the tenant is deleted                                                          |
| Application logs                                             | Hetzner VPS                                             | no email bodies, passwords, tokens or action links (redacted)                        |

The retention purge runs hourly and is idempotent. The retention period is a per-tenant
setting (1–3650 days).

## Hard delete ("Delete all data")

1. The owner types the business name in Settings. The API checks ownership and marks the
   tenant `deleting`: processing and mailbox listeners stop, the owner is signed out.
2. The worker deletes the tenant row; every tenant table cascades (verified by a test that
   counts rows in every table with a `tenant_id`). Owner logins that belong to no other
   business are deleted from Supabase Auth.
3. `tenant_deletions` keeps a proof of erasure without personal data: tenant id, request
   and completion time, and a SHA-256 hash of the requesting user id.

Emails in the tenant's own mailbox are not touched: they belong to the tenant.

## Data subject requests (tenant's customers)

A tenant handles requests from its own customers. Today: delete the lead in the dashboard
or delete the tenant. Per-customer erasure (all messages of one address) is a follow-up.
