-- Documents (beta), PLAN.md §22 (founder request 2026-09-26): invoices,
-- delivery notes and CMR consignment notes on one engine (@noctiv/documents).
-- Off by default. Not accounting: no ledger, no e-invoicing formats.

set local search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Tenant settings: the seller details printed on every document.
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column documents_enabled boolean not null default false,
  add column seller_legal_name text check (char_length(seller_legal_name) <= 200),
  add column seller_legal_address text check (char_length(seller_legal_address) <= 500),
  add column seller_reg_no text check (char_length(seller_reg_no) <= 40),
  add column seller_vat_no text check (char_length(seller_vat_no) <= 30),
  add column seller_bank_name text check (char_length(seller_bank_name) <= 100),
  add column seller_iban text check (char_length(seller_iban) <= 42),
  add column seller_bic text check (char_length(seller_bic) <= 11),
  add column seller_country text check (char_length(seller_country) <= 60),
  add column invoice_due_days integer not null default 14 check (invoice_due_days between 0 and 365);

grant update (
  documents_enabled, seller_legal_name, seller_legal_address, seller_reg_no, seller_vat_no,
  seller_bank_name, seller_iban, seller_bic, seller_country, invoice_due_days
) on public.tenants to noctiv_api;

alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check
  check (kind in ('reply', 'followup', 'acknowledgement', 'quote', 'document'));

-- ---------------------------------------------------------------------------
-- Documents
-- ---------------------------------------------------------------------------
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  type text not null check (type in ('invoice', 'delivery_note', 'cmr')),
  -- Given when issued: INV-2026-0001, DN-…, CMR-…, restarting each year.
  number text check (number ~ '^(INV|DN|CMR)-[0-9]{4}-[0-9]{4,}$'),
  status text not null default 'draft'
    check (status in ('draft', 'issued', 'sent', 'paid', 'delivered', 'cancelled')),
  language text not null default 'en' check (language in ('en', 'de', 'lv', 'nl', 'fr', 'es')),
  thread_id uuid,
  lead_id uuid,
  quote_id uuid,
  source_document_id uuid,
  source_message_id uuid,
  -- The reply that carries (or carried) it.
  draft_id uuid unique,
  -- The type's fields, validated by the engine.
  data jsonb not null default '{}'::jsonb,
  -- Fields the AI filled from an e-mail: path → {source}. Dropped when issued.
  prefill jsonb,
  prefill_status text check (prefill_status in ('pending', 'done', 'failed')),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  vat_mode text not null check (vat_mode in ('none', 'exclusive', 'inclusive')),
  vat_rate numeric(5, 2) not null check (vat_rate >= 0 and vat_rate < 100),
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  vat_cents integer not null default 0 check (vat_cents >= 0),
  total_cents integer not null default 0 check (total_cents >= 0),
  counterparty_name text check (char_length(counterparty_name) <= 200),
  issue_date date,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  issued_at timestamptz,
  sent_at timestamptz,
  paid_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, number),
  -- A draft has no number; everything after it has one.
  check ((status = 'draft') = (number is null)),
  check (status <> 'paid' or type = 'invoice'),
  check (status <> 'delivered' or type <> 'invoice'),
  check (octet_length(data::text) <= 200000),
  foreign key (tenant_id, thread_id) references public.threads (tenant_id, id) on delete set null (thread_id),
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id) on delete set null (lead_id),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id) on delete set null (quote_id),
  foreign key (tenant_id, source_document_id) references public.documents (tenant_id, id)
    on delete set null (source_document_id),
  foreign key (tenant_id, source_message_id) references public.messages (tenant_id, id)
    on delete set null (source_message_id),
  foreign key (tenant_id, draft_id) references public.drafts (tenant_id, id) on delete set null (draft_id)
);
create index documents_tenant_idx on public.documents (tenant_id, created_at desc);
create index documents_thread_idx on public.documents (tenant_id, thread_id);

create trigger set_updated_at before update on public.documents
  for each row execute function app.set_updated_at();

alter table public.documents enable row level security;
alter table public.documents force row level security;
create policy runtime_tenant_isolation on public.documents
  as permissive for all to noctiv_api, noctiv_worker
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
create policy member_tenant_access on public.documents
  as permissive for all to authenticated
  using (tenant_id in (select app.user_tenant_ids()))
  with check (tenant_id in (select app.user_tenant_ids()));

revoke all on public.documents from anon, authenticated;
grant select on public.documents to authenticated;
grant select, insert, update, delete on public.documents to noctiv_api, noctiv_worker;

-- The API creates the reply draft that carries a document.
grant insert on public.drafts to noctiv_api;

-- ---------------------------------------------------------------------------
-- Retention: the e-mail excerpts behind AI-filled fields follow the tenant's
-- retention_days. Documents themselves are business records and are kept.
-- ---------------------------------------------------------------------------
create function app.purge_expired_document_prefill()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with p as (
    update public.documents d set prefill = null
    from public.tenants t
    where t.id = d.tenant_id and d.prefill is not null
      and d.created_at < now() - make_interval(days => t.retention_days)
    returning 1
  )
  select count(*)::integer from p
$$;
revoke all on function app.purge_expired_document_prefill() from public;
grant execute on function app.purge_expired_document_prefill() to noctiv_worker;
