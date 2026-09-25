-- Subscriptions with Paddle Billing (merchant of record), founder decision 2026-09-25.
--  * One plan; the 14-day trial lives in the app (no card): trial_ends_at.
--  * Paddle webhooks set billing_status through app.paddle_apply_subscription()
--    (the API's only way to write them: it has no update grant on these columns).
--  * A tenant is served while app.billing_entitled() is true; otherwise the
--    worker stops reading and answering its mail. Data is kept.

alter table public.tenants
  add column trial_ends_at timestamptz not null default now() + interval '14 days',
  add column billing_status text not null default 'trial'
    check (billing_status in ('trial', 'trialing', 'active', 'past_due', 'paused', 'canceled', 'comped')),
  add column paddle_customer_id text,
  add column paddle_subscription_id text unique,
  add column billing_period_ends_at timestamptz,
  -- Set while a cancellation is scheduled for the end of the paid period.
  add column billing_cancels_at timestamptz,
  add column billing_event_at timestamptz,
  -- When service came back after a lapse: mail that arrived while it was
  -- stopped is still read, but only ever drafted for approval.
  add column billing_resumed_at timestamptz;

-- Existing businesses get their 14 days from sign-up.
update public.tenants set trial_ends_at = created_at + interval '14 days';

comment on column public.tenants.billing_status is
  'trial = in-app free trial (no subscription yet); trialing/active/past_due/paused/canceled mirror the Paddle subscription; comped = free of charge, set by an operator';

-- ---------------------------------------------------------------------------
-- Entitlement: who is served. past_due keeps service while Paddle retries the
-- payment (dunning); Paddle then cancels or pauses, which stops service.
-- ---------------------------------------------------------------------------
create function app.billing_entitled(p_status text, p_trial_ends_at timestamptz)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_status in ('active', 'trialing', 'past_due', 'comped')
      or (p_status = 'trial' and now() < p_trial_ends_at)
$$;
revoke all on function app.billing_entitled(text, timestamptz) from public;
grant execute on function app.billing_entitled(text, timestamptz) to noctiv_api, noctiv_worker;

-- Mailboxes the worker listens to: active tenants that are entitled.
drop function app.list_mail_connections(text[]);
create function app.list_mail_connections(p_statuses text[] default array['connected'])
returns table (tenant_id uuid, connection_id uuid, is_test_mailbox boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select c.tenant_id, c.id, c.is_test_mailbox
  from public.email_connections c
  join public.tenants t on t.id = c.tenant_id
  where t.status = 'active'
    and app.billing_entitled(t.billing_status, t.trial_ends_at)
    and c.status = any (p_statuses)
$$;
revoke all on function app.list_mail_connections(text[]) from public;
grant execute on function app.list_mail_connections(text[]) to noctiv_worker;

-- Follow-ups: same rule.
create or replace function app.due_followups(p_limit integer)
returns table (tenant_id uuid, thread_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select th.tenant_id, th.id
  from public.threads th
  join public.tenants t on t.id = th.tenant_id
  join public.email_connections c on c.id = th.connection_id
  where th.status = 'awaiting_customer'
    and th.next_followup_at <= now()
    and th.followups_sent < t.followup_max
    and t.status = 'active'
    and app.billing_entitled(t.billing_status, t.trial_ends_at)
    and c.status = 'connected'
  order by th.next_followup_at
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke all on function app.due_followups(integer) from public;
grant execute on function app.due_followups(integer) to noctiv_worker;

-- ---------------------------------------------------------------------------
-- Paddle subscription webhook → tenant. Called by the API after it verified
-- the Paddle-Signature. Idempotent and order-safe:
--  * the tenant is found by subscription id, then the tenant id Noctiv put in
--    the checkout's custom data, then the Paddle customer id;
--  * an event older than the last applied one for the same subscription is
--    ignored (Paddle does not guarantee delivery order);
--  * a late event for an old subscription never overrides a newer one.
-- Every call is written to the audit log.
-- ---------------------------------------------------------------------------
create function app.paddle_apply_subscription(
  p_event_id text,
  p_event_type text,
  p_occurred_at timestamptz,
  p_subscription_id text,
  p_customer_id text,
  p_status text,
  p_tenant_hint uuid,
  p_period_ends_at timestamptz,
  p_cancels_at timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_current_sub text;
  v_current_status text;
  v_last_at timestamptz;
  v_was_entitled boolean;
  v_result text;
begin
  if p_status not in ('trialing', 'active', 'past_due', 'paused', 'canceled') then
    return 'ignored_status';
  end if;

  select id into v_tenant from public.tenants where paddle_subscription_id = p_subscription_id;
  if v_tenant is null and p_tenant_hint is not null then
    select id into v_tenant from public.tenants where id = p_tenant_hint;
  end if;
  if v_tenant is null and p_customer_id is not null then
    select id into v_tenant from public.tenants where paddle_customer_id = p_customer_id limit 1;
  end if;
  if v_tenant is null then
    return 'unknown_tenant';
  end if;

  select paddle_subscription_id, billing_status, billing_event_at,
         app.billing_entitled(billing_status, trial_ends_at)
    into v_current_sub, v_current_status, v_last_at, v_was_entitled
  from public.tenants where id = v_tenant for update;

  if v_current_sub is not null and v_current_sub <> p_subscription_id
     and v_current_status in ('active', 'trialing', 'past_due')
     and p_status in ('canceled', 'paused', 'past_due') then
    -- A late event about an older subscription: the current one wins.
    v_result := 'ignored_other_subscription';
  elsif v_current_sub = p_subscription_id and v_last_at is not null and p_occurred_at < v_last_at then
    v_result := 'stale';
  else
    update public.tenants
       set billing_status = p_status,
           paddle_subscription_id = p_subscription_id,
           paddle_customer_id = coalesce(p_customer_id, paddle_customer_id),
           billing_period_ends_at = p_period_ends_at,
           billing_cancels_at = p_cancels_at,
           billing_event_at = p_occurred_at,
           billing_resumed_at = case
             when not v_was_entitled and app.billing_entitled(p_status, trial_ends_at) then now()
             else billing_resumed_at end
     where id = v_tenant;
    v_result := 'applied';
  end if;

  insert into public.audit_log (tenant_id, actor, action, target_type, metadata)
  values (v_tenant, 'system', 'billing.' || p_event_type, 'tenant',
          jsonb_build_object('event_id', p_event_id, 'subscription_id', p_subscription_id,
                             'status', p_status, 'result', v_result, 'occurred_at', p_occurred_at));
  return v_result;
end
$$;
revoke all on function app.paddle_apply_subscription(text, text, timestamptz, text, text, text, uuid, timestamptz, timestamptz) from public;
grant execute on function app.paddle_apply_subscription(text, text, timestamptz, text, text, text, uuid, timestamptz, timestamptz) to noctiv_api;
