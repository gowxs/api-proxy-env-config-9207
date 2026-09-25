-- Quotes (beta), PLAN.md §21 (founder request 2026-09-26). Off by default.
-- Money is integer cents; quantities have at most two decimals. Every number
-- on a quote comes from a confirmed price item or the customer's e-mail;
-- totals are computed in code (@noctiv/quotes) and stored as a snapshot.

set local search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Tenant settings
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column quotes_enabled boolean not null default false,
  add column quotes_currency text not null default 'EUR' check (quotes_currency ~ '^[A-Z]{3}$'),
  add column quotes_vat_mode text not null default 'exclusive'
    check (quotes_vat_mode in ('none', 'exclusive', 'inclusive')),
  add column quotes_vat_rate numeric(5, 2) not null default 21
    check (quotes_vat_rate >= 0 and quotes_vat_rate < 100),
  add column quotes_validity_days integer not null default 14
    check (quotes_validity_days between 1 and 365),
  add column quotes_auto_send_limit_cents integer not null default 50000
    check (quotes_auto_send_limit_cents >= 0),
  add column quotes_next_number integer not null default 1 check (quotes_next_number >= 1);

grant update (
  quotes_enabled, quotes_currency, quotes_vat_mode, quotes_vat_rate,
  quotes_validity_days, quotes_auto_send_limit_cents
) on public.tenants to noctiv_api;

-- ---------------------------------------------------------------------------
-- Price list
-- ---------------------------------------------------------------------------
create table public.price_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  file_name text not null check (char_length(file_name) between 1 and 255),
  -- Text extracted by the API (the file itself is not kept).
  extracted_text text check (char_length(extracted_text) <= 200000),
  status text not null default 'pending' check (status in ('pending', 'parsing', 'ready', 'failed')),
  item_count integer not null default 0 check (item_count >= 0),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index price_imports_tenant_idx on public.price_imports (tenant_id, created_at desc);

create table public.price_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 200),
  description text check (char_length(description) <= 1000),
  unit text not null default 'pcs' check (char_length(unit) between 1 and 30),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  min_qty numeric(12, 2) check (min_qty > 0),
  max_qty numeric(12, 2) check (max_qty > 0),
  vat_note text check (char_length(vat_note) <= 200),
  -- Only 'confirmed' items can be quoted; imported documents create 'draft' ones.
  status text not null default 'confirmed' check (status in ('draft', 'confirmed', 'archived')),
  source text not null default 'manual' check (source in ('manual', 'csv', 'file')),
  import_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check (min_qty is null or max_qty is null or min_qty <= max_qty),
  foreign key (tenant_id, import_id) references public.price_imports (tenant_id, id) on delete set null (import_id)
);
create index price_items_tenant_idx on public.price_items (tenant_id, status, name);

-- ---------------------------------------------------------------------------
-- Quotes
-- ---------------------------------------------------------------------------
alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check
  check (kind in ('reply', 'followup', 'acknowledgement', 'quote'));

alter table public.leads drop constraint leads_stage_check;
alter table public.leads add constraint leads_stage_check
  check (stage in ('received', 'drafted', 'sent', 'followed_up', 'replied', 'quoted', 'accepted',
                   'converted', 'escalated'));

create table public.quotes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  number text not null check (number ~ '^Q-[0-9]{4}-[0-9]{4,}$'),
  thread_id uuid not null,
  lead_id uuid,
  -- The 'quote' draft that carries it (cover reply + PDF). One quote per draft.
  draft_id uuid unique,
  source_message_id uuid,
  status text not null default 'pending_approval'
    check (status in ('draft', 'pending_approval', 'sent', 'viewed', 'accepted', 'expired', 'rejected')),
  language text,
  customer_name text check (char_length(customer_name) <= 200),
  customer_email citext not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  vat_mode text not null check (vat_mode in ('none', 'exclusive', 'inclusive')),
  vat_rate numeric(5, 2) not null check (vat_rate >= 0 and vat_rate < 100),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  vat_cents integer not null check (vat_cents >= 0),
  total_cents integer not null check (total_cents >= 0),
  valid_until date not null,
  notes text check (char_length(notes) <= 2000),
  -- Why it was held for approval (quote_over_limit, quote_unmapped, guard reasons).
  hold_reasons text[] not null default '{}',
  sent_at timestamptz,
  viewed_at timestamptz,
  accepted_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, thread_id) references public.threads (tenant_id, id) on delete cascade,
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id) on delete set null (lead_id),
  foreign key (tenant_id, draft_id) references public.drafts (tenant_id, id) on delete set null (draft_id),
  foreign key (tenant_id, source_message_id) references public.messages (tenant_id, id)
    on delete set null (source_message_id)
);
create index quotes_tenant_idx on public.quotes (tenant_id, created_at desc);
create index quotes_thread_idx on public.quotes (tenant_id, thread_id);
create index quotes_expiry_idx on public.quotes (valid_until) where status in ('sent', 'viewed');

