-- Free-tier safety: database keep-alive, database size for the admin digest,
-- and a credential-free export of the business tables for the weekly
-- encrypted e-mail backup. Worker-only; no tenant-facing access.

-- One row per scheduled operation (keepalive, export_mail): when it last ran
-- and last succeeded, so a restart or a second worker never repeats it early.
create table app.ops_runs (
  job         text primary key,
  last_run_at timestamptz not null default 'epoch',
  last_ok_at  timestamptz,
  last_detail text
);
revoke all on app.ops_runs from public;

-- True for exactly one caller when the job is due; that caller has claimed it.
create function app.ops_claim(p_job text, p_min_age interval)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_claimed boolean;
begin
  insert into app.ops_runs (job) values (p_job) on conflict (job) do nothing;
  update app.ops_runs set last_run_at = now()
   where job = p_job and last_run_at <= now() - p_min_age
  returning true into v_claimed;
  return coalesce(v_claimed, false);
end $$;

-- A failed run is due again at the next check (a success keeps its time).
create function app.ops_done(p_job text, p_ok boolean, p_detail text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update app.ops_runs
     set last_ok_at = case when p_ok then now() else last_ok_at end,
         last_run_at = case when p_ok then last_run_at else 'epoch' end,
         last_detail = left(p_detail, 500)
   where job = p_job;
$$;

create function app.ops_status()
returns table (job text, last_run_at timestamptz, last_ok_at timestamptz, last_detail text)
language sql
stable
security definer
set search_path = ''
as $$ select job, last_run_at, last_ok_at, last_detail from app.ops_runs order by job; $$;

-- The trivial write + read that counts as database activity: writes the time,
-- reads it back, returns what was read.
create table app.keepalive (id int primary key check (id = 1), at timestamptz not null);
revoke all on app.keepalive from public;

create function app.keepalive_ping()
returns timestamptz
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare v_at timestamptz;
begin
  insert into app.keepalive (id, at) values (1, now())
  on conflict (id) do update set at = now();
  select at into v_at from app.keepalive where id = 1;
  return v_at;
end $$;

-- What the free plan limit counts: the size of the database.
create function app.db_size_bytes()
returns bigint
language sql
stable
security definer
set search_path = ''
as $$ select pg_database_size(current_database()); $$;

-- The business tables as JSON, without credentials or e-mail text: message
-- rows carry only metadata (no body), mailbox rows no login or sealed secret.
create function app.backup_export(p_table text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_deny text[];
  v_cols text;
  v_result jsonb;
begin
  v_deny := case p_table
    when 'messages' then array['body_text', 'html_hidden_text']
    when 'email_connections' then array['username', 'credentials_ciphertext', 'credentials_key_id']
    else null end;
  if v_deny is null and p_table not in (
    'tenants', 'tenant_members', 'leads', 'lead_events', 'threads', 'kb_sources', 'price_items',
    'quotes', 'quote_lines', 'documents', 'booking_settings', 'bookings', 'intake_forms'
  ) then
    raise exception 'table % is not exportable', p_table;
  end if;
  select string_agg(format('%I', column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = p_table
     and (v_deny is null or column_name <> all (v_deny));
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (select %s from public.%I) t',
    v_cols, p_table) into v_result;
  return v_result;
end $$;

revoke all on function app.ops_claim(text, interval), app.ops_done(text, boolean, text),
  app.ops_status(), app.keepalive_ping(), app.db_size_bytes(), app.backup_export(text) from public;
grant execute on function app.ops_claim(text, interval), app.ops_done(text, boolean, text),
  app.ops_status(), app.keepalive_ping(), app.db_size_bytes(), app.backup_export(text)
  to noctiv_worker;
