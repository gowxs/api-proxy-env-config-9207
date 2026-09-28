import {
  buildAllowlist,
  pricesInExcerpts,
  type Allowlist,
  type AllowlistEntry,
} from '@noctiv/core';
import type { TransactionSql } from 'postgres';

export interface KbSourceRow {
  id: string;
  tenant_id: string;
  type: 'website' | 'file' | 'note';
  title: string;
  url: string | null;
  mime_type: string | null;
  note_text: string | null;
  content_hash: string | null;
  embedding_model: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
}

// All functions run inside withTenant(); RLS scopes every statement.

export async function getSource(
  tx: TransactionSql,
  sourceId: string,
): Promise<KbSourceRow | undefined> {
  const [row] = await tx<KbSourceRow[]>`
    select id, tenant_id, type, title, url, mime_type, note_text, content_hash, embedding_model, status
    from public.kb_sources where id = ${sourceId}`;
  return row;
}

/** The staged upload of a file source, if it has not been ingested (and deleted) yet. */
export async function getUpload(
  tx: TransactionSql,
  sourceId: string,
): Promise<Uint8Array | undefined> {
  const [row] = await tx<
    { bytes: Buffer }[]
  >`select bytes from public.kb_uploads where source_id = ${sourceId}`;
  return row ? new Uint8Array(row.bytes) : undefined;
}

/** Originals are never kept (founder decision): drop the bytes once read or rejected. */
export async function deleteUpload(tx: TransactionSql, sourceId: string): Promise<void> {
  await tx`delete from public.kb_uploads where source_id = ${sourceId}`;
}

export async function tenantMailboxFlags(
  tx: TransactionSql,
): Promise<{ isTestMailbox: boolean }[]> {
  const rows = await tx<
    { is_test_mailbox: boolean }[]
  >`select is_test_mailbox from public.email_connections`;
  return rows.map((r) => ({ isTestMailbox: r.is_test_mailbox }));
}

export async function markSource(
  tx: TransactionSql,
  sourceId: string,
  patch: { status: KbSourceRow['status']; error?: string | null },
): Promise<void> {
  await tx`update public.kb_sources set status = ${patch.status}, error = ${patch.error ?? null} where id = ${sourceId}`;
}

export interface ChunkToStore {
  index: number;
  content: string;
  tokenEstimate: number;
  embedding: number[];
  metadata: Record<string, unknown>;
}

/** Replaces a source's chunks and allowlist entries atomically (idempotent re-ingestion). */
export async function replaceSourceContent(
  tx: TransactionSql,
  input: {
    tenantId: string;
    sourceId: string;
    embeddingModel: string;
    contentHash: string;
    chunks: ChunkToStore[];
    allowlist: AllowlistEntry[];
    pagesFetched?: number | null;
  },
): Promise<void> {
  await tx`delete from public.kb_chunks where source_id = ${input.sourceId}`;
  await tx`delete from public.kb_allowlist where source_id = ${input.sourceId}`;
  for (const c of input.chunks) {
    await tx`
      insert into public.kb_chunks (tenant_id, source_id, chunk_index, content, token_count, embedding, embedding_model, metadata)
      values (${input.tenantId}, ${input.sourceId}, ${c.index}, ${c.content}, ${c.tokenEstimate},
              ${`[${c.embedding.join(',')}]`}::extensions.vector, ${input.embeddingModel}, ${tx.json(c.metadata as never)})`;
  }
  for (const e of input.allowlist) {
    await tx`
      insert into public.kb_allowlist (tenant_id, source_id, kind, value)
      values (${input.tenantId}, ${input.sourceId}, ${e.kind}, ${e.value})
      on conflict do nothing`;
  }
  await tx`
    update public.kb_sources
    set status = 'ready', error = null, content_hash = ${input.contentHash}, embedding_model = ${input.embeddingModel},
        chunk_count = ${input.chunks.length}, ingested_at = now(), pages_fetched = ${input.pagesFetched ?? null}
    where id = ${input.sourceId}`;
}

export async function loadAllowlist(tx: TransactionSql): Promise<Allowlist> {
  const rows = await tx<AllowlistEntry[]>`select distinct kind, value from public.kb_allowlist`;
  return buildAllowlist(rows);
}

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Where the chunk comes from; filled in by retrieveKnowledge. */
  source?: ChunkSource;
}

export interface ChunkSource {
  type: 'website' | 'file' | 'note';
  title: string;
  url: string | null;
  /** When the owner last saved the note, or the page/file was last read. */
  updatedAt: Date;
}

