-- Step 14: GDPR — retention purge and hard delete (PLAN.md §4.7).

-- ---------------------------------------------------------------------------
-- Retention: email content older than the tenant's retention_days (default
-- 90) is removed. Kept: Message-IDs (dedupe), addresses needed for threads
-- and leads, statuses, timestamps, token counts. The knowledge base is the
-- tenant's own business content and is not affected.
-- ---------------------------------------------------------------------------
create function app.purge_expired_content()
returns table (messages_purged integer, drafts_purged integer, notifications_deleted integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  m integer;
  d integer;
  n integer;
begin
  with expired as (
    select msg.id from public.messages msg
    join public.tenants t on t.id = msg.tenant_id
    where msg.body_purged_at is null
      and msg.received_at < now() - make_interval(days => t.retention_days)
  )
  update public.messages msg
  set body_text = null, subject = null, from_name = null, attachment_meta = '[]'::jsonb,
      body_purged_at = now()
  from expired where msg.id = expired.id;
  get diagnostics m = row_count;

  update public.message_processing p
  set classification = null, model_output = null, error = null
  from public.messages msg
  where msg.id = p.message_id and msg.body_purged_at is not null
    and (p.classification is not null or p.model_output is not null);

  update public.threads th set subject = null
  from public.tenants t
  where t.id = th.tenant_id and th.subject is not null
    and coalesce(th.last_inbound_at, th.created_at) < now() - make_interval(days => t.retention_days)
    and coalesce(th.last_outbound_at, th.created_at) < now() - make_interval(days => t.retention_days);

  with expired as (
    select dr.id from public.drafts dr
    join public.tenants t on t.id = dr.tenant_id
    where dr.body_purged_at is null
      and dr.created_at < now() - make_interval(days => t.retention_days)
  )
  update public.drafts dr
  set body = null, subject = '[deleted]', body_purged_at = now()
  from expired where dr.id = expired.id;
  get diagnostics d = row_count;

  update public.outbound_emails o set subject = '[deleted]', smtp_response = null, error = null
  from public.tenants t
  where t.id = o.tenant_id and o.subject <> '[deleted]'
    and o.created_at < now() - make_interval(days => t.retention_days);

  update public.escalations e set summary = null
  from public.tenants t
  where t.id = e.tenant_id and e.summary is not null
    and e.created_at < now() - make_interval(days => t.retention_days);

  -- Delivered or failed notifications carry subjects and summaries.
  delete from public.notifications nt
  using public.tenants t
  where t.id = nt.tenant_id and nt.status <> 'pending'
    and nt.created_at < now() - make_interval(days => least(t.retention_days, 30));
  get diagnostics n = row_count;

  return query select m, d, n;
end
$$;
revoke all on function app.purge_expired_content() from public;
grant execute on function app.purge_expired_content() to noctiv_worker;

-- ---------------------------------------------------------------------------
-- Hard delete ("Delete all data").
-- 1. The owner asks (API): membership is checked, the tenant is marked
--    'deleting' (processing stops at once), a proof row and a job are written.
-- 2. The worker erases: every tenant row (cascade), then the Supabase Auth
--    users that belonged only to this tenant; the proof row is completed.
-- The proof (tenant_deletions) holds no personal data: tenant id, times and
-- a hash of the requesting user id.
-- ---------------------------------------------------------------------------
create function app.request_tenant_deletion(p_tenant_id uuid, p_user_id uuid)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.tenant_members m
    where m.tenant_id = p_tenant_id and m.user_id = p_user_id and m.role = 'owner'
  ) then
    return false;
  end if;
  update public.tenants set status = 'deleting' where id = p_tenant_id;
  update public.tenant_deletions
  set requested_by_hash = coalesce(requested_by_hash, encode(sha256(convert_to(p_user_id::text, 'UTF8')), 'hex'))
  where tenant_id = p_tenant_id and completed_at is null;
  if not found then
    insert into public.tenant_deletions (tenant_id, requested_by_hash)
    values (p_tenant_id, encode(sha256(convert_to(p_user_id::text, 'UTF8')), 'hex'));
  end if;
  insert into public.jobs (tenant_id, queue, payload, singleton_key, max_attempts)
  values (p_tenant_id, 'tenant.delete', jsonb_build_object('tenantId', p_tenant_id), 'tenant.delete:' || p_tenant_id, 10)
  on conflict (queue, singleton_key) where singleton_key is not null and status in ('queued', 'running')
  do nothing;
  return true;
end
$$;
revoke all on function app.request_tenant_deletion(uuid, uuid) from public;
grant execute on function app.request_tenant_deletion(uuid, uuid) to noctiv_api;

create function app.delete_tenant(p_tenant_id uuid)
returns table (users_deleted integer)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  u uuid[];
  n integer := 0;
begin
  if not exists (select 1 from public.tenants where id = p_tenant_id and status = 'deleting') then
    return query select 0;
    return;
  end if;
  -- Members who belong to no other tenant lose their login too.
  select coalesce(array_agg(m.user_id), '{}') into u
  from public.tenant_members m
  where m.tenant_id = p_tenant_id
    and not exists (select 1 from public.tenant_members o where o.user_id = m.user_id and o.tenant_id <> p_tenant_id);

  delete from public.tenants where id = p_tenant_id; -- cascades to every tenant table
  delete from auth.users where id = any (u);
  get diagnostics n = row_count;

  update public.tenant_deletions set completed_at = now()
  where tenant_id = p_tenant_id and completed_at is null;
  return query select n;
end
$$;
revoke all on function app.delete_tenant(uuid) from public;
grant execute on function app.delete_tenant(uuid) to noctiv_worker;
