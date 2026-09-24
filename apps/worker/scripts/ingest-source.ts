/**
 * Ingests one knowledge source by hand (until the job queue arrives in step 7):
 *   node --env-file=.env apps/worker/scripts/ingest-source.ts <tenant_id> <source_id>
 */
import { createDb } from '@noctiv/db';
import { createSafeFetcher, ingestSource, SupabaseStorageBlobStore } from '@noctiv/kb';
import { createProviders, resolveLlmConfig } from '@noctiv/llm';
import { loadWorkerConfig } from '../src/config.ts';

const [tenantId, sourceId] = process.argv.slice(2);
if (!tenantId || !sourceId) {
  console.error('usage: ingest-source.ts <tenant_id> <source_id>');
  process.exit(1);
}
const config = loadWorkerConfig();
const db = createDb(config.WORKER_DATABASE_URL, { applicationName: 'noctiv-ingest' });
const { embeddings } = createProviders(resolveLlmConfig());
try {
  const outcome = await ingestSource(
    {
      sql: db.sql,
      embeddings,
      fetcher: createSafeFetcher(),
      blobs: new SupabaseStorageBlobStore({
        baseUrl: config.STORAGE_URL,
        token: config.STORAGE_TOKEN,
        apiKey: config.STORAGE_API_KEY,
      }),
    },
    tenantId,
    sourceId,
  );
  console.log(JSON.stringify(outcome));
} finally {
  await db.end();
}
