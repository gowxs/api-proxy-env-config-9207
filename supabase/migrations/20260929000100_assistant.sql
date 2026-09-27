-- Noctiv Assistant (beta), PLAN.md §27 (founder request 2026-09-29): the
-- in-app chat. The model only reads (tenant-scoped tools in the worker) and
-- proposes; a proposed change is applied by the API when the owner confirms
-- it. Customer e-mail text is never stored here, only what the assistant
-- said (which may quote it as data).
set local search_path = public, extensions;

create table public.assistant_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  user_id uuid not null,
  -- en | de | lv | nl | fr | es: the language the owner started in (browser or first message).
  locale text not null default 'en' check (locale in ('en', 'de', 'lv', 'nl', 'fr', 'es')),
  -- 'onboarding': the setup chat (first screen of onboarding); 'app': the floating panel.
  purpose text not null default 'app' check (purpose in ('app', 'onboarding')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index assistant_conversations_user_idx
  on public.assistant_conversations (tenant_id, user_id, updated_at desc);
create trigger set_updated_at before update on public.assistant_conversations
  for each row execute function app.set_updated_at();

create table public.assistant_messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  conversation_id uuid not null,
  role text not null check (role in ('owner', 'assistant')),
  text text not null check (char_length(text) <= 8000),
  -- Quick replies the assistant offers (at most 3).
  suggestions jsonb not null default '[]'::jsonb,
  -- Names of the read-only tools used for this answer (no arguments, no results).
  tools_used text[] not null default '{}',
  -- The page the owner was on (e.g. /conversations/<id>), for "this e-mail".
  context_path text check (char_length(context_path) <= 200),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, conversation_id)
    references public.assistant_conversations (tenant_id, id) on delete cascade
);
create index assistant_messages_conversation_idx
  on public.assistant_messages (tenant_id, conversation_id, created_at);

create table public.assistant_proposals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  conversation_id uuid not null,
  message_id uuid not null,
  type text not null check (type in ('settings', 'knowledge_note', 'price_items')),
  title text not null check (char_length(title) <= 200),
  payload jsonb not null,
  -- Changes what Noctiv sends on its own: the confirmation dialog is required.
  requires_confirmation boolean not null default false,
  status text not null default 'proposed'
    check (status in ('proposed', 'applied', 'dismissed', 'failed')),
  error text check (char_length(error) <= 500),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, message_id)
    references public.assistant_messages (tenant_id, id) on delete cascade
);
create index assistant_proposals_message_idx
  on public.assistant_proposals (tenant_id, message_id);

do $$
declare
  t text;
begin
  foreach t in array array['assistant_conversations', 'assistant_messages', 'assistant_proposals'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy runtime_tenant_isolation on public.%I
         as permissive for all to noctiv_api, noctiv_worker
         using (tenant_id = (select app.current_tenant_id()))
         with check (tenant_id = (select app.current_tenant_id()))', t);
    -- Same shape as every tenant table; no grants to authenticated, so unused today.
    execute format(
      'create policy member_tenant_access on public.%I
         as permissive for all to authenticated
         using (tenant_id in (select app.user_tenant_ids()))
         with check (tenant_id in (select app.user_tenant_ids()))', t);
  end loop;
end
$$;
revoke all on public.assistant_conversations, public.assistant_messages, public.assistant_proposals
  from anon, authenticated;
-- The API stores the owner's messages and the owner's decision on a proposal.
grant select, insert, update (locale) on public.assistant_conversations to noctiv_api;
grant select, insert on public.assistant_messages to noctiv_api;
grant select, update (status, error, decided_by, decided_at) on public.assistant_proposals to noctiv_api;
-- The worker writes the assistant's answers and proposals.
grant select, insert, update (locale, updated_at) on public.assistant_conversations to noctiv_worker;
grant select, insert on public.assistant_messages, public.assistant_proposals to noctiv_worker;
