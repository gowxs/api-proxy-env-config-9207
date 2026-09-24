import {
  reciprocalRankFusion,
  type DataOrigin,
  type EmbeddingProvider,
  type TokenUsage,
} from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import type { Sql } from 'postgres';
import { textSearch, vectorSearch, type RetrievedChunk } from './repo.ts';

const CANDIDATES = 20;
const MAX_QUERY_TERMS = 30;

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
 */
export async function retrieveKnowledge(
  deps: { sql: Sql; embeddings: EmbeddingProvider },
  args: { tenantId: string; query: string; origin: DataOrigin; limit?: number },
): Promise<{ chunks: (RetrievedChunk & { score: number })[]; usage: TokenUsage }> {
  const limit = args.limit ?? 6;
  const embedded = await deps.embeddings.embed([args.query.slice(0, 8_000)], 'query', args.origin);
  const [vector, text] = await withTenant(deps.sql, args.tenantId, (tx) =>
    Promise.all([
      vectorSearch(tx, {
        tenantId: args.tenantId,
        model: deps.embeddings.model,
        embedding: embedded.vectors[0]!,
        limit: CANDIDATES,
      }),
      textSearch(tx, {
        tenantId: args.tenantId,
        query: buildFtsQuery(args.query),
        limit: CANDIDATES,
      }),
    ]),
  );
  return { chunks: reciprocalRankFusion([vector, text], limit), usage: embedded.usage };
}
