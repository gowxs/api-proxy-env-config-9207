-- Trial reminder e-mails to the owner, 7 days and 1 day before the in-app
-- trial ends (founder decision 2026-09-25). The worker calls this hourly.
--  * 'trial_ending_7': 1 day < time left <= 7 days;
--  * 'trial_ending_1': time left <= 1 day (and the trial not over yet).
-- One of each per trial end date (dedupe key), so an extended trial gets
-- fresh reminders; a tenant that is already inside the last day only gets
-- the 1-day one. Subscribed, comped or deleted tenants get none.
create function app.queue_trial_reminders()
returns integer
language sql
volatile
security definer
set search_path = ''
as $$
  with due as (
    select t.id, t.trial_ends_at, t.timezone,
           case when t.trial_ends_at - now() <= interval '1 day' then 1 else 7 end as stage
    from public.tenants t
    where t.status = 'active'
      and t.billing_status = 'trial'
      and t.trial_ends_at > now()
      and t.trial_ends_at - now() <= interval '7 days'
  ),
  ins as (
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    select d.id, 'email_owner', 'trial_ending',
           'trial_ending_' || d.stage || ':' || to_char(d.trial_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'),
           jsonb_build_object(
             'stage', d.stage,
             'endsAt', to_char(d.trial_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'daysLeft', ceil(extract(epoch from d.trial_ends_at - now()) / 86400)::int,
             'timezone', d.timezone)
    from due d
    on conflict (tenant_id, dedupe_key) do nothing
    returning 1
  )
  select count(*)::int from ins
$$;
revoke all on function app.queue_trial_reminders() from public;
grant execute on function app.queue_trial_reminders() to noctiv_worker;
