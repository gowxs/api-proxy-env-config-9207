-- Monitoring (founder request 2026-09-27), PLAN.md §25: worker heartbeat,
-- the health view behind GET /healthz/worker, and the admin daily digest.
-- Everything here is operator data: counts and timestamps, no e-mail
-- content, reached by the runtime roles only through these functions.
set local search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- Worker heartbeat: each worker process writes its row every minute.
-- ---------------------------------------------------------------------------
create table app.worker_heartbeats (
  worker text primary key check (char_length(worker) between 1 and 100),
  started_at timestamptz not null,
  beat_at timestamptz not null default now()
);
revoke all on app.worker_heartbeats from public;

create function app.worker_beat(p_worker text, p_started_at timestamptz)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  insert into app.worker_heartbeats (worker, started_at, beat_at)
  values (p_worker, p_started_at, now())
  on conflict (worker) do update set started_at = excluded.started_at, beat_at = now();
  -- Rows of replaced workers (each deploy gets a new host name).
  delete from app.worker_heartbeats where beat_at < now() - interval '1 day';
$$;
revoke all on function app.worker_beat(text, timestamptz) from public;
grant execute on function app.worker_beat(text, timestamptz) to noctiv_worker;

-- For GET /healthz/worker: the newest heartbeat and the connected mailboxes
-- whose last health check (or creation, before the first one) is older than
-- the given age. Counts only.
create function app.worker_health(p_mailbox_max_age interval)
returns table (last_beat timestamptz, connected integer, unchecked integer)
language sql
stable
security definer
set search_path = ''
as $$
  select (select max(beat_at) from app.worker_heartbeats),
         (select count(*)::int from public.email_connections c
          join public.tenants t on t.id = c.tenant_id
          where c.status = 'connected' and t.status = 'active'),
         (select count(*)::int from public.email_connections c
          join public.tenants t on t.id = c.tenant_id
          where c.status = 'connected' and t.status = 'active'
            and coalesce(c.last_checked_at, c.created_at) < now() - p_mailbox_max_age)
$$;
revoke all on function app.worker_health(interval) from public;
grant execute on function app.worker_health(interval) to noctiv_api, noctiv_worker;

-- ---------------------------------------------------------------------------
-- Admin daily digest: one e-mail per Riga day, claimed so that two workers
-- never both send it; a failed send is retried (10 min apart, 5 times).
-- ---------------------------------------------------------------------------
create table app.admin_digests (
  day date primary key,
  attempts integer not null default 1,
  last_attempt_at timestamptz not null default now(),
  sent_at timestamptz
);
revoke all on app.admin_digests from public;

create function app.admin_digest_claim(p_day date)
returns boolean
language sql
volatile
security definer
set search_path = ''
as $$
  insert into app.admin_digests as d (day) values (p_day)
  on conflict (day) do update set attempts = d.attempts + 1, last_attempt_at = now()
    where d.sent_at is null and d.attempts < 5 and d.last_attempt_at < now() - interval '10 minutes'
  returning true
$$;

create function app.admin_digest_sent(p_day date)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update app.admin_digests set sent_at = now() where day = p_day
$$;

