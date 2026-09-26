-- Founder decisions after the QA pass (2026-09-26), QA.md D2/D5/D6.
set local search_path = public, extensions;

-- D2: UK sellers are paid by sort code and account number (no IBAN needed).
alter table public.tenants
  add column seller_sort_code text check (seller_sort_code ~ '^[0-9]{6}$'),
  add column seller_account_number text check (seller_account_number ~ '^[0-9]{8}$');
grant update (seller_sort_code, seller_account_number) on public.tenants to noctiv_api;

-- D5: replies waiting on the AI provider's daily quota. A quota wait does
-- not use up a message's retries (the job would otherwise die after ~5
-- hourly retries and the customer never get an answer); it keeps waiting
-- for up to 26 hours after the message arrived.
create or replace function app.fail_job(p_id uuid, p_error text, p_retry_in_seconds integer, p_retryable boolean)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  update public.jobs
  set status = case
        when p_retryable and attempts < max_attempts then 'queued'
        when p_retryable and p_error like 'model call failed: quota_exhausted%'
             and created_at > now() - interval '26 hours' then 'queued'
        else 'dead' end,
      run_at = now() + make_interval(secs => greatest(p_retry_in_seconds, 0)),
      locked_until = null,
      last_error = left(p_error, 500)
  where id = p_id
  returning status
$$;

-- Per tenant: the oldest customer e-mail waiting on the quota, and how many wait.
create function app.quota_waits()
returns table (tenant_id uuid, since timestamptz, waiting integer)
language sql
stable
security definer
set search_path = ''
as $$
  select j.tenant_id, min(j.created_at), count(*)::int
  from public.jobs j
  where j.queue = 'mail.process' and j.status in ('queued', 'running')
    and j.last_error like 'model call failed: quota_exhausted%'
  group by j.tenant_id
$$;
revoke all on function app.quota_waits() from public;
grant execute on function app.quota_waits() to noctiv_worker;
