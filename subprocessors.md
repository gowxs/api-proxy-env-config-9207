# Subprocessors

Every third party that stores or processes personal data for Noctiv. Keep this
file current. A new subprocessor needs founder approval before any code uses it.
How data moves between them: [docs/data-flow.md](docs/data-flow.md).

| Subprocessor                                        | Purpose                                                                                   | Data                                                                                                           | Location                                         | Status                                                    |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- |
| Supabase Inc.                                       | Postgres database and authentication (no file storage: uploads are deleted after reading) | All tenant data; owner login emails                                                                            | EU (Frankfurt, `eu-central-1`)                   | Project created; schema not yet applied                   |
| Hetzner Online GmbH                                 | VPS hosting for api, worker, web                                                          | All tenant data in transit and in memory; application logs (no email bodies, no passwords)                     | EU (Germany / Finland)                           | Planned (deploy step)                                     |
| Google Cloud: Vertex AI                             | Reply generation, classification, embeddings (paid tier, no training on customer data)    | Email content, knowledge-base text                                                                             | EU (`europe-west4`, Netherlands)                 | Implemented, not yet live (no billing yet)                |
| Google: Gemini Developer API (AI Studio, free tier) | Development and testing only                                                              | **Synthetic data and operator-flagged test mailboxes only**; free-tier data may be used by Google for training | Google global infrastructure (not EU-restricted) | Dev/test only, never for customer data (enforced in code) |
| Brevo (Sendinblue SAS)                              | System mailer: owner/admin notifications, Supabase Auth emails                            | Owner email addresses; notification text (privacy mode: sender domain, subject, summary, reasons)              | EU (France)                                      | Chosen (Q10); credentials pending                         |

Not subprocessors: the tenant's own mail provider (Gmail, Yahoo, …) — Noctiv acts on the tenant's
mailbox with the tenant's App Password; the data already lives there.
