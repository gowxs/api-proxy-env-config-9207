-- Value reporting (founder request 2026-09-28), PLAN.md §26: the owner's
-- assumptions for "hours saved", and the Monday summary e-mail.
set local search_path = public, extensions;

alter table public.tenants
  add column value_minutes_per_reply smallint not null default 4
    check (value_minutes_per_reply between 1 and 60),
  add column value_minutes_per_followup smallint not null default 3
    check (value_minutes_per_followup between 0 and 60),
  add column weekly_report_enabled boolean not null default true,
  -- The Monday (local date) of the last week the summary was sent or skipped for.
  add column weekly_report_last_week date;
grant update (value_minutes_per_reply, value_minutes_per_followup, weekly_report_enabled)
  on public.tenants to noctiv_api;

-- Businesses that get the Monday summary: active, set up, entitled, not unsubscribed.
create function app.weekly_report_tenants()
returns table (tenant_id uuid, timezone text, last_week date)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.timezone, t.weekly_report_last_week
  from public.tenants t
  where t.status = 'active' and t.weekly_report_enabled
    and t.onboarding_completed_at is not null
    and app.billing_entitled(t.billing_status, t.trial_ends_at)
$$;
revoke all on function app.weekly_report_tenants() from public;
grant execute on function app.weekly_report_tenants() to noctiv_worker;
