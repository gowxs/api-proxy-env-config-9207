# Security and incident response policy (Noctiv)

Owner and responsible person: ____________________ Contact: ____________________
Version 1, date: ____________

## 1. Scope

Protected customer data received from Shopify stores (order number, order e-mail, name, shipment status). It is fetched live,
used to answer one customer message and not stored beyond a minimal per-message summary.

## 2. Protection measures

- Encryption in transit (TLS) and at rest (database disk encryption); Shopify tokens sealed per shop; backups age-encrypted.
- Test and production are separate; tests use fixtures and a Shopify development store only.
- Staff access limited to the owner; production access needs MFA and strong unique passwords (password manager).
- Secrets only in environment stores, never in the repository or logs; request logs redact OAuth parameters.
- Each order lookup is recorded in the access log without personal data.
- Data loss prevention: least privilege (read_orders only), no payment/address data requested, retention purge, deletion on uninstall and
  on compliance webhooks (`customers/redact`, `shop/redact`), encrypted backups, restore tested per `docs/backup-restore.md`.

## 3. Incident response

1. **Detect**: alerts, error logs, merchant or customer reports, Shopify notices.
2. **Contain** (immediately): revoke affected Shopify tokens (disconnect/revoke), rotate app secret and sealing keys, disable
   the affected route or the lookup feature flag, suspend affected access.
3. **Assess** (within 24 h): which stores and which data, from the access log and database audit.
4. **Notify**: affected merchants without undue delay and within 72 h of becoming aware (GDPR Art. 33/34 timeline for authorities
   where applicable); Shopify via Partner Support / the emergency contact.
5. **Recover**: fix root cause, restore from encrypted backup if needed, verify.
6. **Review**: written post-mortem within 14 days; update this policy and tests.

## 4. Review

This policy is reviewed once a year and after every incident.

Signature: ____________________ Date: ____________
