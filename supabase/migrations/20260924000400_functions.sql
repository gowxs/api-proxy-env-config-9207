-- Retrieval and cross-tenant scheduling functions.

-- ---------------------------------------------------------------------------
-- Knowledge-base search. SECURITY INVOKER: RLS still applies on top of the
-- explicit tenant filter, so a caller whose tenant context differs from
-- p_tenant_id gets nothing (defence in depth).
-- ---------------------------------------------------------------------------
-- Supabase Cloud: `postgres` is not a superuser, so a function may only SET
-- hnsw.* once pgvector's library is loaded in this session (found on the
-- first cloud deploy). Loading it is harmless everywhere.
select '[1]'::extensions.vector;

create function app.search_kb_chunks(
  p_tenant_id uuid,
  p_embedding extensions.vector(768),
  p_limit integer default 20
)
returns table (chunk_id uuid, source_id uuid, content text, metadata jsonb, distance double precision)
language sql
stable
-- pgvector >= 0.8: keep scanning the HNSW index until enough rows pass the
-- tenant filter, instead of returning a starved result set.
set hnsw.iterative_scan = 'relaxed_order'
set search_path = ''
as $$
  select c.id, c.source_id, c.content, c.metadata,
         (c.embedding operator(extensions.<=>) p_embedding)::double precision as distance
  from public.kb_chunks c
  where c.tenant_id = p_tenant_id
    and c.embedding is not null
  order by c.embedding operator(extensions.<=>) p_embedding
  limit least(greatest(p_limit, 1), 100)
$$;

create function app.search_kb_chunks_fts(
  p_tenant_id uuid,
  p_query text,
  p_limit integer default 20
)
returns table (chunk_id uuid, source_id uuid, content text, metadata jsonb, rank real)
language sql
stable
set search_path = ''
as $$
  select c.id, c.source_id, c.content, c.metadata,
         pg_catalog.ts_rank(c.fts, q) as rank
  from public.kb_chunks c,
       pg_catalog.websearch_to_tsquery('simple'::regconfig, p_query) q
  where c.tenant_id = p_tenant_id
    and c.fts @@ q
  order by rank desc
  limit least(greatest(p_limit, 1), 100)
$$;

-- ---------------------------------------------------------------------------
-- Cross-tenant enumeration for the worker's schedulers. SECURITY DEFINER
-- (owner bypasses RLS) but returns identifiers only; the worker then opens a
-- withTenant() transaction per tenant to do the actual work.
-- ---------------------------------------------------------------------------
create function app.list_active_tenants()
returns table (tenant_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id from public.tenants t where t.status = 'active'
$$;

create function app.list_mail_connections(p_statuses text[] default array['connected'])
returns table (tenant_id uuid, connection_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select c.tenant_id, c.id
  from public.email_connections c
  join public.tenants t on t.id = c.tenant_id
  where t.status = 'active'
    and c.status = any (p_statuses)
$$;

revoke all on function app.search_kb_chunks(uuid, extensions.vector, integer) from public;
revoke all on function app.search_kb_chunks_fts(uuid, text, integer) from public;
revoke all on function app.list_active_tenants() from public;
revoke all on function app.list_mail_connections(text[]) from public;

grant execute on function app.search_kb_chunks(uuid, extensions.vector, integer) to noctiv_worker;
grant execute on function app.search_kb_chunks_fts(uuid, text, integer) to noctiv_worker;
grant execute on function app.list_active_tenants() to noctiv_worker;
grant execute on function app.list_mail_connections(text[]) to noctiv_worker;
