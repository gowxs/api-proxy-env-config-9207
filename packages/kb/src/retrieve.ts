import {
  dropNearDuplicates,
  reciprocalRankFusion,
  type DataOrigin,
  type EmbeddingProvider,
  type TokenUsage,
} from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import type { Sql } from 'postgres';
import {
  noteSearch,
  sourceInfo,
  textSearch,
  vectorSearch,
  type ChunkSource,
  type RetrievedChunk,
} from './repo.ts';

const CANDIDATES = 20;
const MAX_QUERY_TERMS = 30;
/** Places kept for the owner's notes, whatever the website ranking says. */
const NOTE_SLOTS = 2;

/**
 * Full-text query for Postgres websearch_to_tsquery: distinct words joined
 * with "or" (an email body as an AND query would almost never match).
 * Only letters and digits survive, so no query syntax can be injected.
 */
export function buildFtsQuery(text: string): string {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(
    (w, i, all) => all.indexOf(w) === i,
  );
  return words.slice(0, MAX_QUERY_TERMS).join(' or ');
}

/**
 * Hybrid retrieval for one inbound email: vector similarity and full-text
 * matches, merged with reciprocal rank fusion. Every query is scoped to the
 * tenant (explicit filter plus RLS) and to the current embedding model.
 *
 * The owner's notes are searched separately and their best chunks always
 * reach the model (up to NOTE_SLOTS), and near-duplicate chunks are dropped:
 * repeated website text used to crowd a note with the price out of the
 * excerpts (production case 2026-09-28). Each chunk carries its source's
 * type and date, so the prompt and the conflict check can prefer the newest
 * note over the website.
 */
export async function retrieveKnowledge(
  deps: { sql: Sql; embeddings: EmbeddingProvider },
  args: { tenantId: string; query: string; origin: DataOrigin; limit?: number },
): Promise<{
  chunks: (RetrievedChunk & { score: number; source: ChunkSource })[];
  usage: TokenUsage;
}> {
  const limit = args.limit ?? 6;
  const embedded = await deps.embeddings.embed([args.query.slice(0, 8_000)], 'query', args.origin);
  const embedding = embedded.vectors[0]!;
  const ftsQuery = buildFtsQuery(args.query);
  return withTenant(deps.sql, args.tenantId, async (tx) => {
    const [vector, text, notes] = await Promise.all([
      vectorSearch(tx, {
        tenantId: args.tenantId,
        model: deps.embeddings.model,
        embedding,
        limit: CANDIDATES,
      }),
      textSearch(tx, { tenantId: args.tenantId, query: ftsQuery, limit: CANDIDATES }),
      noteSearch(tx, {
        tenantId: args.tenantId,
        model: deps.embeddings.model,
        embedding,
        query: ftsQuery,
        limit: NOTE_SLOTS * 2,
      }),
    ]);
    const bestNotes = reciprocalRankFusion(notes, NOTE_SLOTS);
    const general = dropNearDuplicates(
      reciprocalRankFusion([vector, text], CANDIDATES * 2).filter(
        (c) => !bestNotes.some((n) => n.id === c.id),
      ),
    );
    const picked = [...bestNotes, ...general].slice(0, Math.max(limit, bestNotes.length));
    const sources = await sourceInfo(tx, [...new Set(picked.map((c) => c.sourceId))]);
    return {
      chunks: picked
        .filter((c) => sources.has(c.sourceId))
        .map((c) => ({ ...c, source: sources.get(c.sourceId)! })),
      usage: embedded.usage,
    };
  });
}