-- The numbers for one window [p_from, p_to). Gemini usage is per UTC day
-- (usage_daily): the UTC day p_usage_day.
create function app.admin_digest_stats(p_from timestamptz, p_to timestamptz, p_usage_day date)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'tenants', (select jsonb_build_object(
        'active', count(*) filter (where status = 'active'),
        'new', count(*) filter (where created_at >= p_from and created_at < p_to),
        'onboarded', count(*) filter (where status = 'active' and onboarding_completed_at is not null),
        'trial', count(*) filter (where status = 'active' and billing_status in ('trial', 'trialing')),
        'paying', count(*) filter (where status = 'active' and billing_status = 'active'),
        'past_due', count(*) filter (where status = 'active' and billing_status = 'past_due'),
        'canceled', count(*) filter (where status = 'active' and billing_status in ('canceled', 'paused')),
        'comped', count(*) filter (where status = 'active' and billing_status = 'comped'))
      from public.tenants),
    'emails', (select jsonb_build_object(
        'processed', count(*) filter (where status <> 'queued'),
        'drafted', count(*) filter (where status = 'drafted'),
        'auto_sent', count(*) filter (where status = 'auto_sent' or final_action = 'auto_send'),
        'escalated', count(*) filter (where status = 'escalated'),
        'skipped', count(*) filter (where status = 'skipped'),
        'failed', count(*) filter (where status = 'failed'),
        'still_queued', count(*) filter (where status = 'queued'))
      from public.message_processing where created_at >= p_from and created_at < p_to),
    'sent', (select jsonb_build_object(
        'auto', count(*) filter (where sent_via = 'auto'),
        'approved', count(*) filter (where sent_via = 'owner_approval'),
        'failed', (select count(*) from public.outbound_emails
                   where status = 'failed' and updated_at >= p_from and updated_at < p_to))
      from public.outbound_emails
      where status = 'sent' and sent_at >= p_from and sent_at < p_to),
    'escalations', (select jsonb_build_object(
        'new', count(*) filter (where created_at >= p_from and created_at < p_to),
        'open', count(*) filter (where resolved_at is null))
      from public.escalations),
    'quota', jsonb_build_object(
        'alerts', (select count(*) from public.notifications
                   where kind = 'quota_wait' and created_at >= p_from and created_at < p_to),
        'waiting_now', (select count(*) from public.jobs
                        where queue = 'mail.process' and status in ('queued', 'running')
                          and last_error like 'model call failed: quota_exhausted%')),
    'jobs', jsonb_build_object(
        'dead', coalesce((select jsonb_object_agg(queue, n) from (
                   select queue, count(*) as n from public.jobs
                   where status = 'dead' and updated_at >= p_from and updated_at < p_to
                   group by queue) q), '{}'::jsonb),
        'backlog', (select count(*) from public.jobs
                    where status = 'queued' and run_at < now() - interval '15 minutes')),
    'mailboxes', (select jsonb_build_object(
        'connected', count(*) filter (where status = 'connected'),
        'disconnected', count(*) filter (where status <> 'connected'),
        'disconnects', (select count(*) from public.notifications
                        where kind = 'mailbox_disconnected' and channel = 'email_admin'
                          and created_at >= p_from and created_at < p_to),
        'unhealthy_alerts', (select count(*) from public.notifications
                             where kind = 'mailbox_unhealthy'
                               and created_at >= p_from and created_at < p_to))
      from public.email_connections),
    'usage', (select jsonb_build_object(
        'day', p_usage_day,
        'llm_calls', coalesce(sum(llm_calls), 0),
        'tokens_in', coalesce(sum(tokens_in), 0),
        'tokens_out', coalesce(sum(tokens_out), 0),
        'embed_tokens', coalesce(sum(embed_tokens), 0),
        'est_cost_micro_eur', coalesce(sum(est_cost_micro_eur), 0),
        'halted_tenants', (select count(*) from public.tenants where budget_state = 'halted'))
      from public.usage_daily where day = p_usage_day),
    'waitlist', (select jsonb_build_object(
        'new', count(*) filter (where created_at >= p_from and created_at < p_to),
        'confirmed', count(*) filter (where confirmed_at >= p_from and confirmed_at < p_to),
        'total_confirmed', count(*) filter (where status = 'confirmed'))
      from marketing.waitlist),
    -- The busiest accounts of the window (business names only).
    'top_tenants', coalesce((select jsonb_agg(x order by x.processed desc) from (
        select t.name, count(*) as processed,
               count(*) filter (where mp.status = 'auto_sent' or mp.final_action = 'auto_send') as auto_sent,
               count(*) filter (where mp.status = 'escalated') as escalated
        from public.message_processing mp join public.tenants t on t.id = mp.tenant_id
        where mp.created_at >= p_from and mp.created_at < p_to and mp.status <> 'queued'
        group by t.name order by count(*) desc limit 10) x), '[]'::jsonb)
  )
$$;

revoke all on function app.admin_digest_claim(date) from public;
revoke all on function app.admin_digest_sent(date) from public;
revoke all on function app.admin_digest_stats(timestamptz, timestamptz, date) from public;
grant execute on function app.admin_digest_claim(date) to noctiv_worker;
grant execute on function app.admin_digest_sent(date) to noctiv_worker;
grant execute on function app.admin_digest_stats(timestamptz, timestamptz, date) to noctiv_worker;
