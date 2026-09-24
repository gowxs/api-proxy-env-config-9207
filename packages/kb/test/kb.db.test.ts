import { randomUUID } from 'node:crypto';
import { withTenant } from '@noctiv/db';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { FakeProvider } from '@noctiv/llm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createSafeFetcher,
  ingestSource,
  kbObjectPath,
  loadAllowlist,
  MemoryBlobStore,
  retrieveKnowledge,
  SupabaseStorageBlobStore,
  type BlobStore,
} from '../src/index.ts';
import { makePdf, serveSite } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 2, onnotice: () => {} });
const storageUrl = inject('storageUrl');
const storageToken = inject('storageToken');

const provider = new FakeProvider();
const fetcher = createSafeFetcher({ allowPrivateNetworks: true });
const deps = (blobs: BlobStore = new MemoryBlobStore(), embeddings = provider) => ({
  sql: worker,
  blobs,
  embeddings,
  fetcher,
  crawl: { delayMs: 0 },
});

let A: SeededTenant;
let B: SeededTenant;

beforeAll(async () => {
  A = await seedTenant(owner, 'kb-a', { embeddingAxis: 10 });
  B = await seedTenant(owner, 'kb-b', { embeddingAxis: 11 });
});
afterAll(() => Promise.all([owner.end(), worker.end()]));

async function addSource(t: SeededTenant, fields: Record<string, unknown>): Promise<string> {
  const id = randomUUID();
  await owner`insert into public.kb_sources ${owner({ id, tenant_id: t.tenantId, status: 'pending', ...fields } as never)}`;
  return id;
}

const sourceRow = (id: string) =>
  owner<
    {
      status: string;
      error: string | null;
      chunk_count: number;
      embedding_model: string | null;
      pages_fetched: number | null;
    }[]
  >`
    select status, error, chunk_count, embedding_model, pages_fetched from public.kb_sources where id = ${id}`.then(
    (r) => r[0]!,
  );

describe('note ingestion', () => {
  let noteId: string;
  const note =
    '# Shipping\n\nShipping within Latvia takes 2-3 business days. Track your parcel at https://track.nordlicht.test/status.\n\n# Contact\n\nWrite to help@nordlicht.test.';

  it('chunks, embeds and records the allowlist', async () => {
    noteId = await addSource(A, { type: 'note', title: 'FAQ', note_text: note });
    expect(await ingestSource(deps(), A.tenantId, noteId)).toEqual({
      status: 'ready',
      chunks: 2,
      unchanged: false,
    });
    expect(await sourceRow(noteId)).toMatchObject({
      status: 'ready',
      chunk_count: 2,
      embedding_model: 'fake-embedding',
    });
    const chunks = await owner<
      { content: string; embedding_model: string; metadata: { headings: string[] } }[]
    >`
      select content, embedding_model, metadata from public.kb_chunks where source_id = ${noteId} order by chunk_index`;
    expect(chunks.map((c) => c.metadata.headings)).toEqual([['Shipping'], ['Contact']]);
    const allow = await withTenant(worker, A.tenantId, (tx) => loadAllowlist(tx));
    expect([...allow.emails]).toContain('help@nordlicht.test');
    expect([...allow.urls]).toContain('track.nordlicht.test/status');
  });

  it('records embedding usage against the tenant budget', async () => {
    const [u] = await owner<
      { embed_tokens: string }[]
    >`select embed_tokens::text from public.usage_daily where tenant_id = ${A.tenantId}`;
    expect(Number(u?.embed_tokens)).toBeGreaterThan(0);
  });

  it('does not re-embed unchanged content, and replaces chunks when it changes', async () => {
    const calls = provider.embedCalls.length;
    expect(await ingestSource(deps(), A.tenantId, noteId)).toMatchObject({
      status: 'ready',
      unchanged: true,
    });
    expect(provider.embedCalls.length).toBe(calls);

    await owner`update public.kb_sources set note_text = 'Shipping within the EU takes 5 business days.' where id = ${noteId}`;
    expect(await ingestSource(deps(), A.tenantId, noteId)).toMatchObject({
      status: 'ready',
      chunks: 1,
      unchanged: false,
    });
    const [{ n }] = await owner<
      { n: number }[]
    >`select count(*)::int as n from public.kb_chunks where source_id = ${noteId}`;
    expect(n).toBe(1);
    const allow = await withTenant(worker, A.tenantId, (tx) => loadAllowlist(tx));
    expect([...allow.emails]).not.toContain('help@nordlicht.test');
  });
});

