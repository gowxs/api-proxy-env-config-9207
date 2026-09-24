-- Step 13: operations.
--  * hourly maintenance: budget states back to 'ok' once a new UTC day has
--    started (usage is per day), old health-check rows removed.
create function app.hourly_maintenance()
returns table (budgets_reset integer, health_checks_deleted integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  b integer;
  h integer;
begin
  update public.tenants t
  set budget_state = 'ok'
  where t.budget_state <> 'ok'
    and coalesce((select u.tokens_in + u.tokens_out + u.embed_tokens from public.usage_daily u
                  where u.tenant_id = t.id and u.day = (now() at time zone 'utc')::date), 0) < t.daily_token_budget;
  get diagnostics b = row_count;
  delete from public.connection_health_checks where checked_at < now() - interval '30 days';
  get diagnostics h = row_count;
  return query select b, h;
end
$$;
revoke all on function app.hourly_maintenance() from public;
grant execute on function app.hourly_maintenance() to noctiv_worker;
