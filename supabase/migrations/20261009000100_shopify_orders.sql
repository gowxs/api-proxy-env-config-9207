-- Shopify order lookup (WISMO). Read-only: orders are fetched live; only the
-- connection (sealed tokens) and a small summary per answered message are stored.
--
-- The merchant installs Noctiv's Shopify app (OAuth, authorization code grant,
-- expiring offline tokens). The install finishes on the API before anyone is
-- signed in to Noctiv, so the tokens first wait in app.shopify_installs until
-- the signed-in owner links the store to their business ("claim").
-- Tokens (access + refresh) are sealed with the credentials public key: the API
-- can seal but never open; only the worker opens them. Associated data:
-- noctiv:shopify_credentials:v1:<shop domain>.

create table app.shopify_installs (
  shop_domain text primary key check (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$'),
  credentials_ciphertext bytea not null,
  credentials_key_id text not null,
  scopes text[] not null default '{}',
  created_at timestamptz not null default now()
);
revoke all on app.shopify_installs from public;

create table public.shopify_connections (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  shop_domain text not null unique check (shop_domain ~ '^[a-z0-9][a-z0-9-]{0,60}\.myshopify\.com$'),
  credentials_ciphertext bytea not null,
  credentials_key_id text not null,
  shop_name text check (char_length(shop_name) <= 200),
  scopes text[] not null default '{}',
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error_code text check (char_length(last_error_code) <= 40),
  last_checked_at timestamptz,
  -- Expiring tokens are renewed before they lapse (the refresh token lives 90 days and is replaced on every renewal).
  tokens_renewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.shopify_connections
  for each row execute function app.set_updated_at();
alter table public.shopify_connections enable row level security;
alter table public.shopify_connections force row level security;
create policy runtime_tenant_isolation on public.shopify_connections
  as permissive for all to noctiv_api, noctiv_worker
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
-- Signed-in owners (Supabase client) may see the connection but never the sealed tokens.
create policy member_tenant_access on public.shopify_connections
  as permissive for select to authenticated
  using (tenant_id in (select app.user_tenant_ids()));
revoke all on public.shopify_connections from anon, authenticated;
grant select (tenant_id, shop_domain, shop_name, scopes, status, last_error_code, last_checked_at,
              tokens_renewed_at, created_at, updated_at) on public.shopify_connections to authenticated;
grant select (tenant_id, shop_domain, shop_name, scopes, status, last_error_code, last_checked_at,
              tokens_renewed_at, created_at, updated_at) on public.shopify_connections to noctiv_api;
-- "Disconnect and delete token": the row, with the sealed tokens, is deleted.
grant delete on public.shopify_connections to noctiv_api;
grant select, update, delete on public.shopify_connections to noctiv_worker;

-- The install callback and Shopify's webhooks arrive without a signed-in user or a tenant
-- context, so they go through these narrow functions (the API role cannot touch the tables).

-- Stores the tokens of a finished install. A store that is already linked keeps its link
-- and just gets the new tokens (a re-install); otherwise they wait to be claimed.
create function app.shopify_install_store(p_shop text, p_ciphertext bytea, p_key_id text, p_scopes text[])
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from app.shopify_installs where created_at < now() - interval '1 day';
  update public.shopify_connections
     set credentials_ciphertext = p_ciphertext, credentials_key_id = p_key_id, scopes = p_scopes,
         status = 'connected', last_error_code = null, tokens_renewed_at = now()
   where shop_domain = p_shop;
  if found then return 'updated'; end if;
  insert into app.shopify_installs (shop_domain, credentials_ciphertext, credentials_key_id, scopes)
  values (p_shop, p_ciphertext, p_key_id, p_scopes)
  on conflict (shop_domain) do update
    set credentials_ciphertext = excluded.credentials_ciphertext,
        credentials_key_id = excluded.credentials_key_id, scopes = excluded.scopes, created_at = now();
  return 'pending';
end $$;

-- The signed-in owner links a finished install to their business. One store, one business.
create function app.shopify_install_claim(p_shop text, p_tenant_id uuid, p_user_id uuid)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v app.shopify_installs;
begin
  if not exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id and m.user_id = p_user_id and m.role = 'owner'
  ) then
    return 'forbidden';
  end if;
  if exists (select 1 from public.shopify_connections where shop_domain = p_shop and tenant_id <> p_tenant_id) then
    return 'taken';
  end if;
  with d as (delete from app.shopify_installs where shop_domain = p_shop returning *)
  select * into v from d;
  if not found then
    -- Claimed already (a double click) by this very business?
    if exists (select 1 from public.shopify_connections where shop_domain = p_shop and tenant_id = p_tenant_id)
    then return 'ok'; end if;
    return 'missing';
  end if;
  insert into public.shopify_connections (tenant_id, shop_domain, credentials_ciphertext, credentials_key_id, scopes)
  values (p_tenant_id, v.shop_domain, v.credentials_ciphertext, v.credentials_key_id, v.scopes)
  on conflict (tenant_id) do update
    set shop_domain = excluded.shop_domain, credentials_ciphertext = excluded.credentials_ciphertext,
        credentials_key_id = excluded.credentials_key_id, scopes = excluded.scopes,
        status = 'connected', last_error_code = null, tokens_renewed_at = now();
  insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id)
  values (p_tenant_id, 'owner', p_user_id, 'shopify.connected', 'shopify_connection', p_tenant_id);
  return 'ok';
