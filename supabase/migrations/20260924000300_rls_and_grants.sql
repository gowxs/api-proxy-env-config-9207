-- Row Level Security and privileges (PLAN.md §3.1, §3.2).
--
-- Three kinds of callers:
--  * authenticated  – dashboard users via Supabase Auth; see rows of tenants
--                     they are members of; mostly read-only.
--  * noctiv_api     – API process; sees only app.current_tenant_id().
--  * noctiv_worker  – worker process; sees only app.current_tenant_id().
-- anon gets nothing. service_role / postgres bypass RLS and are not used at runtime.

-- ---------------------------------------------------------------------------
-- Start from zero: remove Supabase's default grants on our tables.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated, noctiv_api, noctiv_worker;

-- ---------------------------------------------------------------------------
-- Enable + force RLS and install the uniform policies on every tenant table.
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'tenants', 'tenant_members', 'telegram_link_tokens',
    'email_connections', 'connection_health_checks',
    'kb_sources', 'kb_chunks', 'kb_allowlist',
    'leads', 'lead_events',
    'threads', 'messages', 'message_processing', 'drafts', 'outbound_emails', 'escalations',
    'usage_daily', 'notifications', 'audit_log', 'tenant_deletions'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    -- Runtime roles: exactly one tenant per transaction.
    execute format(
      'create policy runtime_tenant_isolation on public.%I
         as permissive for all to noctiv_api, noctiv_worker
         using (tenant_id = (select app.current_tenant_id()))
         with check (tenant_id = (select app.current_tenant_id()))', t);

    -- Dashboard users: tenants they belong to. Privileges below decide
    -- which tables/columns they may actually read or change.
    execute format(
      'create policy member_tenant_access on public.%I
         as permissive for all to authenticated
         using (tenant_id in (select app.user_tenant_ids()))
         with check (tenant_id in (select app.user_tenant_ids()))', t);
  end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- authenticated (dashboard). Reads through RLS; the only direct write is lead
-- name/notes. Everything with side effects goes through the API.
-- Not granted at all: telegram_link_tokens, kb_chunks, kb_allowlist,
-- notifications, tenant_deletions.
-- ---------------------------------------------------------------------------
grant select on
  public.tenants, public.tenant_members, public.connection_health_checks,
  public.kb_sources, public.leads, public.lead_events,
  public.threads, public.messages, public.message_processing, public.drafts,
  public.outbound_emails, public.escalations, public.usage_daily, public.audit_log
to authenticated;

-- Every column except the sealed credentials.
grant select (
  id, tenant_id, provider, email_address, display_name,
  imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_security, username,
  status, last_error_code, last_error_detail, last_checked_at, last_ok_at,
  inbox_uidvalidity, inbox_last_uid, sent_folder_path, sent_append_mode, created_at, updated_at
) on public.email_connections to authenticated;

grant update (name, notes) on public.leads to authenticated;

-- ---------------------------------------------------------------------------
-- noctiv_api
-- ---------------------------------------------------------------------------
grant select on
  public.tenants, public.tenant_members, public.telegram_link_tokens,
  public.connection_health_checks, public.kb_sources,
  public.leads, public.lead_events,
  public.threads, public.messages, public.message_processing, public.drafts,
  public.outbound_emails, public.escalations, public.usage_daily,
  public.notifications, public.audit_log
to noctiv_api;

-- The API writes sealed credentials but can never read them back.
grant select (
  id, tenant_id, provider, email_address, display_name,
  imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_security, username,
  credentials_key_id, status, last_error_code, last_error_detail, last_checked_at, last_ok_at,
  inbox_uidvalidity, inbox_last_uid, sent_folder_path, sent_append_mode, created_at, updated_at
) on public.email_connections to noctiv_api;
grant insert on public.email_connections to noctiv_api;
grant update (
  provider, email_address, display_name, imap_host, imap_port, imap_secure,
  smtp_host, smtp_port, smtp_security, username, credentials_ciphertext, credentials_key_id,
  status, last_error_code, last_error_detail, last_checked_at
) on public.email_connections to noctiv_api;

-- Tenant settings the owner may change (budget_state, daily_token_budget and
-- status are worker/operator-controlled).
grant insert on public.tenants to noctiv_api;
grant update (
  name, website_url, timezone, mode, telegram_full_text, max_replies_per_hour,
  max_ai_replies_per_sender_24h, followup_after_days, followup_max, retention_days,
  reply_signature, telegram_chat_id, telegram_linked_at
) on public.tenants to noctiv_api;

grant insert on public.tenant_members to noctiv_api;
grant insert, update on public.telegram_link_tokens to noctiv_api;
grant insert, update, delete on public.kb_sources to noctiv_api;
grant update (name, notes, stage, stage_changed_at) on public.leads to noctiv_api;
grant insert on public.lead_events to noctiv_api;
grant update (status, body, edited, decided_by, decided_at, telegram_message_id) on public.drafts to noctiv_api;
grant update (resolved_at, resolved_by) on public.escalations to noctiv_api;
grant insert on public.notifications, public.audit_log to noctiv_api;

-- ---------------------------------------------------------------------------
-- noctiv_worker: full DML inside its tenant context.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on all tables in schema public to noctiv_worker;
