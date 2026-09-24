/**
 * Live check of the configured provider (run once credentials exist):
 *   pnpm --filter @noctiv/llm check-models
 * Confirms each model is served (for Vertex: in the configured EU region),
 * that embeddings come back with the expected dimension, and that a tiny
 * JSON generation works. Uses only synthetic text (origin: test_fixture).
 */
import { ClassificationSchema, generateJson } from '@noctiv/core';
import { createProviders, GeminiBackend, resolveLlmConfig } from '../src/index.ts';

const providers = createProviders(resolveLlmConfig());
console.log('provider:', JSON.stringify(providers.description));

if (providers.llm instanceof GeminiBackend) {
  for (const r of await providers.llm.checkModels())
    console.log(r.ok ? 'OK  ' : 'FAIL', r.model, r.error ?? '');
}

const emb = await providers.embeddings.embed(
  ['Wie lange dauert der Versand?', 'Shipping takes 5 days.'],
  'document',
  'test_fixture',
);
console.log(
  'embedding model:',
  emb.model,
  'dims:',
  emb.vectors.map((v) => v.length),
);

const result = await generateJson(
  providers.llm,
  {
    tier: 'fast',
    origin: 'test_fixture',
    system:
      'Classify the email. Output JSON with keys category, sentiment, urgency, language, summary.',
    parts: [{ kind: 'untrusted_email', text: 'Hallo, was kostet eine Kerze?' }],
    maxOutputTokens: 512,
  },
  ClassificationSchema,
);
console.log(
  'generation:',
  result.ok ? JSON.stringify(result.value) : `INVALID: ${result.error}`,
  'usage:',
  JSON.stringify(result.usage),
  'model:',
  result.model,
);