describe('file ingestion through Supabase Storage', () => {
  it.skipIf(!storageUrl)('reads an uploaded PDF from the private bucket', async () => {
    const blobs = new SupabaseStorageBlobStore({ baseUrl: storageUrl, token: storageToken });
    await blobs.ensureBucket();
    const sourceId = randomUUID();
    const path = kbObjectPath(A.tenantId, sourceId, 'prices.pdf');
    await blobs.put(
      A.tenantId,
      path,
      await makePdf(['Price list', 'Gift set of three candles: 65 EUR']),
      'application/pdf',
    );
    await owner`insert into public.kb_sources ${owner({
      id: sourceId,
      tenant_id: A.tenantId,
      type: 'file',
      title: 'prices.pdf',
      storage_path: path,
      mime_type: 'application/pdf',
    } as never)}`;
    expect(await ingestSource(deps(blobs), A.tenantId, sourceId)).toMatchObject({
      status: 'ready',
      unchanged: false,
    });
    const [c] = await owner<
      { content: string }[]
    >`select content from public.kb_chunks where source_id = ${sourceId}`;
    expect(c?.content).toContain('65 EUR');
  });

  it('marks the source failed (retryable) when the file is missing', async () => {
    const sourceId = await addSource(A, {
      type: 'file',
      title: 'x.pdf',
      storage_path: `${A.tenantId}/${randomUUID()}/x.pdf`,
    });
    expect(await ingestSource(deps(), A.tenantId, sourceId)).toEqual({
      status: 'failed',
      reason: 'storage_failed',
      retryable: true,
    });
    expect(await sourceRow(sourceId)).toMatchObject({ status: 'failed', error: 'storage_failed' });
  });

  it('the database refuses a storage path outside the tenant folder', async () => {
    await expect(
      addSource(A, { type: 'file', title: 'x', storage_path: `${B.tenantId}/x/y.pdf` }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('website ingestion', () => {
  it('crawls the site and allowlists its pages', async () => {
    const site = await serveSite({
      '/': {
        body: '<title>Nordlicht</title><main><h1>Welcome</h1><p>Soy candles, 24 EUR each.</p><a href="/faq">FAQ</a></main>',
      },
      '/faq': {
        body: '<title>FAQ</title><main><h2>Returns</h2><p>Returns accepted within 14 days.</p></main>',
      },
    });
    try {
      const sourceId = await addSource(A, {
        type: 'website',
        title: 'Website',
        url: `${site.base}/`,
      });
      expect(await ingestSource(deps(), A.tenantId, sourceId)).toMatchObject({ status: 'ready' });
      expect(await sourceRow(sourceId)).toMatchObject({ pages_fetched: 2 });
      const rows = await owner<
        { metadata: { url: string } }[]
      >`select metadata from public.kb_chunks where source_id = ${sourceId} order by chunk_index`;
      expect(rows.map((r) => new URL(r.metadata.url).pathname)).toEqual(['/', '/faq']);
    } finally {
      await site.close();
    }
  });
});

describe('free-tier rule (strict, founder decision)', () => {
  const freeTier = () => new FakeProvider({ trainingPolicy: 'may_train_on_data' });

  it('refuses a tenant whose mailboxes are not all test mailboxes, before embedding anything', async () => {
    const p = freeTier();
    const sourceId = await addSource(B, {
      type: 'note',
      title: 'n',
      note_text: 'Candles cost 24 EUR.',
    });
    expect(await ingestSource(deps(new MemoryBlobStore(), p), B.tenantId, sourceId)).toEqual({
      status: 'failed',
      reason: 'free_tier_customer_data',
      retryable: false,
    });
    expect(p.embedCalls).toHaveLength(0);
    const [{ n }] = await owner<
      { n: number }[]
    >`select count(*)::int as n from public.kb_chunks where source_id = ${sourceId}`;
    expect(n).toBe(0);
  });

  it('processes it once every mailbox of the tenant is a test mailbox', async () => {
    const p = freeTier();
    const T = await seedTenant(owner, 'kb-test-only', { embeddingAxis: 12 });
    await owner`update public.email_connections set is_test_mailbox = true where tenant_id = ${T.tenantId}`;
    const sourceId = await addSource(T, {
      type: 'note',
      title: 'n',
      note_text: 'Candles cost 24 EUR.',
    });
    expect(await ingestSource(deps(new MemoryBlobStore(), p), T.tenantId, sourceId)).toMatchObject({
      status: 'ready',
    });
    expect(p.embedCalls[0]!.origin).toBe('test_mailbox');
  });
});

describe('budget', () => {
  it('a halted tenant is not ingested (retryable once the day rolls over)', async () => {
    const T = await seedTenant(owner, 'kb-budget', { embeddingAxis: 13 });
    await owner`update public.tenants set daily_token_budget = 10 where id = ${T.tenantId}`;
    await owner`insert into public.usage_daily (tenant_id, day, tokens_in) values (${T.tenantId}, (now() at time zone 'utc')::date, 100)
                on conflict (tenant_id, day) do update set tokens_in = 100`;
    const sourceId = await addSource(T, { type: 'note', title: 'n', note_text: 'x y z' });
    expect(await ingestSource(deps(), T.tenantId, sourceId)).toEqual({
      status: 'failed',
      reason: 'budget_halted',
      retryable: true,
    });
  });
});

describe('retrieval', () => {
  beforeAll(async () => {
    for (const [t, text] of [
      [A, 'Shipping to Germany takes 5 business days. Shipping to Estonia takes 3 business days.'],
      [A, 'Our soy candles burn for 40 hours.'],
      [B, 'Shipping to Germany takes 9 business days from our Berlin warehouse.'],
    ] as const) {
      const id = await addSource(t, { type: 'note', title: 'n', note_text: text });
      await ingestSource(deps(), t.tenantId, id);
    }
  });

  it("finds the relevant chunk and never another tenant's", async () => {
    const { chunks } = await retrieveKnowledge(
      { sql: worker, embeddings: provider },
      { tenantId: A.tenantId, query: 'How long is shipping to Germany?', origin: 'customer_data' },
    );
    expect(chunks[0]!.content).toContain('Shipping to Germany takes 5 business days');
    expect(chunks.some((c) => c.content.includes('Berlin warehouse'))).toBe(false);
    const ids = chunks.map((c) => c.id);
    const [{ foreign }] = await owner<{ foreign: number }[]>`
      select count(*)::int as foreign from public.kb_chunks where id = any(${ids}::uuid[]) and tenant_id <> ${A.tenantId}`;
    expect(foreign).toBe(0);
  });

  it('keyword search survives query-syntax characters', async () => {
    const { chunks } = await retrieveKnowledge(
      { sql: worker, embeddings: provider },
      {
        tenantId: A.tenantId,
        query: `"soy" & !candles | (burn) <-> hours' OR 1=1 --`,
        origin: 'customer_data',
      },
    );
    expect(chunks.map((c) => c.content)).toContain('Our soy candles burn for 40 hours.');
  });
});
