-- Noctiv Phase 1 tables. Conventions (PLAN.md §2):
--  * every table has tenant_id; child tables reference parents through
--    composite (tenant_id, id) foreign keys so a row can never point at
--    another tenant's row, even though FK checks bypass RLS;
--  * status-like columns are text + CHECK (easier to evolve than enums);
--  * RLS, policies and grants live in the next migration.

set local search_path = public, extensions;

-- ===========================================================================
-- Tenancy
-- ===========================================================================
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  -- Uniform tenant_id column so every table carries the same policy shape.
  tenant_id uuid generated always as (id) stored not null unique,
  name text not null check (length(name) between 1 and 200),
  website_url text,
  timezone text not null check (app.is_valid_timezone(timezone)),
  mode text not null default 'draft_only' check (mode in ('draft_only', 'auto_send')),
  telegram_full_text boolean not null default false,
  budget_state text not null default 'ok' check (budget_state in ('ok', 'draft_forced', 'halted')),
  daily_token_budget integer not null default 200000 check (daily_token_budget > 0),
  max_replies_per_hour integer not null default 20 check (max_replies_per_hour between 1 and 500),
  max_ai_replies_per_sender_24h integer not null default 2 check (max_ai_replies_per_sender_24h between 0 and 2),
  followup_after_days integer not null default 3 check (followup_after_days between 1 and 30),
  followup_max integer not null default 2 check (followup_max between 0 and 2),
  retention_days integer not null default 90 check (retention_days between 1 and 3650),
  reply_signature text,
  telegram_chat_id bigint unique,
  telegram_linked_at timestamptz,
  status text not null default 'active' check (status in ('active', 'deleting')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null default 'owner' check (role in ('owner')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_id_idx on public.tenant_members (user_id);

-- Tenants the signed-in dashboard user belongs to. SECURITY DEFINER so the
-- tenant_members policy can use it without recursing into itself.
create function app.user_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id from public.tenant_members m where m.user_id = (select auth.uid())
$$;
revoke all on function app.user_tenant_ids() from public;
grant execute on function app.user_tenant_ids() to authenticated;

create table public.telegram_link_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  token_hash bytea not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index telegram_link_tokens_tenant_idx on public.telegram_link_tokens (tenant_id);

-- ===========================================================================
-- Email connections
-- ===========================================================================
create table public.email_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  provider text not null check (provider in ('gmail', 'google_workspace', 'hostinger', 'outlook', 'generic')),
  email_address citext not null,
  display_name text,
  imap_host text not null,
  imap_port integer not null check (imap_port between 1 and 65535),
  imap_secure boolean not null default true,
  smtp_host text not null,
  smtp_port integer not null check (smtp_port between 1 and 65535),
  smtp_security text not null check (smtp_security in ('tls', 'starttls')),
  username text not null,
  -- Sealed with the worker's public key; only the worker can decrypt (PLAN.md §3.3).
  credentials_ciphertext bytea not null,
  credentials_key_id text not null,
  status text not null default 'pending' check (status in ('pending', 'connected', 'disconnected', 'error')),
  last_error_code text,
  last_error_detail text,
  last_checked_at timestamptz,
  last_ok_at timestamptz,
  inbox_uidvalidity bigint,
  inbox_last_uid bigint,
  sent_folder_path text,
  sent_append_mode text not null default 'append' check (sent_append_mode in ('append', 'provider_auto', 'none')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, email_address)
);

create table public.connection_health_checks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connection_id uuid not null,
  checked_at timestamptz not null default now(),
  imap_ok boolean not null,
  smtp_ok boolean not null,
  error_code text,
  latency_ms integer,
  foreign key (tenant_id, connection_id) references public.email_connections (tenant_id, id) on delete cascade
);
create index connection_health_checks_conn_idx on public.connection_health_checks (tenant_id, connection_id, checked_at desc);

-- ===========================================================================
-- Knowledge base
-- ===========================================================================
create table public.kb_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  type text not null check (type in ('website', 'file', 'note')),
  title text not null,
  url text,
  -- Storage objects live under a folder named after the tenant.
  storage_path text check (storage_path is null or storage_path like tenant_id::text || '/%'),
  mime_type text,
  content_hash text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'ready', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

