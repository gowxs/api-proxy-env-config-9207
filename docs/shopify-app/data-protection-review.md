# Shopify protected customer data: requirement checklist

We need **protected customer data level 2** (customer e-mail, to verify that the sender owns the order).
Development stores can use it without review; real merchants need an approved request.

Source of the requirements (checked 2026-10-02): <https://shopify.dev/docs/apps/launch/protected-customer-data>
(request via Partner Dashboard → Apps → API access requests → Protected customer data access).
Other pages: compliance webhooks <https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance>,
App Store requirements <https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements>,
OAuth <https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/authorization-code-grant>.

Status: **Met** = in code/infrastructure, **Owner** = needs the owner's confirmation or paperwork, **Missing** = open.

## Level 1

| #   | Requirement                                                 | Status    | Evidence / what to do                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Process only the minimum personal data                      | Met       | Scope `read_orders` only. The fact set is fixed in `packages/orders/src/facts.ts`: number, date, financial/fulfillment status, carrier, tracking, expected delivery, item names. No payment details, no addresses. Order e-mail is used only for the identity check and not stored. |
| 2   | Tell merchants what is processed and why                    | Met       | Privacy page, GDPR help article, `docs/data-flow.md`, Shopify guide in Integrations.                                                                                                                                                                                                |
| 3   | Limit processing to stated purposes                         | Met       | Data is fetched only while answering a customer message about an order. Model never receives data beyond the minimal facts.                                                                                                                                                         |
| 4   | Respect customer consent                                    | Met (n/a) | We do not use order data for marketing or profiling.                                                                                                                                                                                                                                |
| 5   | Respect opt-outs of data sharing                            | Met (n/a) | No sharing with third parties beyond the AI provider processing the minimal facts under the merchant's mailbox reply.                                                                                                                                                               |
| 6   | Automated decisions with legal/significant effect → opt out | Met       | Decisions are informational (status), never refunds/returns/cancellations. Reply modes let merchants require approval; auto-send only for fully verified simple cases.                                                                                                              |
| 7   | Privacy/data protection agreements with merchants           | Owner     | Terms/privacy exist; a signed DPA template for merchants must be published or offered.                                                                                                                                                                                              |
| 8   | Retention periods                                           | Met       | Order data is fetched live. Only a per-message summary (`order_lookup`) is stored and deleted with the message retention purge and on tenant delete. Compliance webhooks delete data on request.                                                                                    |
| 9   | Encrypt at rest and in transit                              | Met       | TLS everywhere (never disabled). Access tokens sealed per shop (X25519 + AES-GCM) in addition to Supabase disk encryption.                                                                                                                                                          |

## Level 2

| #   | Requirement                                   | Status      | Evidence / what to do                                                                                                                                                                                   |
| --- | --------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Encrypt backups                               | Met         | Backups are age-encrypted (`BACKUP_AGE_RECIPIENT`, `docs/backup-restore.md`); Supabase backups are encrypted at rest. Owner: confirm the recipient key is held offline.                                 |
| 2   | Separate test and production data             | Met         | Local/CI databases and the mock Shopify server use fixtures; production is a separate Supabase project. Dev store is used for tests only. Owner: confirm no production data is used for development.    |
| 3   | Data loss prevention strategy                 | Met / Owner | Secrets only in env/Northflank, sealed tokens, redacted request logs (`redactActionPath` hides OAuth query), no PII in logs, audit log. Written policy in `security-and-incident-response.md`: sign it. |
| 4   | Limit staff access to protected customer data | Owner       | Service-role key not used at runtime; RLS per tenant; only the worker opens sealed tokens. Owner: list who has production DB access (currently the founder only).                                       |
| 5   | Strong passwords for staff accounts           | Owner       | Enforce a password manager and MFA on GitHub, Supabase, Northflank, Cloudflare, Shopify Partner; record confirmation.                                                                                   |
| 6   | Access log for protected customer data        | Met         | Each order lookup writes an `audit_log` row (`shopify.order_lookup`, metadata: actor, number of matches, outcome; no PII).                                                                              |
| 7   | Security incident response policy             | Owner       | Drafted in `security-and-incident-response.md`; needs the owner's signature and a named contact.                                                                                                        |

## Other Shopify requirements we checked

| Topic                                   | Status                    | Notes                                                                                                                    |
| --------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Mandatory compliance webhooks           | Met                       | `customers/data_request`, `customers/redact`, `shop/redact` handled (HMAC base64 over raw body), plus `app/uninstalled`. |
| OAuth, signed install                   | Met                       | HMAC (hex over sorted query), state + cookie nonce, scope check, expiring offline tokens.                                |
| Billing outside Shopify (req. 1.2.1)    | **Missing / ask Shopify** | See README item 4.                                                                                                       |
| Embedded app + App Bridge (2.2.2/2.2.3) | **Missing / ask Shopify** | Not built; minimal landing page only.                                                                                    |
| No manual shop domain entry (2.3.1)     | Met                       | Install starts from Shopify, never from typed domains.                                                                   |
| Privacy policy URL, emergency contact   | Owner                     | Fill in Partner Dashboard.                                                                                               |
