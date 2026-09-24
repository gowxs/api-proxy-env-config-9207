import { buildAllowlist, type Allowlist, type AllowlistEntry } from '@noctiv/core';
import type { TransactionSql } from 'postgres';

export interface KbSourceRow {
  id: string;
  tenant_id: string;
  type: 'website' | 'file' | 'note';
  title: string;
  url: string | null;
  storage_path: string | null;
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
    select id, tenant_id, type, title, url, storage_path, mime_type, note_text, content_hash, embedding_model, status
    from public.kb_sources where id = ${sourceId}`;
  return row;
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