create table public.kb_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  source_id uuid not null,
  chunk_index integer not null check (chunk_index >= 0),
  content text not null,
  token_count integer not null default 0,
  -- 768 dims: final embedding model is pinned in build step 4 (PLAN.md §5).
  embedding extensions.vector(768),
  fts tsvector generated always as (to_tsvector('simple', content)) stored,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_id, chunk_index),
  foreign key (tenant_id, source_id) references public.kb_sources (tenant_id, id) on delete cascade
);
create index kb_chunks_tenant_idx on public.kb_chunks (tenant_id, source_id);
create index kb_chunks_embedding_idx on public.kb_chunks using hnsw (embedding extensions.vector_cosine_ops);
create index kb_chunks_fts_idx on public.kb_chunks using gin (fts);

create table public.kb_allowlist (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  source_id uuid not null,
  kind text not null check (kind in ('url', 'domain', 'email')),
  value text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, source_id, kind, value),
  foreign key (tenant_id, source_id) references public.kb_sources (tenant_id, id) on delete cascade
);
create index kb_allowlist_lookup_idx on public.kb_allowlist (tenant_id, kind, value);

-- ===========================================================================
-- CRM
-- ===========================================================================
create table public.leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  email citext not null,
  name text,
  stage text not null default 'received'
    check (stage in ('received', 'drafted', 'sent', 'followed_up', 'replied', 'converted', 'escalated')),
  stage_changed_at timestamptz not null default now(),
  language text,
  first_seen_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, email)
);

create table public.lead_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  lead_id uuid not null,
  from_stage text,
  to_stage text not null,
  actor text not null check (actor in ('system', 'owner')),
  actor_user_id uuid,
  reason text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id) on delete cascade
);
create index lead_events_lead_idx on public.lead_events (tenant_id, lead_id, created_at);

-- ===========================================================================
-- Mail
-- ===========================================================================
create table public.threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connection_id uuid not null,
  lead_id uuid,
  subject text,
  root_message_id_header text,
  status text not null default 'open'
    check (status in ('open', 'awaiting_customer', 'customer_replied', 'escalated', 'closed')),
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  followups_sent integer not null default 0 check (followups_sent >= 0),
  next_followup_at timestamptz,
  followup_stop_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, connection_id) references public.email_connections (tenant_id, id) on delete cascade,
  foreign key (tenant_id, lead_id) references public.leads (tenant_id, id) on delete set null (lead_id)
);
create index threads_followup_due_idx on public.threads (next_followup_at) where status = 'awaiting_customer';
create index threads_tenant_idx on public.threads (tenant_id, last_inbound_at desc);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  connection_id uuid not null,
  thread_id uuid,
  direction text not null check (direction in ('inbound', 'outbound')),
  -- Dedupe key. Messages without a Message-ID get a synthetic one
  -- (<sha256(...)@noctiv.invalid>) computed by the worker.
  message_id_header text not null check (length(message_id_header) between 3 and 998),
  in_reply_to text,
  reference_ids text[] not null default '{}',
  from_address citext not null,
  from_name text,
  reply_to citext,
  to_addresses citext[] not null default '{}',
  cc_addresses citext[] not null default '{}',
  subject text,
  body_text text,
  loop_headers jsonb not null default '{}'::jsonb,
  attachment_meta jsonb not null default '[]'::jsonb,
  imap_uid bigint,
  received_at timestamptz not null,
  body_purged_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  -- A message can never be stored (and therefore processed) twice per mailbox.
  unique (connection_id, message_id_header),
  foreign key (tenant_id, connection_id) references public.email_connections (tenant_id, id) on delete cascade,
  foreign key (tenant_id, thread_id) references public.threads (tenant_id, id) on delete set null (thread_id)
);
create index messages_thread_idx on public.messages (tenant_id, thread_id, received_at);
create index messages_header_lookup_idx on public.messages (tenant_id, message_id_header);
create index messages_retention_idx on public.messages (tenant_id, received_at) where body_text is not null;

create table public.message_processing (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  message_id uuid not null unique,
  status text not null default 'queued'
    check (status in ('queued', 'skipped', 'escalated', 'drafted', 'auto_sent', 'failed')),
  skip_reason text,
  classification jsonb,
  model_output jsonb,
  final_action text check (final_action in ('auto_send', 'draft', 'escalate', 'skip')),
  downgrade_reasons text[] not null default '{}',
  confidence numeric(4, 3) check (confidence between 0 and 1),
  retrieved_chunk_ids uuid[] not null default '{}',
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, message_id) references public.messages (tenant_id, id) on delete cascade
);

