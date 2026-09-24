-- Step 11: follow-up engine (PLAN.md §4.6).
-- Threads due for a follow-up across tenants, identifiers only. The worker
-- re-checks everything inside the tenant's RLS context before generating.
create function app.due_followups(p_limit integer)
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
    and c.status = 'connected'
  order by th.next_followup_at
  limit least(greatest(p_limit, 1), 1000)
$$;
revoke all on function app.due_followups(integer) from public;
grant execute on function app.due_followups(integer) to noctiv_worker;
