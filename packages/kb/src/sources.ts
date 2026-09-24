import { enqueue } from '@noctiv/db';
import type { TransactionSql } from 'postgres';
import { detectKbFile, MIME_TYPES, safeFileName } from './extract/files.ts';
import { assertFetchableUrl } from './web/safe-fetch.ts';

/**
 * Creating a knowledge source = one row + (for files) the staged upload +
 * an ingestion job, in the caller's withTenant() transaction. Used by the
 * API upload endpoints (step 12) and by tests.
 */

export const KB_INGEST_QUEUE = 'kb.ingest';

async function enqueueIngest(tx: TransactionSql, tenantId: string, sourceId: string) {
  await enqueue(tx, {
    tenantId,
    queue: KB_INGEST_QUEUE,
    payload: { sourceId },
    singletonKey: sourceId,
  });
}

export async function createFileSource(
  tx: TransactionSql,
  args: { tenantId: string; fileName: string; bytes: Uint8Array },
): Promise<string> {
  const kind = detectKbFile(args.bytes); // throws UploadRejectedError
  const [row] = await tx<{ id: string }[]>`
    insert into public.kb_sources (tenant_id, type, title, mime_type, status)
    values (${args.tenantId}, 'file', ${safeFileName(args.fileName)}, ${MIME_TYPES[kind]}, 'pending')
    returning id`;
  await tx`insert into public.kb_uploads (source_id, tenant_id, bytes, mime_type)
           values (${row!.id}, ${args.tenantId}, ${Buffer.from(args.bytes)}, ${MIME_TYPES[kind]})`;
  await enqueueIngest(tx, args.tenantId, row!.id);
  return row!.id;
}

export async function createNoteSource(
  tx: TransactionSql,
  args: { tenantId: string; title: string; text: string },
): Promise<string> {
  const [row] = await tx<{ id: string }[]>`
    insert into public.kb_sources (tenant_id, type, title, note_text, status)
    values (${args.tenantId}, 'note', ${args.title.slice(0, 200)}, ${args.text}, 'pending')
    returning id`;
  await enqueueIngest(tx, args.tenantId, row!.id);
  return row!.id;
}

export async function createWebsiteSource(
  tx: TransactionSql,
  args: { tenantId: string; url: string },
): Promise<string> {
  const url = assertFetchableUrl(args.url).toString(); // throws BlockedUrlError
  const [row] = await tx<{ id: string }[]>`
    insert into public.kb_sources (tenant_id, type, title, url, status)
    values (${args.tenantId}, 'website', ${new URL(url).hostname}, ${url}, 'pending')
    returning id`;
  await enqueueIngest(tx, args.tenantId, row!.id);
  return row!.id;
}
