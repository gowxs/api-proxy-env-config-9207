import { createHash } from 'node:crypto';
import {
  chunkText,
  extractAllowlistEntries,
  normalizeKnowledgeText,
  originForTenantKnowledge,
  TrainingDataPolicyError,
  type AllowlistEntry,
  type EmbeddingProvider,
} from '@noctiv/core';
import { currentBudget, recordUsage, withTenant } from '@noctiv/db';
import type { Sql } from 'postgres';
import { detectKbFile, extractFileText } from './extract/files.ts';
import {
  deleteUpload,
  getSource,
  getUpload,
  markSource,
  replaceSourceContent,
  tenantMailboxFlags,
  type ChunkToStore,
} from './repo.ts';
import { crawlSite, type CrawlOptions } from './web/crawl.ts';
import type { SafeFetch } from './web/safe-fetch.ts';

export interface IngestDeps {
  sql: Sql;
  embeddings: EmbeddingProvider;
  fetcher: SafeFetch;
  crawl?: CrawlOptions;
}

export type IngestFailure =
  | 'source_not_found'
  | 'free_tier_customer_data'
  | 'budget_halted'
  | 'no_text'
  | 'extraction_failed'
  | 'fetch_failed'
  | 'upload_missing'
  | 'embedding_failed';

export type IngestOutcome =
  | { status: 'ready'; chunks: number; unchanged: boolean }
  | { status: 'failed'; reason: IngestFailure; retryable: boolean; detail?: string };

const RETRYABLE: ReadonlySet<IngestFailure> = new Set([
  'budget_halted',
  'fetch_failed',
  'embedding_failed',
]);

class IngestError extends Error {
  readonly reason: IngestFailure;
  /** Loggable cause, e.g. the provider error kind ("rate_limited"); never content. */
  readonly detail: string | undefined;