end $$;

-- The app was uninstalled, or Shopify asks to erase a shop (webhooks): the tokens go.
-- Returns the business the store belonged to, if any.
create function app.shopify_shop_removed(p_shop text, p_reason text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_tenant uuid;
begin
  delete from app.shopify_installs where shop_domain = p_shop;
  with d as (delete from public.shopify_connections where shop_domain = p_shop returning tenant_id)
  select tenant_id into v_tenant from d;
  if v_tenant is not null then
    insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
    values (v_tenant, 'system', 'shopify.disconnected', 'shopify_connection', v_tenant,
            jsonb_build_object('reason', left(p_reason, 40)));
  end if;
  return v_tenant;
end $$;

-- Privacy webhooks about a shop's customers (data request, erasure): recorded for the business.
-- Noctiv keeps no Shopify customer data of its own (orders are read live), so there is nothing
-- to export or erase beyond the e-mail content the retention rules already cover.
create function app.shopify_privacy_request(p_shop text, p_topic text)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_tenant uuid;
begin
  select tenant_id into v_tenant from public.shopify_connections where shop_domain = p_shop;
  if v_tenant is not null then
    insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
    values (v_tenant, 'system', 'shopify.privacy_request', 'shopify_connection', v_tenant,
            jsonb_build_object('topic', left(p_topic, 40)));
  end if;
  return v_tenant;
end $$;

-- Worker: stores whose tokens should be renewed (renewing keeps the 90-day refresh token alive).
create function app.shopify_due_renewal(p_limit integer)
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select c.tenant_id from public.shopify_connections c
  join public.tenants t on t.id = c.tenant_id
  where c.status = 'connected' and t.status = 'active'
    and c.tokens_renewed_at < now() - interval '7 days'
  order by c.tokens_renewed_at
  limit least(greatest(p_limit, 1), 200)
$$;

revoke all on function app.shopify_install_store(text, bytea, text, text[]),
  app.shopify_install_claim(text, uuid, uuid), app.shopify_shop_removed(text, text),
  app.shopify_privacy_request(text, text), app.shopify_due_renewal(integer) from public;
grant execute on function app.shopify_install_store(text, bytea, text, text[]),
  app.shopify_install_claim(text, uuid, uuid), app.shopify_shop_removed(text, text),
  app.shopify_privacy_request(text, text) to noctiv_api;
grant execute on function app.shopify_due_renewal(integer) to noctiv_worker;

-- Days without a shipping update before an order e-mail is handed to the owner.
alter table public.tenants
  add column shopify_stale_days integer not null default 14 check (shopify_stale_days between 1 and 90);
grant update (shopify_stale_days) on public.tenants to noctiv_api;

-- What the order card in the conversation shows: order number, status, tracking
-- (or the reason the e-mail went to the owner). No addresses, no payment details,
-- no customer data. Deleted with the message content (retention).
alter table public.message_processing add column order_lookup jsonb;

create or replace function app.purge_expired_content()
returns table (messages_purged integer, drafts_purged integer, notifications_deleted integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m integer;
  d integer;
  n integer;
begin
  with expired as (
    select msg.id from public.messages msg
    join public.tenants t on t.id = msg.tenant_id
    where msg.body_purged_at is null
      and msg.received_at < now() - make_interval(days => t.retention_days)
  )
  update public.messages msg
  set body_text = null, subject = null, from_name = null, attachment_meta = '[]'::jsonb,
      body_purged_at = now()
  from expired where msg.id = expired.id;
  get diagnostics m = row_count;

  update public.message_processing p
  set classification = null, model_output = null, order_lookup = null, error = null
  from public.messages msg
  where msg.id = p.message_id and msg.body_purged_at is not null
    and (p.classification is not null or p.model_output is not null or p.order_lookup is not null);

  update public.threads th set subject = null
  from public.tenants t
  where t.id = th.tenant_id and th.subject is not null
    and coalesce(th.last_inbound_at, th.created_at) < now() - make_interval(days => t.retention_days)
    and coalesce(th.last_outbound_at, th.created_at) < now() - make_interval(days => t.retention_days);

  with expired as (
    select dr.id from public.drafts dr
    join public.tenants t on t.id = dr.tenant_id
    where dr.body_purged_at is null
      and dr.created_at < now() - make_interval(days => t.retention_days)
  )
  update public.drafts dr
  set body = null, subject = '[deleted]', body_purged_at = now()
  from expired where dr.id = expired.id;
  get diagnostics d = row_count;

  update public.outbound_emails o set subject = '[deleted]', smtp_response = null, error = null
  from public.tenants t
  where t.id = o.tenant_id and o.subject <> '[deleted]'
    and o.created_at < now() - make_interval(days => t.retention_days);

  update public.escalations e set summary = null
  from public.tenants t
  where t.id = e.tenant_id and e.summary is not null
    and e.created_at < now() - make_interval(days => t.retention_days);

  -- Delivered or failed notifications carry subjects and summaries.
  delete from public.notifications nt
  using public.tenants t
  where t.id = nt.tenant_id and nt.status <> 'pending'
    and nt.created_at < now() - make_interval(days => least(t.retention_days, 30));
  get diagnostics n = row_count;

  return query select m, d, n;
end
$$;
revoke all on function app.purge_expired_content() from public;
grant execute on function app.purge_expired_content() to noctiv_worker;
