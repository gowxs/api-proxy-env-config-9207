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
- Subscriptions: the owner pays in Paddle Checkout (overlay in the dashboard; Paddle is merchant of record and holds all payment data). Paddle sends signed `subscription.*` webhooks to the API, which stores only the status, customer and subscription IDs on the tenant.

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
                    LLM (Vertex AI, EU: eu + europe-west4, no training)
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

| Data                                                                   | Where                                                   | Kept                                                                                 |
| ---------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Email text, subject, sender name (inbound and outbound)                | `messages`                                              | `retention_days` (default 90), then removed                                          |
| Model classification and output (summaries, reply text)                | `message_processing`                                    | removed with the email text                                                          |
| Draft text                                                             | `drafts`                                                | `retention_days`, then removed                                                       |
| Escalation summaries                                                   | `escalations`                                           | `retention_days`, then removed                                                       |
| Notification contents (subject, summary)                               | `notifications`                                         | deleted once delivered, after ≤ 30 days                                              |
| Message-IDs, addresses, statuses, timestamps, token counts             | `messages`, `threads`, `outbound_emails`, `usage_daily` | until the tenant is deleted (needed for deduplication, threading, leads and billing) |
| Leads (customer email, name, stage, owner notes)                       | `leads`, `lead_events`                                  | until the owner changes them or the tenant is deleted                                |
| Knowledge base (the tenant's own business texts)                       | `kb_sources`, `kb_chunks`                               | until the owner deletes a source or the tenant                                       |
| Mailbox credentials (sealed)                                           | `email_connections`                                     | until the mailbox or tenant is deleted                                               |
| Health checks                                                          | `connection_health_checks`                              | 30 days                                                                              |
| Finished jobs / dead jobs                                              | `jobs`                                                  | 7 days / 30 days (connection tests: 1 hour)                                          |
| Shopify access token (sealed per shop, expiring)                       | `shopify_connections`                                   | until disconnect, uninstall, `shop/redact` or tenant delete                          |
| Order summary found for a message (status, number; no address/payment) | `message_processing.order_lookup`                       | with the message retention purge (nulled)                                            |
| Audit log (who approved, changed settings; no email content)           | `audit_log`                                             | until the tenant is deleted                                                          |
| Application logs                                                       | Hetzner VPS                                             | no email bodies, passwords, tokens or action links (redacted)                        |

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

## Sent folder and read state

The worker reads the owner's Sent folder read-only (EXAMINE). A message is stored only if it references a conversation Noctiv already holds (`In-Reply-To`/`References` match a stored message or one of ours); everything else, including its Message-ID, is dropped. Noctiv's own sent copies are recognised by Message-ID and skipped. The first run records a position and imports no history. `messages.seen` mirrors the provider's `\Seen` flag for recent inbound mail; nothing is ever written back. Stored text, subject and attachment names of these messages fall under the normal retention purge.

An owner reply that threads onto a conversation also resolves that conversation's open escalations up to the reply (`resolved_by = 'owner_replied'`), supersedes waiting reply and follow-up drafts created before it, and sets the thread to `awaiting_customer`. Newer customer messages and their escalations are untouched; unthreaded Sent mail changes nothing.

## Shopify order lookup (WISMO)

Read-only (`read_orders`). When a customer message looks like an order question, the worker parses the order number
(else uses the sender e-mail), asks Shopify's GraphQL Admin API live, and a deterministic engine (`packages/orders`)
decides: reply, or escalate. An order is used only if the sender e-mail equals the order e-mail; otherwise nothing from the
order is revealed. The model receives only the minimal facts (number, date, payment/fulfillment status, carrier, tracking,
expected delivery, item names) and only words them; the claim detector checks the draft against those facts.
Not requested or stored: payment details, addresses, order contents beyond item names. Order data is not persisted except
the per-message summary above. The OAuth token is sealed (X25519 + AES-GCM, bound to the shop domain), only the worker
opens it and renews it under a row lock. Each lookup writes an `audit_log` row (`shopify.order_lookup`, no PII).
Uninstall, disconnect and the compliance webhooks delete the token and summaries.
