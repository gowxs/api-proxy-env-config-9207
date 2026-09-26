-- Founder request 2026-09-26 (PLAN.md §22.11–§22.13):
--  * invoice made and sent automatically when a customer accepts a quote
--    (per-tenant switch, on by default; only while Documents is on);
--  * delivery note made and sent when an invoice is paid (switch, off by default);
--  * "New e-mail" from the Inbox: a new conversation and lead, with any
--    ready documents attached.

alter table public.tenants
  add column auto_invoice_on_accept boolean not null default true,
  add column auto_delivery_note_after_payment boolean not null default false;
grant update (auto_invoice_on_accept, auto_delivery_note_after_payment) on public.tenants to noctiv_api;

-- Which automation made a document; at most one per quote / per invoice.
alter table public.documents
  add column auto_source text check (auto_source in ('quote_accepted', 'invoice_paid'));
create unique index documents_auto_once on public.documents
  (tenant_id, auto_source, coalesce(quote_id, source_document_id))
  where auto_source is not null;

-- One new e-mail may carry several documents.
alter table public.documents drop constraint documents_draft_id_key;
create index documents_draft_idx on public.documents (draft_id) where draft_id is not null;

alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check
  check (kind in ('reply', 'followup', 'acknowledgement', 'quote', 'document', 'payment_reminder',
                  'compose'));

-- A new e-mail starts its own conversation (and a lead for a new address).
grant insert on public.threads, public.leads to noctiv_api;