  constructor(reason: IngestFailure, detail?: string) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

async function collectText(
  deps: IngestDeps,
  tenantId: string,
  source: NonNullable<Awaited<ReturnType<typeof getSource>>>,
) {
  if (source.type === 'note') {
    return {
      sections: [{ text: source.note_text ?? '', metadata: {} }],
      extraAllow: [] as AllowlistEntry[],
      pages: null,
    };
  }
  if (source.type === 'file') {
    const bytes = await withTenant(deps.sql, tenantId, (tx) => getUpload(tx, source.id));
    if (!bytes) throw new IngestError('upload_missing');
    try {
      const text = await extractFileText(detectKbFile(bytes), bytes);
      return {
        sections: [{ text, metadata: { file: source.title } }],
        extraAllow: [],
        pages: null,
      };
    } catch {
      throw new IngestError('extraction_failed');
    }
  }
  let result;
  try {
    result = await crawlSite(source.url ?? '', deps.fetcher, deps.crawl);
  } catch {
    throw new IngestError('fetch_failed');
  }
  if (result.pages.length === 0) throw new IngestError('fetch_failed');
  // The tenant's own pages may be linked in replies.
  const extraAllow = result.pages.flatMap((p) => extractAllowlistEntries(p.url));
  return {
    sections: result.pages.map((p) => ({
      text: p.title ? `# ${p.title}\n\n${p.text}` : p.text,
      metadata: { url: p.url },
    })),
    extraAllow,
    pages: result.pages.length,
  };
}

/**
 * Turns one knowledge source into embedded, searchable chunks plus its link
 * allowlist. Idempotent: unchanged content with the same embedding model is
 * not re-embedded; changed content replaces the old chunks atomically.
 *
 * Respects the strict free-tier rule (PLAN.md §11): with a provider that may
 * train on data, a tenant's knowledge base is processed only if every one of
 * its mailboxes is a test mailbox.
 */
export async function ingestSource(
  deps: IngestDeps,
  tenantId: string,
  sourceId: string,
  opts: {
    /** False while the job will be retried: the source then shows as waiting, not failed. */
    finalAttempt?: boolean;
  } = {},
): Promise<IngestOutcome> {
  const fail = async (reason: IngestFailure, detail?: string): Promise<IngestOutcome> => {
    const retryable = RETRYABLE.has(reason);
    const willRetry = retryable && opts.finalAttempt === false;
    await withTenant(deps.sql, tenantId, async (tx) => {
      // The error keeps the cause ("embedding_failed:rate_limited"); the UI words it.
      await markSource(tx, sourceId, {
        status: willRetry ? 'pending' : 'failed',
        error: detail ? `${reason}:${detail}` : reason,
      });
      // A rejected file is not kept for later; retryable failures keep it for the retry.
      if (!retryable) await deleteUpload(tx, sourceId);
    });
    return { status: 'failed', reason, retryable, ...(detail ? { detail } : {}) };
  };

  const start = await withTenant(deps.sql, tenantId, async (tx) => {
    const source = await getSource(tx, sourceId);
    if (!source) return null;
    await markSource(tx, sourceId, { status: 'processing' });
    return {
      source,
      mailboxes: await tenantMailboxFlags(tx),
      budget: await currentBudget(tx, tenantId),
    };
  });
  if (!start) return { status: 'failed', reason: 'source_not_found', retryable: false };

  const origin = originForTenantKnowledge(start.mailboxes);
  if (deps.embeddings.trainingPolicy === 'may_train_on_data' && origin === 'customer_data') {
    return fail('free_tier_customer_data');
  }
  if (start.budget.state === 'halted') return fail('budget_halted');

  try {
    const { sections, extraAllow, pages } = await collectText(deps, tenantId, start.source);
    const fullText = normalizeKnowledgeText(sections.map((s) => s.text).join('\n\n'));
    if (!fullText) throw new IngestError('no_text');
    const contentHash = createHash('sha256').update(fullText).digest('hex');

    if (
      start.source.content_hash === contentHash &&
      start.source.embedding_model === deps.embeddings.model &&
      start.source.status !== 'failed'
    ) {
      await withTenant(deps.sql, tenantId, async (tx) => {
        await markSource(tx, sourceId, { status: 'ready' });
        await deleteUpload(tx, sourceId);
      });
      return { status: 'ready', chunks: -1, unchanged: true };
    }

    const pieces = sections.flatMap((s) =>
      chunkText(s.text).map((c) => ({ ...c, metadata: { ...s.metadata, headings: c.headings } })),
    );
    if (pieces.length === 0) throw new IngestError('no_text');

    let embedded;
    try {
      embedded = await deps.embeddings.embed(
        pieces.map((p) => p.content),
        'document',
        origin,
      );
    } catch (e) {
      if (e instanceof TrainingDataPolicyError) throw new IngestError('free_tier_customer_data');
      // Provider errors carry a coarse kind (rate_limited, quota_exhausted, auth, …).
      const kind = (e as { kind?: unknown }).kind;
      throw new IngestError('embedding_failed', typeof kind === 'string' ? kind : 'unknown');
    }

    const chunks: ChunkToStore[] = pieces.map((p, i) => ({
      index: i,
      content: p.content,
      tokenEstimate: p.tokenEstimate,
      embedding: embedded.vectors[i]!,
      metadata: p.metadata,
    }));
    const allowlist = dedupe([...extractAllowlistEntries(fullText), ...extraAllow]);

    await withTenant(deps.sql, tenantId, async (tx) => {
      await replaceSourceContent(tx, {
        tenantId,
        sourceId,
        embeddingModel: embedded.model,
        contentHash,
        chunks,
        allowlist,
        pagesFetched: pages,
      });
      await recordUsage(tx, { tenantId, embedTokens: embedded.usage.inputTokens });
      await deleteUpload(tx, sourceId);
    });
    return { status: 'ready', chunks: chunks.length, unchanged: false };
  } catch (e) {
    if (e instanceof IngestError) return fail(e.reason, e.detail);
    await fail('extraction_failed');
    throw e;
  }
}

function dedupe(entries: AllowlistEntry[]): AllowlistEntry[] {
  const seen = new Map<string, AllowlistEntry>();
  for (const e of entries) seen.set(`${e.kind}:${e.value}`, e);
  return [...seen.values()];
}
