-- Step 12: web app support.
-- Tenants a signed-in user belongs to, for the API (runtime roles cannot read
-- memberships across tenants). Identifiers and names only.
create function app.user_tenants(p_user_id uuid)
returns table (tenant_id uuid, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, t.name
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = p_user_id and t.status = 'active'
  order by m.created_at
$$;
revoke all on function app.user_tenants(uuid) from public;
grant execute on function app.user_tenants(uuid) to noctiv_api;

-- Onboarding wizard finished (the summary step); the dashboard is shown after that.
alter table public.tenants add column onboarding_completed_at timestamptz;
grant update (onboarding_completed_at) on public.tenants to noctiv_api;
