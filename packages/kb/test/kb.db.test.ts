import { randomUUID } from 'node:crypto';
import { withTenant } from '@noctiv/db';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { FakeProvider } from '@noctiv/llm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  createFileSource,
  createSafeFetcher,
  ingestSource,
  loadAllowlist,
  retrieveKnowledge,
} from '../src/index.ts';
import { makePdf, serveSite } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 2, onnotice: () => {} });

const provider = new FakeProvider();
const fetcher = createSafeFetcher({ allowPrivateNetworks: true });
const deps = (embeddings = provider) => ({
  sql: worker,
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
    const { n } = (
      await owner<
        { n: number }[]
      >`select count(*)::int as n from public.kb_chunks where source_id = ${noteId}`
    )[0]!;
    expect(n).toBe(1);
    const allow = await withTenant(worker, A.tenantId, (tx) => loadAllowlist(tx));
    expect([...allow.emails]).not.toContain('help@nordlicht.test');
  });
});

describe('file ingestion (originals are not kept)', () => {
  it('extracts text from a staged upload and deletes the upload', async () => {
    const sourceId = await withTenant(worker, A.tenantId, async (tx) =>
      createFileSource(tx, {
        tenantId: A.tenantId,
        fileName: 'Preisliste 2026.pdf',
        bytes: await makePdf(['Price list', 'Gift set of three candles: 65 EUR']),
      }),
    );
    const [job] = await owner<{ queue: string; payload: { sourceId: string } }[]>`
      select queue, payload from public.jobs where tenant_id = ${A.tenantId} and payload->>'sourceId' = ${sourceId}`;
    expect(job).toEqual({ queue: 'kb.ingest', payload: { sourceId } });

    expect(await ingestSource(deps(), A.tenantId, sourceId)).toMatchObject({
      status: 'ready',
      unchanged: false,
    });
    const c = (
      await owner<
        { content: string }[]
      >`select content from public.kb_chunks where source_id = ${sourceId}`
    )[0];
    expect(c?.content).toContain('65 EUR');
    const left = (
      await owner<
        { n: number }[]
      >`select count(*)::int as n from public.kb_uploads where source_id = ${sourceId}`
    )[0]!;
    expect(left.n).toBe(0);
    const [src] = await owner<
      { title: string }[]
    >`select title from public.kb_sources where id = ${sourceId}`;
    expect(src?.title).toBe('Preisliste_2026.pdf');
  });

  it('rejects an unreadable file and does not keep it', async () => {
    const sourceId = await withTenant(worker, A.tenantId, (tx) =>
      createFileSource(tx, {
        tenantId: A.tenantId,
        fileName: 'broken.pdf',
        bytes: new TextEncoder().encode('%PDF-1.7 garbage'),
      }),
    );
    expect(await ingestSource(deps(), A.tenantId, sourceId)).toEqual({
      status: 'failed',
      reason: 'extraction_failed',
      retryable: false,
    });
    const left = (
      await owner<
        { n: number }[]
      >`select count(*)::int as n from public.kb_uploads where source_id = ${sourceId}`
    )[0]!;
    expect(left.n).toBe(0);
  });

  it('refuses disallowed file types before anything is stored', async () => {
    await expect(
      withTenant(worker, A.tenantId, (tx) =>
        createFileSource(tx, {
          tenantId: A.tenantId,
          fileName: 'x.png',
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0]),
        }),
      ),
    ).rejects.toThrow(/unsupported_type/);
  });

  it('a file source whose upload is gone fails without retrying', async () => {
    const sourceId = await addSource(A, { type: 'file', title: 'x.pdf' });
    expect(await ingestSource(deps(), A.tenantId, sourceId)).toEqual({
      status: 'failed',
      reason: 'upload_missing',
      retryable: false,
    });
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
    expect(await ingestSource(deps(p), B.tenantId, sourceId)).toEqual({
      status: 'failed',
      reason: 'free_tier_customer_data',
      retryable: false,
    });
    expect(p.embedCalls).toHaveLength(0);
    const { n } = (
      await owner<
        { n: number }[]
      >`select count(*)::int as n from public.kb_chunks where source_id = ${sourceId}`
    )[0]!;
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
    expect(await ingestSource(deps(p), T.tenantId, sourceId)).toMatchObject({
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

describe('embedding failures (found live: free-tier per-minute limit)', () => {
  class RateLimitedEmbeddings extends FakeProvider {
    override async embed(): Promise<never> {
      throw Object.assign(new Error('google_ai_studio request failed: rate_limited (HTTP 429)'), {
        name: 'LlmError',
        kind: 'rate_limited',
      });
    }
  }
  const status = (id: string) =>
    owner<
      { status: string; error: string | null }[]
    >`select status, error from public.kb_sources where id = ${id}`.then((r) => r[0]);

  it('keeps the real cause, and shows the source as waiting while a retry is coming', async () => {
    const T = await seedTenant(owner, 'kb-ratelimit', { embeddingAxis: 14 });
    const id = await addSource(T, {
      type: 'note',
      title: 'n',
      note_text: 'Prices and delivery times.',
    });
    const failing = new RateLimitedEmbeddings();
    expect(await ingestSource(deps(failing), T.tenantId, id, { finalAttempt: false })).toEqual({
      status: 'failed',
      reason: 'embedding_failed',
      retryable: true,
      detail: 'rate_limited',
      // For the worker log only; the source row keeps just reason:detail.
      diagnostic: 'LlmError: google_ai_studio request failed: rate_limited (HTTP 429)',
    });
    expect(await status(id)).toEqual({ status: 'pending', error: 'embedding_failed:rate_limited' });

    // Last attempt: now it is failed, with the same cause.
    await ingestSource(deps(failing), T.tenantId, id, { finalAttempt: true });
    expect(await status(id)).toEqual({ status: 'failed', error: 'embedding_failed:rate_limited' });

    // Once the provider works again, the same source becomes ready and the error is cleared.
    expect(await ingestSource(deps(), T.tenantId, id)).toMatchObject({ status: 'ready' });
    expect(await status(id)).toEqual({ status: 'ready', error: null });
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
    const { foreign } = (
      await owner<{ foreign: number }[]>`
      select count(*)::int as foreign from public.kb_chunks where id = any(${ids}::uuid[]) and tenant_id <> ${A.tenantId}`
    )[0]!;
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

// Production case 2026-09-28: the owner's note with the price lost its place
// to near-duplicate website chunks that matched the question better.
describe('retrieval: owner notes and repeated website text', () => {
  let C: SeededTenant;
  let noteId: string;
  const question =
    'Business website\nHi, how much does a business website cost and how long does it take?';

  beforeAll(async () => {
    C = await seedTenant(owner, 'kb-c', { embeddingAxis: 12 });
    noteId = await addSource(C, {
      type: 'note',
      title: 'Services and prices',
      note_text:
        'Services and prices (EUR, excl. VAT):\n- Landing page: €290\n- Business website (up to 6 pages): €490\n\nDelivery times:\n- Business website: 10 business days',
    });
    await ingestSource(deps(), C.tenantId, noteId);

    // One site, the same package text on many pages, each matching the question better than the note.
    const site = await addSource(C, {
      type: 'website',
      title: 'example.com',
      url: 'https://example.com/',
      status: 'ready',
    });
    const pages = ['', 'pricing/', 'services/', 'packages/', 'faq/', 'about/', 'contact/', 'blog/'];
    const texts = pages.map(
      (p) =>
        `${p || 'Home'} › Business website A business website for your business: how long does a business website take? ` +
        'A business website takes 3–7 business days. Business website, business website, business website.',
    );
    texts.push(
      'Our work › We built a business website for a bakery, a business website for a dentist and a business website for a gym.',
    );
    const vectors = await provider.embed(texts, 'document', 'test_fixture');
    for (const [i, content] of texts.entries()) {
      await owner`
        insert into public.kb_chunks (tenant_id, source_id, chunk_index, content, token_count, metadata, embedding, embedding_model)
        values (${C.tenantId}, ${site}, ${i}, ${content}, 40, ${owner.json({ url: `https://example.com/${pages[i] ?? 'work/'}` })},
                ${`[${vectors.vectors[i]!.join(',')}]`}, ${provider.model})`;
    }
  });

  it('keeps a place for the note and drops repeated website text', async () => {
    const { chunks } = await retrieveKnowledge(
      { sql: worker, embeddings: provider },
      { tenantId: C.tenantId, query: question, origin: 'customer_data' },
    );
    expect(chunks.length).toBeLessThanOrEqual(6);
    expect(chunks[0]!.content).toContain('Business website (up to 6 pages): €490');
    expect(chunks[0]!.source).toMatchObject({
      type: 'note',
      title: 'Services and prices',
      url: null,
    });
    expect(chunks[0]!.source.updatedAt).toBeInstanceOf(Date);
    // Eight copies of the package text become one; the "Our work" chunk keeps its own place.
    const copies = chunks.filter((c) => c.content.includes('takes 3–7 business days'));
    expect(copies).toHaveLength(1);
    expect(copies[0]!.source).toMatchObject({ type: 'website', url: 'https://example.com/' });
    expect(chunks.some((c) => c.content.startsWith('Our work'))).toBe(true);
  });

  // Production case 2026-09-28 (Latvian, tenant Wxs): "send an offer" in Latvian,
  // the prices in an English note, other notes closer to the words of the question.
  it('a price question in another language always gets the priced note', async () => {
    const D = await seedTenant(owner, 'kb-d', { embeddingAxis: 13 });
    const priced = await addSource(D, {
      type: 'note',
      title: 'WXS — services, prices and policies',
      note_text:
        'Services and prices (EUR, excl. VAT):\n- Landing page: €290\n- Business website (up to 6 pages): €490\n- Shopify online store: €690',
    });
    await ingestSource(deps(), D.tenantId, priced);
    for (const text of [
      'Biznesa mājaslapa: mēs izstrādājam biznesa mājaslapa un landing page ar jūsu saturu.',
      'Landing page un biznesa mājaslapa: teksti un attēli no klienta, piedāvājumu nosūtām e-pastā.',
      'Nosūti klientam piedāvājumu tikai pēc tam, kad saturs ir saņemts.',
    ]) {
      const id = await addSource(D, { type: 'note', title: 'Par mums', note_text: text });
      await ingestSource(deps(), D.tenantId, id);
    }
    // The website: many different pages, all closer to the words of the question.
    const site = await addSource(D, {
      type: 'website',
      title: 'wxs.test',
      url: 'https://wxs.test/',
      status: 'ready',
    });
    const topics = [
      'frizētava',
      'zobārsts',
      'kafejnīca',
      'sporta zāle',
      'ceptuve',
      'viesnīca',
      'autoserviss',
      'skola',
    ];
    const texts = topics.map(
      (t, i) =>
        `Darbi › ${t} Biznesa mājaslapa un landing page uzņēmumam ${t}: landing page, biznesa mājaslapa, ` +
        `piedāvājumu sagatavojām ${i + 2} dienās. Nosūti mums ziņu par savu landing page vai biznesa mājaslapa.`,
    );
    const vectors = await provider.embed(texts, 'document', 'test_fixture');
    for (const [i, content] of texts.entries()) {
      await owner`
        insert into public.kb_chunks (tenant_id, source_id, chunk_index, content, token_count, metadata, embedding, embedding_model)
        values (${D.tenantId}, ${site}, ${i}, ${content}, 40, ${owner.json({ url: `https://wxs.test/darbi/${i}/` })},
                ${`[${vectors.vectors[i]!.join(',')}]`}, ${provider.model})`;
    }
    const { chunks } = await retrieveKnowledge(
      { sql: worker, embeddings: provider },
      {
        tenantId: D.tenantId,
        query: 'Nosūti uz klients@example.test piedāvājumu: 1 biznesa mājaslapa un 1 landing page',
        origin: 'customer_data',
      },
    );
    expect(chunks.some((c) => c.content.includes('Business website (up to 6 pages): €490'))).toBe(
      true,
    );
    // The model's own search words ("biznesa mājaslapa") with the owner's price question.
    const byModel = await retrieveKnowledge(
      { sql: worker, embeddings: provider },
      {
        tenantId: D.tenantId,
        query: 'biznesa mājaslapa',
        origin: 'customer_data',
        priceQuestion: true,
      },
    );
    expect(byModel.chunks.some((c) => c.content.includes('€490'))).toBe(true);
  });

  it('a tenant with notes only gets them as before', async () => {
    const { chunks } = await retrieveKnowledge(
      { sql: worker, embeddings: provider },
      { tenantId: B.tenantId, query: 'How long is shipping to Germany?', origin: 'customer_data' },
    );
    expect(chunks.map((c) => c.source.type)).toEqual(chunks.map(() => 'note'));
    expect(chunks[0]!.content).toContain('Berlin warehouse');
  });
});
