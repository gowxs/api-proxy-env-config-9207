-- Noctiv foundation: extensions, runtime roles, helper schema and functions.
-- Runs as the schema owner (`postgres` on Supabase).

create extension if not exists vector with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Runtime roles. Created NOLOGIN; each environment sets a password out of band:
--   alter role noctiv_api with login password '...';
-- Neither role owns tables and neither can bypass RLS.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'noctiv_api') then
    create role noctiv_api nologin noinherit nobypassrls nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'noctiv_worker') then
    create role noctiv_worker nologin noinherit nobypassrls nocreatedb nocreaterole;
  end if;
end
$$;

-- Make sure nothing inherited ever lets them skip RLS.
alter role noctiv_api nobypassrls;
alter role noctiv_worker nobypassrls;

grant usage on schema public to noctiv_api, noctiv_worker;
grant usage on schema extensions to noctiv_api, noctiv_worker;

-- ---------------------------------------------------------------------------
-- Supabase grants every privilege on new public tables/functions/sequences to
-- anon and authenticated by default. We opt out: every grant is explicit.
-- ---------------------------------------------------------------------------
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- Helper schema (not exposed through PostgREST).
-- ---------------------------------------------------------------------------
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, noctiv_api, noctiv_worker;
alter default privileges for role postgres in schema app revoke all on functions from public;

-- Tenant context for runtime roles. Set per transaction by withTenant():
--   select set_config('app.tenant_id', '<uuid>', true);
-- Unset => NULL => every tenant policy evaluates to false => zero rows.
create function app.current_tenant_id()
returns uuid
language sql
stable
set search_path = ''
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create function app.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

-- True when tz is a time zone name Postgres understands (e.g. 'Europe/Riga').
create function app.is_valid_timezone(tz text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
begin
  if tz is null or tz = '' then
    return false;
  end if;
  perform pg_catalog.timezone(tz, timestamptz '2000-01-01 00:00:00+00');
  return true;
exception when others then
  return false;
end
$$;

revoke all on function app.current_tenant_id() from public;
revoke all on function app.set_updated_at() from public;
revoke all on function app.is_valid_timezone(text) from public;
grant execute on function app.current_tenant_id() to noctiv_api, noctiv_worker;
grant execute on function app.is_valid_timezone(text) to noctiv_api, noctiv_worker;
