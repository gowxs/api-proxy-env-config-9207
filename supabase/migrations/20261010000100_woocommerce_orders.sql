-- WooCommerce order lookup (WISMO), read-only: orders are fetched live from the merchant's own
-- store with a REST key (consumer key + secret) the merchant created with Read access.
-- Only the connection is stored; the key pair is sealed with the credentials public key
-- (the API can seal but never open; only the worker opens). Associated data:
-- noctiv:woocommerce_credentials:v1:<store url>. The per-message summary is the existing
-- message_processing.order_lookup column (it has a "platform" field).

create table public.woocommerce_connections (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  store_url text not null check (store_url ~ '^https://[a-z0-9.-]+(/[A-Za-z0-9._~-]+)*$' and char_length(store_url) <= 300),
  credentials_ciphertext bytea not null,
  credentials_key_id text not null,
  store_name text check (char_length(store_name) <= 200),
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error_code text check (char_length(last_error_code) <= 40),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.woocommerce_connections
  for each row execute function app.set_updated_at();
alter table public.woocommerce_connections enable row level security;
alter table public.woocommerce_connections force row level security;
create policy runtime_tenant_isolation on public.woocommerce_connections
  as permissive for all to noctiv_api, noctiv_worker
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
-- Signed-in owners (Supabase client) may see the connection but never the sealed keys.
create policy member_tenant_access on public.woocommerce_connections
  as permissive for select to authenticated
  using (tenant_id in (select app.user_tenant_ids()));
revoke all on public.woocommerce_connections from anon, authenticated;
grant select (tenant_id, store_url, store_name, status, last_error_code, last_checked_at, created_at, updated_at)
  on public.woocommerce_connections to authenticated, noctiv_api;
-- The API seals the pasted key and stores it; it can never read it back.
grant insert (tenant_id, store_url, credentials_ciphertext, credentials_key_id, store_name, status, last_error_code, last_checked_at)
  on public.woocommerce_connections to noctiv_api;
grant update (store_url, credentials_ciphertext, credentials_key_id, store_name, status, last_error_code, last_checked_at)
  on public.woocommerce_connections to noctiv_api;
-- "Disconnect and delete keys": the row, with the sealed keys, is deleted.
grant delete on public.woocommerce_connections to noctiv_api;
grant select, update, delete on public.woocommerce_connections to noctiv_worker;
