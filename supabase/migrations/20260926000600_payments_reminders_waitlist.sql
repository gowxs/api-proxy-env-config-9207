-- Founder decisions 2026-09-26 (PLAN.md §22.9–§23):
--  * a delivery note with prices (pavadzīme-rēķins) counts as an invoice:
--    paid / unpaid, due date, payment reminders ("payable");
--  * incoming payments read from the tenant's bank notifications and matched
--    to open invoices;
--  * one overdue reminder to the customer, 3 days after the due date;
--  * the integrations waitlist (public site) and per-tenant "notify me".

set local search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Payable documents
-- ---------------------------------------------------------------------------
alter table public.documents
  add column payable boolean not null default false,
  add column reminder_draft_id uuid,
  add column reminder_queued_at timestamptz,
  add foreign key (tenant_id, reminder_draft_id) references public.drafts (tenant_id, id)
    on delete set null (reminder_draft_id);
update public.documents set payable = (type = 'invoice');

alter table public.documents drop constraint documents_check1;
alter table public.documents add constraint documents_paid_only_when_payable
  check (status <> 'paid' or payable);
alter table public.documents drop constraint documents_check2;
alter table public.documents add constraint documents_delivered_only_when_not_payable
  check (status <> 'delivered' or not payable);
create index documents_overdue_idx on public.documents (due_date)
  where payable and status = 'sent' and reminder_queued_at is null;

alter table public.drafts drop constraint drafts_kind_check;
alter table public.drafts add constraint drafts_kind_check
  check (kind in ('reply', 'followup', 'acknowledgement', 'quote', 'document', 'payment_reminder'));

-- ---------------------------------------------------------------------------
-- Bank notification senders (confirmed by the owner) and incoming payments
-- ---------------------------------------------------------------------------
create table public.bank_senders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  domain text not null check (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
                              and char_length(domain) <= 253),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, domain)
);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  message_id uuid unique,
  amount_cents integer not null check (amount_cents > 0),
  currency text check (currency ~ '^[A-Z]{3}$'),
  payer_name text check (char_length(payer_name) <= 200),
  reference text check (char_length(reference) <= 300),
  status text not null default 'unmatched'
    check (status in ('unmatched', 'proposed', 'matched', 'dismissed')),
  match_kind text check (match_kind in ('exact', 'amount', 'payer', 'manual')),
  document_id uuid,
  matched_by text check (matched_by in ('auto', 'owner')),
  matched_at timestamptz,
  -- Field → the text of the bank e-mail it was read from.
  sources jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  check ((status in ('proposed', 'matched')) = (document_id is not null)),
  foreign key (tenant_id, message_id) references public.messages (tenant_id, id) on delete set null (message_id),
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete set null (document_id)
);
create index payments_tenant_idx on public.payments (tenant_id, created_at desc);
create index payments_document_idx on public.payments (tenant_id, document_id);
create trigger set_updated_at before update on public.payments
  for each row execute function app.set_updated_at();

do $$
declare
  t text;
begin
  foreach t in array array['bank_senders', 'payments'] loop
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
revoke all on public.bank_senders, public.payments from anon, authenticated;
grant select on public.bank_senders, public.payments to authenticated;
grant select, insert, delete on public.bank_senders to noctiv_api;
grant select, update on public.payments to noctiv_api;
grant select, insert, update, delete on public.bank_senders, public.payments to noctiv_worker;

-- ---------------------------------------------------------------------------
-- Overdue reminders: sent, payable documents 3 days past due, not yet reminded.
-- ---------------------------------------------------------------------------
create function app.due_payment_reminders(p_limit integer)
returns table (tenant_id uuid, document_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select d.tenant_id, d.id
  from public.documents d join public.tenants t on t.id = d.tenant_id
  where d.payable and d.status = 'sent' and d.reminder_queued_at is null
    and d.thread_id is not null and d.due_date is not null
    and d.due_date + 3 <= (now() at time zone t.timezone)::date
    and t.status = 'active' and t.documents_enabled
    and app.billing_entitled(t.billing_status, t.trial_ends_at)
  order by d.due_date
  limit p_limit
$$;
revoke all on function app.due_payment_reminders(integer) from public;
grant execute on function app.due_payment_reminders(integer) to noctiv_worker;

-- ---------------------------------------------------------------------------
-- Integrations: per-tenant "notify me", and the public waitlist.
-- ---------------------------------------------------------------------------
alter table public.tenants
  add column integrations_notify text[] not null default '{}'
    check (integrations_notify <@ array['xero', 'quickbooks', 'zoho_books', 'shopify', 'woocommerce']);
grant update (integrations_notify) on public.tenants to noctiv_api;

-- Not tenant data: kept outside the public schema, reachable only through
-- the functions below (no table privileges for any runtime role).
create schema if not exists marketing;
revoke all on schema marketing from public;

create table marketing.waitlist (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique check (char_length(email) <= 254),
  integrations text[] not null
    check (cardinality(integrations) between 1 and 5
           and integrations <@ array['xero', 'quickbooks', 'zoho_books', 'shopify', 'woocommerce']),
  source text not null check (char_length(source) <= 60),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'unsubscribed')),
  -- sha256 of the address with a server secret: enough to spot abuse, not to identify anyone.
  ip_hash text check (char_length(ip_hash) <= 64),
  confirmation_due boolean not null default false,
  confirmation_sent_at timestamptz,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  unsubscribed_at timestamptz
);
create index waitlist_due_idx on marketing.waitlist (created_at) where confirmation_due;