create table public.quote_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  quote_id uuid not null,
  position integer not null check (position >= 0),
  price_item_id uuid,
  -- Snapshot of the item at quoting time.
  name text not null check (char_length(name) between 1 and 200),
  unit text not null check (char_length(unit) between 1 and 30),
  vat_note text check (char_length(vat_note) <= 200),
  qty numeric(12, 2) not null check (qty > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  line_total_cents integer not null check (line_total_cents >= 0),
  -- The customer's own words for this line (purged with other e-mail content).
  customer_text text check (char_length(customer_text) <= 300),
  created_at timestamptz not null default now(),
  unique (quote_id, position),
  foreign key (tenant_id, quote_id) references public.quotes (tenant_id, id) on delete cascade,
  foreign key (tenant_id, price_item_id) references public.price_items (tenant_id, id)
    on delete set null (price_item_id)
);
create index quote_lines_quote_idx on public.quote_lines (tenant_id, quote_id, position);

do $$
declare
  t text;
begin
  foreach t in array array['price_imports', 'price_items', 'quotes'] loop
    execute format('create trigger set_updated_at before update on public.%I
         for each row execute function app.set_updated_at()', t);
  end loop;
  foreach t in array array['price_imports', 'price_items', 'quotes', 'quote_lines'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy runtime_tenant_isolation on public.%I
         as permissive for all to noctiv_api, noctiv_worker
         using (tenant_id = (select app.current_tenant_id()))
         with check (tenant_id = (select app.current_tenant_id()))', t);
    execute format(
      'create policy member_tenant_access on public.%I
         as permissive for all to authenticated
         using (tenant_id in (select app.user_tenant_ids()))
         with check (tenant_id in (select app.user_tenant_ids()))', t);
  end loop;
end
$$;

revoke all on public.price_imports, public.price_items, public.quotes, public.quote_lines
  from anon, authenticated;
grant select on public.price_items, public.quotes, public.quote_lines to authenticated;

-- API: the owner edits the price list and quote lines; the accept link
-- marks a quote viewed/accepted.
grant select, insert, update, delete on public.price_items to noctiv_api;
grant select, insert on public.price_imports to noctiv_api;
grant select on public.quotes to noctiv_api;
grant update (
  status, notes, valid_until, subtotal_cents, vat_cents, total_cents,
  viewed_at, accepted_at, expired_at
) on public.quotes to noctiv_api;
grant select, insert, delete on public.quote_lines to noctiv_api;

grant select, insert, update, delete on
  public.price_imports, public.price_items, public.quotes, public.quote_lines
to noctiv_worker;

-- ---------------------------------------------------------------------------
-- Hourly: sent/viewed quotes past their validity become 'expired'.
-- ---------------------------------------------------------------------------
create function app.expire_quotes()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with e as (
    update public.quotes q set status = 'expired', expired_at = now()
    from public.tenants t
    where t.id = q.tenant_id
      and q.status in ('sent', 'viewed')
      and q.valid_until < (now() at time zone t.timezone)::date
    returning 1
  )
  select count(*)::integer from e
$$;
revoke all on function app.expire_quotes() from public;
grant execute on function app.expire_quotes() to noctiv_worker;

-- Retention: the customer's own words on quote lines follow the tenant's
-- retention_days like other e-mail content. Numbers and item names stay.
create function app.purge_expired_quote_text()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with p as (
    update public.quote_lines l set customer_text = null
    from public.tenants t
    where t.id = l.tenant_id and l.customer_text is not null
      and l.created_at < now() - make_interval(days => t.retention_days)
    returning 1
  )
  select count(*)::integer from p
$$;
revoke all on function app.purge_expired_quote_text() from public;
grant execute on function app.purge_expired_quote_text() to noctiv_worker;