/** Type, title and date of each source, for labelling excerpts. */
export async function sourceInfo(
  tx: TransactionSql,
  sourceIds: string[],
): Promise<Map<string, ChunkSource>> {
  if (!sourceIds.length) return new Map();
  const rows = await tx<
    { id: string; type: ChunkSource['type']; title: string; url: string | null; at: Date }[]
  >`
    select id, type, title, url, coalesce(ingested_at, updated_at) as at
    from public.kb_sources where id = any(${sourceIds}::uuid[])`;
  return new Map(
    rows.map((r) => [r.id, { type: r.type, title: r.title, url: r.url, updatedAt: r.at }]),
  );
}

/**
 * The owner's own notes, searched on their own: a tenant's notes are a few
 * chunks among hundreds of website chunks, and near-duplicate website text
 * can push them out of the general ranking (production case 2026-09-28: the
 * note with the price ranked 6th–7th for "how much does a business website
 * cost"). Vector and full-text lists, as in the general search.
 */
export async function noteSearch(
  tx: TransactionSql,
  args: { tenantId: string; model: string; embedding: number[]; query: string; limit: number },
): Promise<[RetrievedChunk[], RetrievedChunk[]]> {
  type Row = {
    chunk_id: string;
    source_id: string;
    content: string;
    metadata: Record<string, unknown>;
  };
  const toChunk = (r: Row): RetrievedChunk => ({
    id: r.chunk_id,
    sourceId: r.source_id,
    content: r.content,
    metadata: r.metadata,
  });
  const vector = await tx.unsafe<Row[]>(
    `select c.id as chunk_id, c.source_id, c.content, c.metadata
     from public.kb_chunks c join public.kb_sources s on s.id = c.source_id
     where c.tenant_id = $1 and s.type = 'note' and c.embedding_model = $2 and c.embedding is not null
     -- "+ 0": an exact scan. Notes are few, and the HNSW index with this filter could return fewer rows.
     order by (c.embedding operator(extensions.<=>) $3::extensions.vector) + 0
     limit $4`,
    [args.tenantId, args.model, `[${args.embedding.join(',')}]`, args.limit],
  );
  const text = args.query
    ? await tx<Row[]>`
        select c.id as chunk_id, c.source_id, c.content, c.metadata
        from public.kb_chunks c join public.kb_sources s on s.id = c.source_id,
             websearch_to_tsquery('simple', ${args.query}) q
        where c.tenant_id = ${args.tenantId} and s.type = 'note' and c.fts @@ q
        order by ts_rank(c.fts, q) desc
        limit ${args.limit}`
    : [];
  return [vector.map(toChunk), text.map(toChunk)];
}

/**
 * Chunks of the owner's notes that state an amount of money, newest note
 * first: added to the excerpts of every price question, whatever its language
 * (production case 2026-09-28: a Latvian question, the prices in an English note).
 */
export async function pricedNoteChunks(
  tx: TransactionSql,
  args: { tenantId: string; limit: number },
): Promise<RetrievedChunk[]> {
  const rows = await tx<
    { chunk_id: string; source_id: string; content: string; metadata: Record<string, unknown> }[]
  >`
    select c.id as chunk_id, c.source_id, c.content, c.metadata
    from public.kb_chunks c join public.kb_sources s on s.id = c.source_id
    where c.tenant_id = ${args.tenantId} and s.type = 'note'
      and c.content ~ '[0-9]'
    order by s.updated_at desc, c.chunk_index
    limit 200`;
  return rows
    .filter((r) => pricesInExcerpts([r.content]).length > 0)
    .slice(0, args.limit)
    .map((r) => ({
      id: r.chunk_id,
      sourceId: r.source_id,
      content: r.content,
      metadata: r.metadata,
    }));
}

export async function vectorSearch(
  tx: TransactionSql,
  args: { tenantId: string; model: string; embedding: number[]; limit: number },
): Promise<RetrievedChunk[]> {
  const rows = await tx.unsafe<
    { chunk_id: string; source_id: string; content: string; metadata: Record<string, unknown> }[]
  >(
    'select chunk_id, source_id, content, metadata from app.search_kb_chunks($1, $2, $3::extensions.vector, $4)',
    [args.tenantId, args.model, `[${args.embedding.join(',')}]`, args.limit],
  );
  return rows.map((r) => ({
    id: r.chunk_id,
    sourceId: r.source_id,
    content: r.content,
    metadata: r.metadata,
  }));
}

export async function textSearch(
  tx: TransactionSql,
  args: { tenantId: string; query: string; limit: number },
): Promise<RetrievedChunk[]> {
  if (!args.query) return [];
  const rows = await tx<
    { chunk_id: string; source_id: string; content: string; metadata: Record<string, unknown> }[]
  >`
    select chunk_id, source_id, content, metadata from app.search_kb_chunks_fts(${args.tenantId}, ${args.query}, ${args.limit})`;
  return rows.map((r) => ({
    id: r.chunk_id,
    sourceId: r.source_id,
    content: r.content,
    metadata: r.metadata,
  }));
}