-- Sign up (or add integrations). A confirmation e-mail is queued unless one
-- went out in the last 24 hours; confirmed addresses just get the new choices.
create function app.waitlist_signup(p_email text, p_integrations text[], p_source text, p_ip_hash text)
returns table (id uuid, status text, confirmation_queued boolean)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  w marketing.waitlist;
begin
  insert into marketing.waitlist as x (email, integrations, source, ip_hash, confirmation_due)
  values (p_email, p_integrations, p_source, p_ip_hash, true)
  on conflict (email) do update
    set integrations = (select array_agg(distinct i order by i) from unnest(x.integrations || excluded.integrations) i),
        status = case when x.status = 'unsubscribed' then 'pending' else x.status end,
        confirmation_due = case
          when x.status = 'confirmed' then false
          when x.confirmation_sent_at is not null and x.confirmation_sent_at > now() - interval '24 hours' then x.confirmation_due
          else true end,
        ip_hash = excluded.ip_hash
  returning * into w;
  return query select w.id, w.status, w.confirmation_due;
end
$$;

create function app.waitlist_set_status(p_id uuid, p_status text)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  update marketing.waitlist
  set status = p_status,
      confirmed_at = case when p_status = 'confirmed' then coalesce(confirmed_at, now()) else confirmed_at end,
      unsubscribed_at = case when p_status = 'unsubscribed' then now() else null end,
      confirmation_due = false
  where id = p_id and p_status in ('confirmed', 'unsubscribed')
    and (p_status = 'unsubscribed' or status = 'pending' or status = 'confirmed')
  returning status
$$;

create function app.waitlist_due_confirmations(p_limit integer)
returns table (id uuid, email text, integrations text[])
language sql
stable
security definer
set search_path = ''
as $$
  select w.id, w.email::text, w.integrations from marketing.waitlist w
  where w.confirmation_due and w.status = 'pending'
  order by w.created_at limit p_limit
$$;

create function app.waitlist_confirmation_sent(p_id uuid)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update marketing.waitlist set confirmation_due = false, confirmation_sent_at = now() where id = p_id
$$;

-- For the founder's CSV: confirmed sign-ups, plus account owners who switched
-- on "notify me" in the app (their address is verified by sign-in).
create function app.waitlist_export()
returns table (email text, integrations text[], source text, status text, created_at timestamptz,
               confirmed_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select w.email::text, w.integrations, w.source, w.status, w.created_at, w.confirmed_at
  from marketing.waitlist w where w.status = 'confirmed'
  union all
  select distinct on (u.email) u.email::text, t.integrations_notify, 'app', 'confirmed', t.created_at, null
  from public.tenants t
  join public.tenant_members m on m.tenant_id = t.id
  join auth.users u on u.id = m.user_id
  where cardinality(t.integrations_notify) > 0 and t.status = 'active'
  order by 1
$$;

revoke all on function app.waitlist_signup(text, text[], text, text) from public;
revoke all on function app.waitlist_set_status(uuid, text) from public;
revoke all on function app.waitlist_due_confirmations(integer) from public;
revoke all on function app.waitlist_confirmation_sent(uuid) from public;
revoke all on function app.waitlist_export() from public;
grant execute on function app.waitlist_signup(text, text[], text, text) to noctiv_api;
grant execute on function app.waitlist_set_status(uuid, text) to noctiv_api;
grant execute on function app.waitlist_export() to noctiv_api;
grant execute on function app.waitlist_due_confirmations(integer) to noctiv_worker;
grant execute on function app.waitlist_confirmation_sent(uuid) to noctiv_worker;