create table public.drafts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  thread_id uuid not null,
  source_message_id uuid,
  kind text not null check (kind in ('reply', 'followup')),
  -- Always copied from the original message headers, never from model output.
  to_address citext not null,
  subject text not null,
  body text,
  source_chunk_ids uuid[] not null default '{}',
  -- 'suggestion' = attached to an uncertainty escalation, shown as
  -- "AI suggestion, unverified" (PLAN.md §11, Q16).
  status text not null default 'pending_approval'
    check (status in ('pending_approval', 'suggestion', 'approved', 'rejected', 'sent', 'send_failed', 'superseded')),
  edited boolean not null default false,
  telegram_message_id bigint,
  decided_by text,
  decided_at timestamptz,
  body_purged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, thread_id) references public.threads (tenant_id, id) on delete cascade,
  foreign key (tenant_id, source_message_id) references public.messages (tenant_id, id) on delete set null (source_message_id)
);
create index drafts_status_idx on public.drafts (tenant_id, status, created_at desc);

create table public.outbound_emails (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  -- One outbound email per draft: double approvals cannot double-send.
  draft_id uuid not null unique,
  thread_id uuid not null,
  message_id_header text not null unique,
  to_address citext not null,
  subject text not null,
  in_reply_to text,
  reference_ids text[] not null default '{}',
  sent_via text not null check (sent_via in ('auto', 'owner_approval')),
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  smtp_response text,
  appended_to_sent boolean not null default false,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, draft_id) references public.drafts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, thread_id) references public.threads (tenant_id, id) on delete cascade
);
create index outbound_emails_sender_cap_idx on public.outbound_emails (tenant_id, to_address, created_at);
create index outbound_emails_hour_cap_idx on public.outbound_emails (tenant_id, created_at);

create table public.escalations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  message_id uuid not null,
  thread_id uuid,
  -- hard_list: complaint/refund/legal/discount/angry/urgent -> no draft.
  -- uncertain: low confidence / sources / invalid JSON -> optional suggestion draft.
  category text not null check (category in ('hard_list', 'uncertain')),
  reason text not null,
  summary text,
  suggestion_draft_id uuid,
  telegram_message_id bigint,
  notified_at timestamptz,
  resolved_at timestamptz,
  resolved_by text,
  created_at timestamptz not null default now(),
  check (category = 'uncertain' or suggestion_draft_id is null),
  foreign key (tenant_id, message_id) references public.messages (tenant_id, id) on delete cascade,
  foreign key (tenant_id, thread_id) references public.threads (tenant_id, id) on delete set null (thread_id),
  foreign key (tenant_id, suggestion_draft_id) references public.drafts (tenant_id, id) on delete set null (suggestion_draft_id)
);
create index escalations_open_idx on public.escalations (tenant_id, created_at desc) where resolved_at is null;

-- ===========================================================================
-- Operations
-- ===========================================================================
create table public.usage_daily (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  day date not null,
  llm_calls integer not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  embed_tokens bigint not null default 0,
  est_cost_micro_eur bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, day)
);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  channel text not null check (channel in ('telegram_owner', 'email_owner', 'telegram_admin', 'email_admin')),
  kind text not null,
  -- e.g. 'disconnected:<connection_id>:<incident>' — one alert per incident.
  dedupe_key text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  sent_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);
create index notifications_pending_idx on public.notifications (created_at) where status = 'pending';

create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  actor text not null check (actor in ('owner', 'system', 'telegram')),
  actor_user_id uuid,
  action text not null,
  target_type text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_tenant_idx on public.audit_log (tenant_id, created_at desc);

-- Proof of erasure. No FK: the tenant row is gone by the time this is final.
create table public.tenant_deletions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  requested_by_hash text
);
create index tenant_deletions_tenant_idx on public.tenant_deletions (tenant_id);

-- ===========================================================================
-- updated_at triggers
-- ===========================================================================
do $$
declare
  t text;
begin
  foreach t in array array[
    'tenants', 'email_connections', 'kb_sources', 'leads', 'threads',
    'message_processing', 'drafts', 'outbound_emails', 'usage_daily'
  ] loop
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function app.set_updated_at()', t);
  end loop;
end
$$;
