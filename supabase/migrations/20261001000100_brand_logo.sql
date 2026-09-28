-- Uploaded logo (founder request 2026-10-01): one per business, kept in the
-- database as a PNG resized to at most 400 px (PNG, JPEG or SVG uploads of at
-- most 500 KB; SVG is rendered to PNG, never served as SVG). Used on quote,
-- invoice and delivery-note PDFs, e-mail designs 3–5 (inline, Content-ID)
-- and the customer's Accept page. The logo address (brand_logo_url) stays as
-- the option for those who have one; an uploaded logo wins.
set local search_path = public, extensions;

create table public.tenant_logos (
  tenant_id uuid primary key references public.tenants (id) on delete cascade,
  png bytea not null check (octet_length(png) between 8 and 600 * 1024),
  width integer not null check (width between 1 and 400),
  height integer not null check (height between 1 and 400),
  -- What the owner uploaded (the stored image is always PNG).
  source_type text not null check (source_type in ('png', 'jpeg', 'svg')),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger set_updated_at before update on public.tenant_logos
  for each row execute function app.set_updated_at();

alter table public.tenant_logos enable row level security;
alter table public.tenant_logos force row level security;
create policy runtime_tenant_isolation on public.tenant_logos
  as permissive for all to noctiv_api, noctiv_worker
  using (tenant_id = (select app.current_tenant_id()))
  with check (tenant_id = (select app.current_tenant_id()));
-- Same shape as every tenant table; no grants to authenticated, so unused today.
create policy member_tenant_access on public.tenant_logos
  as permissive for all to authenticated
  using (tenant_id in (select app.user_tenant_ids()))
  with check (tenant_id in (select app.user_tenant_ids()));

revoke all on public.tenant_logos from anon, authenticated;
grant select, insert, update, delete on public.tenant_logos to noctiv_api;
grant select on public.tenant_logos to noctiv_worker;
