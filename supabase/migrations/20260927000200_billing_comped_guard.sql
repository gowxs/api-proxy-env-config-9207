-- A comped tenant stays comped whatever Paddle reports (found in the live
-- checkout test 2026-09-27: the scheduled end of a cancelled subscription
-- would have switched a comped business off). Only the status line and the
-- result differ from 20260925000200_billing.sql.
create or replace function app.paddle_apply_subscription(
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
       -- An operator's "free of charge" is never changed by Paddle events
       -- (for example the final cancel of a test subscription); the
       -- subscription details are still recorded.
       set billing_status = case when v_current_status = 'comped' then 'comped' else p_status end,
           paddle_subscription_id = p_subscription_id,
           paddle_customer_id = coalesce(p_customer_id, paddle_customer_id),
           billing_period_ends_at = p_period_ends_at,
           billing_cancels_at = p_cancels_at,
           billing_event_at = p_occurred_at,
           billing_resumed_at = case
             when not v_was_entitled and app.billing_entitled(p_status, trial_ends_at) then now()
             else billing_resumed_at end
     where id = v_tenant;
    v_result := case when v_current_status = 'comped' then 'applied_comped' else 'applied' end;
  end if;

  insert into public.audit_log (tenant_id, actor, action, target_type, metadata)
  values (v_tenant, 'system', 'billing.' || p_event_type, 'tenant',
          jsonb_build_object('event_id', p_event_id, 'subscription_id', p_subscription_id,
                             'status', p_status, 'result', v_result, 'occurred_at', p_occurred_at));
  return v_result;
end
$$;
