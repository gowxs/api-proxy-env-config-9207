-- Step 4: LLM providers.
--  * email_connections.is_test_mailbox: the free-tier (Google AI Studio)
--    provider may only process mail from mailboxes carrying this flag.
--    Only the operator (schema owner) can set it; not tenants, not the API,
--    not the worker.
--  * kb_chunks.embedding_model: vectors from different models are not
--    comparable, so search only matches chunks embedded with the query's model.

set local search_path = public, extensions;

-- ---------------------------------------------------------------------------
-- is_test_mailbox
-- ---------------------------------------------------------------------------
alter table public.email_connections
  add column is_test_mailbox boolean not null default false;

create function app.protect_is_test_mailbox()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (tg_op = 'INSERT' and new.is_test_mailbox)
     or (tg_op = 'UPDATE' and new.is_test_mailbox is distinct from old.is_test_mailbox) then
    if current_user not in ('postgres', 'supabase_admin') then
      raise exception 'is_test_mailbox can only be changed by the operator'
        using errcode = '42501';
    end if;
  end if;
  return new;
end
$$;
revoke all on function app.protect_is_test_mailbox() from public;

create trigger protect_is_test_mailbox
  before insert or update on public.email_connections
  for each row execute function app.protect_is_test_mailbox();

-- Visible (read-only) to the dashboard and API, e.g. for a "test mailbox" badge.
grant select (is_test_mailbox) on public.email_connections to authenticated, noctiv_api;

-- The worker scheduler needs the flag to decide which mailboxes it may process.
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
    and c.status = any (p_statuses)
$$;
revoke all on function app.list_mail_connections(text[]) from public;
grant execute on function app.list_mail_connections(text[]) to noctiv_worker;

-- ---------------------------------------------------------------------------
-- kb_chunks.embedding_model
-- ---------------------------------------------------------------------------
alter table public.kb_chunks add column embedding_model text;
update public.kb_chunks set embedding_model = 'unknown' where embedding_model is null;
alter table public.kb_chunks alter column embedding_model set not null;
create index kb_chunks_model_idx on public.kb_chunks (tenant_id, embedding_model);

drop function app.search_kb_chunks(uuid, extensions.vector, integer);
create function app.search_kb_chunks(
  p_tenant_id uuid,
  p_embedding_model text,
  p_embedding extensions.vector(768),
  p_limit integer default 20
)
returns table (chunk_id uuid, source_id uuid, content text, metadata jsonb, distance double precision)
language sql
stable
set hnsw.iterative_scan = 'relaxed_order'
set search_path = ''
as $$
  select c.id, c.source_id, c.content, c.metadata,
         (c.embedding operator(extensions.<=>) p_embedding)::double precision as distance
  from public.kb_chunks c
  where c.tenant_id = p_tenant_id
    and c.embedding_model = p_embedding_model
    and c.embedding is not null
  order by c.embedding operator(extensions.<=>) p_embedding
  limit least(greatest(p_limit, 1), 100)
$$;
revoke all on function app.search_kb_chunks(uuid, text, extensions.vector, integer) from public;
grant execute on function app.search_kb_chunks(uuid, text, extensions.vector, integer) to noctiv_worker;
