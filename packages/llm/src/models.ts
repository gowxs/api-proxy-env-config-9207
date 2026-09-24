/**
 * Default models (chosen 2026-09-24 from Google's Gemini cookbook, which
 * lists what the Developer API serves; see README "LLM providers").
 * Both providers use the SAME names: embeddings from different models are
 * not comparable, and kb_chunks records the model per row.
 */
export const DEFAULT_MODELS = {
  /** Classification, verifier: cheap and quick. */
  fast: 'gemini-3.5-flash-lite',
  /** Reply generation. */
  quality: 'gemini-3.8-flash',
  /** Multilingual text embeddings with retrieval task types. */
  embedding: 'gemini-embedding-001',
} as const;

/** Thinking effort per tier (Gemini 3 thinking levels). */
export const THINKING_LEVEL = { fast: 'LOW', quality: 'LOW' } as const;

/**
 * Embedding models known to accept a retrieval task type. Others (e.g.
 * gemini-embedding-2) take task instructions inside the text instead, which
 * we have not implemented or verified yet.
 */
export const EMBEDDING_MODELS_WITH_TASK_TYPE = new Set(['gemini-embedding-001']);
