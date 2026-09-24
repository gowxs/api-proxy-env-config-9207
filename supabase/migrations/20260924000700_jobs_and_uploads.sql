-- Step 6-8 infrastructure.
--  * jobs: a small Postgres job queue (SKIP LOCKED) replacing pg-boss, whose
--    runtime DDL (a partition per queue) needs owner rights our runtime roles
--    must not have. Tenant-scoped like every other table; the worker claims
--    across tenants only through narrow SECURITY DEFINER functions.
--  * kb_uploads: founder decision (step 5 report): original files are not
--    kept. An upload waits here until its text is extracted, then is deleted.
--    Replaces Supabase Storage (kb_sources.storage_path is dropped).

set local search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  queue text not null check (queue ~ '^[a-z][a-z0-9_.]{1,62}$'),
  payload jsonb not null default '{}'::jsonb,
  -- At most one queued/running job per (queue, singleton_key).
  singleton_key text,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'dead')),
  attempts integer not null default 0,
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  run_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index jobs_singleton_idx on public.jobs (queue, singleton_key)
  where singleton_key is not null and status in ('queued', 'running');
create index jobs_ready_idx on public.jobs (queue, run_at) where status in ('queued', 'running');
create index jobs_tenant_idx on public.jobs (tenant_id, created_at desc);
create trigger set_updated_at before update on public.jobs for each row execute function app.set_updated_at();

-- ---------------------------------------------------------------------------
-- Uploads waiting for text extraction (never kept after ingestion)
-- ---------------------------------------------------------------------------
create table public.kb_uploads (
  source_id uuid primary key,
  tenant_id uuid not null,
  bytes bytea not null check (octet_length(bytes) between 1 and 10485760),
  mime_type text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, source_id) references public.kb_sources (tenant_id, id) on delete cascade
);
create index kb_uploads_age_idx on public.kb_uploads (created_at);

alter table public.kb_sources drop column storage_path cascade;

-- ---------------------------------------------------------------------------
-- RLS + policies (same shape as every other table)
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['jobs', 'kb_uploads'] loop
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

revoke all on public.jobs, public.kb_uploads from anon, authenticated;
-- API: enqueue and read results of its own tenant's jobs; stage uploads.
grant select, insert on public.jobs to noctiv_api;
grant insert on public.kb_uploads to noctiv_api;
-- Worker: full DML within a tenant.
grant select, insert, update, delete on public.jobs, public.kb_uploads to noctiv_worker;

-- ---------------------------------------------------------------------------
-- Cross-tenant worker functions (identifiers + payload only)
-- ---------------------------------------------------------------------------
create function app.claim_jobs(p_queues text[], p_limit integer, p_lease_seconds integer)
returns table (id uuid, tenant_id uuid, queue text, payload jsonb, attempts integer, max_attempts integer)
language sql
volatile
security definer
set search_path = ''
as $$
  with next as (
    select j.id
    from public.jobs j
    where j.queue = any (p_queues)
      and j.run_at <= now()
      and (j.status = 'queued' or (j.status = 'running' and j.locked_until < now()))
    order by j.run_at
    limit least(greatest(p_limit, 1), 100)
    for update skip locked
  )
  update public.jobs j
  set status = 'running',
      attempts = j.attempts + 1,
      locked_until = now() + make_interval(secs => greatest(p_lease_seconds, 5))
  from next
  where j.id = next.id
  returning j.id, j.tenant_id, j.queue, j.payload, j.attempts, j.max_attempts
$$;

create function app.finish_job(p_id uuid, p_result jsonb)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update public.jobs set status = 'done', result = p_result, locked_until = null, last_error = null
  where id = p_id and status = 'running'
$$;

-- Retry with the given delay, or mark dead once attempts are used up.
create function app.fail_job(p_id uuid, p_error text, p_retry_in_seconds integer, p_retryable boolean)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  update public.jobs
  set status = case when p_retryable and attempts < max_attempts then 'queued' else 'dead' end,
      run_at = now() + make_interval(secs => greatest(p_retry_in_seconds, 0)),
      locked_until = null,
      last_error = left(p_error, 500)
  where id = p_id
  returning status
$$;

revoke all on function app.claim_jobs(text[], integer, integer) from public;
revoke all on function app.finish_job(uuid, jsonb) from public;
revoke all on function app.fail_job(uuid, text, integer, boolean) from public;
grant execute on function app.claim_jobs(text[], integer, integer) to noctiv_worker;
grant execute on function app.finish_job(uuid, jsonb) to noctiv_worker;
grant execute on function app.fail_job(uuid, text, integer, boolean) to noctiv_worker;
