import { randomUUID } from 'node:crypto';
import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { signQuoteToken } from '@noctiv/quotes';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const SECRET = 'q'.repeat(40);
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let A: SeededTenant;
let B: SeededTenant;

beforeAll(async () => {
  auth = await testAuth();
  app = buildApp({
    logger: createLogger({ service: 'api-test', level: 'silent' }),
    sql: apiSql,
    checkDatabase: async () => true,
    verifyToken: createTokenVerifier({ jwks: auth.jwks }),
    credentialsPublicKey: generateSealingKeyPair().publicKey,
    connectionTestWaitMs: 1_000,
    actionSecret: SECRET,
    publicApiUrl: 'https://app.noctiv.test/api',
    rateLimits: false,
  });
  A = await seedTenant(owner, 'quotes-a', { embeddingAxis: 140 });
  B = await seedTenant(owner, 'quotes-b', { embeddingAxis: 141 });
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

async function call(
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
  s: SeededTenant,
  path: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url: `/v1/tenants/${s.tenantId}${path}`,
    headers: { authorization: `Bearer ${await auth.token(s.userId)}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : undefined };
}

/** A pending quote draft on A's thread, with one line of `itemId` × qty. */
async function pendingQuote(
  s: SeededTenant,
  itemId: string,
  opts: { status?: string; validUntil?: string } = {},
) {
  const draftId = randomUUID();
  const quoteId = randomUUID();
  const n = Math.floor(Math.random() * 9000) + 1000;
  await owner`insert into public.drafts (id, tenant_id, thread_id, source_message_id, kind, to_address, subject, body)
              values (${draftId}, ${s.tenantId}, ${s.threadId}, ${s.messageId}, 'quote',
                      ${`customer-${s.label}@example.test`}, 'Re: Question', 'cover')`;
  await owner`insert into public.quotes
                (id, tenant_id, number, thread_id, lead_id, draft_id, status, language, customer_name,
                 customer_email, currency, vat_mode, vat_rate, subtotal_cents, vat_cents, total_cents, valid_until)
              values (${quoteId}, ${s.tenantId}, ${`Q-2026-${n}`}, ${s.threadId}, ${s.leadId}, ${draftId},
                      ${opts.status ?? 'pending_approval'}, 'en', 'Anna Berzina', ${`customer-${s.label}@example.test`},
                      'EUR', 'exclusive', 21, 2400, 504, 2904,
                      ${opts.validUntil ?? new Date(Date.now() + 14 * 86400_000).toISOString().slice(0, 10)})`;
  await owner`insert into public.quote_lines
                (tenant_id, quote_id, position, price_item_id, name, unit, qty, unit_price_cents, line_total_cents)
              values (${s.tenantId}, ${quoteId}, 0, ${itemId}, 'Lavender candle', 'pcs', 1, 2400, 2400)`;
  return { draftId, quoteId };
}

describe('quote settings', () => {
  it('are off by default and saved through the tenant settings', async () => {
    expect((await call('GET', A, '')).json).toMatchObject({
      quotes_enabled: false,
      quotes_currency: 'EUR',
      quotes_vat_mode: 'exclusive',
      quotes_vat_rate: 21,
      quotes_validity_days: 14,
      quotes_auto_send_limit_cents: 50000,
    });
    const r = await call('PATCH', A, '', {
      quotesEnabled: true,
      quotesVatRate: 5.5,
      quotesAutoSendLimit: '750,00',
      quotesCurrency: 'eur',
    });
    expect(r.status).toBe(200);
    expect((await call('GET', A, '')).json).toMatchObject({
      quotes_enabled: true,
      quotes_vat_rate: 5.5,
      quotes_auto_send_limit_cents: 75000,
    });
    expect((await call('PATCH', A, '', { quotesVatRate: 21.555 })).status).toBe(400);
    await call('PATCH', A, '', { quotesVatRate: 21 });
  });
});

describe('price list', () => {
  let candle: string;

  it('adds, edits and lists items (manual items are confirmed)', async () => {
    const r = await call('POST', A, '/price-items', {
      name: 'Lavender candle',
      unit: 'pcs',
      unitPrice: '24,00',
      minQty: 1,
      maxQty: 50,
    });
    expect(r.status).toBe(200);
    candle = r.json.id;
    expect(
      (await call('PATCH', A, `/price-items/${candle}`, { vatNote: 'standard rate' })).status,
    ).toBe(200);
    const list = (await call('GET', A, '/price-items')).json;
    expect(list.find((i: { id: string }) => i.id === candle)).toMatchObject({
      name: 'Lavender candle',
      unit_price_cents: 2400,
      min_qty: 1,
      max_qty: 50,
      vat_note: 'standard rate',
      status: 'confirmed',
      source: 'manual',
    });
    expect(
      (await call('GET', B, '/price-items')).json.map((i: { id: string }) => i.id),
    ).not.toContain(candle);
  });

  it('rejects a bad price and min above max', async () => {
    expect(
      (await call('POST', A, '/price-items', { name: 'X', unit: 'pcs', unitPrice: 'free' })).status,
    ).toBe(400);
    expect(
      (
        await call('POST', A, '/price-items', {
          name: 'X',
          unit: 'pcs',
          unitPrice: '1',
          minQty: 5,
          maxQty: 2,
        })
      ).status,
    ).toBe(400);
  });

  it('checks a CSV first, then imports only the good rows', async () => {
    const csv = 'name;unit;unit_price\nGift box;pcs;4,50\n;pcs;3\nWrapping;pcs;abc\n';
    const dry = await call('POST', A, '/price-items/csv', { csv, dryRun: true });
    expect(dry.json.imported).toBe(0);
    expect(dry.json.rows).toEqual([
      { line: 2, name: 'Gift box', unit: 'pcs', unit_price_cents: 450, error: null },
      expect.objectContaining({ line: 3, error: 'name is empty' }),
      expect.objectContaining({ line: 4, error: expect.stringContaining('not a price') }),
    ]);
    const real = await call('POST', A, '/price-items/csv', { csv, dryRun: false });
    expect(real.json.imported).toBe(1);
    const [row] = await owner<{ status: string; source: string }[]>`
      select status, source from public.price_items where tenant_id = ${A.tenantId} and name = 'Gift box'`;
    expect(row).toEqual({ status: 'confirmed', source: 'csv' });
  });

  it('stores an uploaded price list as text and queues parsing', async () => {
    const r = await call('POST', A, '/price-imports', {
      fileName: 'prices.txt',
      contentBase64: Buffer.from('Lavender candle 24.00 EUR\nGift box 4.50 EUR').toString('base64'),
    });
    expect(r.status).toBe(200);
    const [job] = await owner<{ queue: string; payload: { importId: string } }[]>`
      select queue, payload from public.jobs where tenant_id = ${A.tenantId} and queue = 'quotes.import'`;
    expect(job?.payload.importId).toBe(r.json.id);
    const list = (await call('GET', A, '/price-imports')).json;
    expect(list[0]).toMatchObject({ file_name: 'prices.txt', status: 'pending' });
  });

  it('draft items cannot be quoted until confirmed', async () => {
    const [draft] = await owner<{ id: string }[]>`
      insert into public.price_items (tenant_id, name, unit, unit_price_cents, status, source)
      values (${A.tenantId}, 'Imported mug', 'pcs', 900, 'draft', 'file') returning id`;
    const { quoteId } = await pendingQuote(A, candle);
    const bad = await call('PATCH', A, `/quotes/${quoteId}`, {
      lines: [{ priceItemId: draft!.id, qty: 1 }],
    });
    expect(bad.status).toBe(400);
    expect((await call('POST', A, '/price-items/confirm-all', {})).json.confirmed).toBe(1);
    const ok = await call('PATCH', A, `/quotes/${quoteId}`, {
      lines: [{ priceItemId: draft!.id, qty: 1 }],
    });
    expect(ok.status).toBe(200);
  });

  it('editing lines recomputes totals from the price list and rewrites the cover reply', async () => {
    const { quoteId, draftId } = await pendingQuote(A, candle);
    const [box] = await owner<{ id: string }[]>`
      select id from public.price_items where tenant_id = ${A.tenantId} and name = 'Gift box'`;
    const r = await call('PATCH', A, `/quotes/${quoteId}`, {
      lines: [
        { priceItemId: candle, qty: 3, customerText: 'three candles' },
        { priceItemId: box!.id, qty: 2.5 },
      ],
      notes: 'Delivery included.',
    });
    expect(r.status).toBe(200);
    // 3 × 24.00 + 2.5 × 4.50 = 83.25; VAT 21% = 17.48 (half-up); total 100.73.
    expect(r.json).toMatchObject({
      subtotal_cents: 8325,
      vat_cents: 1748,
      total_cents: 10073,
      notes: 'Delivery included.',
      lines: [
        { name: 'Lavender candle', qty: 3, unit_price_cents: 2400, line_total_cents: 7200 },
        { name: 'Gift box', qty: 2.5, unit_price_cents: 450, line_total_cents: 1125 },
      ],
    });
    const [d] = await owner<{ body: string; edited: boolean }[]>`
      select body, edited from public.drafts where id = ${draftId}`;
    expect(d!.edited).toBe(true);
    expect(d!.body).toContain('Hello Anna,');
    expect(d!.body).toContain('€100.73 including VAT');
    expect(d!.body).toContain('https://app.noctiv.test/api/q/q1.');
    // The conversation page gets the quote with its lines.
    const conv = (await call('GET', A, `/conversations/${A.threadId}`)).json;
    expect(conv.quotes.find((q: { id: string }) => q.id === quoteId)?.total_cents).toBe(10073);
  });

  it('a sent quote cannot be edited, and another tenant cannot touch it', async () => {
    const { quoteId } = await pendingQuote(A, candle, { status: 'sent' });
    expect((await call('PATCH', A, `/quotes/${quoteId}`, { notes: 'late change' })).status).toBe(
      409,
    );
    const { quoteId: q2 } = await pendingQuote(A, candle);
    expect((await call('PATCH', B, `/quotes/${q2}`, { notes: 'x' })).status).toBe(404);
  });

  it('rejecting a quote draft marks the quote as not sent', async () => {
    const { quoteId, draftId } = await pendingQuote(A, candle);
    expect((await call('POST', A, `/drafts/${draftId}/reject`, {})).status).toBe(200);
    const [q] = await owner<
      { status: string }[]
    >`select status from public.quotes where id = ${quoteId}`;
    expect(q!.status).toBe('rejected');
  });

  it('lists quotes for the Quotes page', async () => {
    const list = (await call('GET', A, '/quotes')).json;
    expect(list.length).toBeGreaterThan(3);
    expect(list[0]).toHaveProperty('lines');
    expect((await call('GET', B, '/quotes')).json.every((q: { number: string }) => q.number)).toBe(
      true,
    );
  });

  describe('customer accept link', () => {
    const link = (tenantId: string, quoteId: string, validUntil: string) =>
      `/q/${signQuoteToken({ tenantId, quoteId, validUntil: new Date(validUntil) }, SECRET)}`;
    const future = () => new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);

    it('shows the quote, marks it viewed, and accepting moves the lead and notifies the owner', async () => {
      const valid = future();
      const { quoteId } = await pendingQuote(A, candle, { status: 'sent', validUntil: valid });
      const url = link(A.tenantId, quoteId, valid);
      const view = await app.inject({ method: 'GET', url });
      expect(view.statusCode).toBe(200);
      expect(view.headers['content-security-policy']).toContain("default-src 'none'");
      expect(view.body).toContain('Accept quote');
      expect(view.body).toContain('€29.04');
      expect(view.body).not.toContain('<script');
      let [q] = await owner<
        { status: string }[]
      >`select status from public.quotes where id = ${quoteId}`;
      expect(q!.status).toBe('viewed');

      // With Documents on, accepting queues the invoice automation (PLAN.md §22.11).
      await owner`update public.tenants set documents_enabled = true where id = ${A.tenantId}`;
      const accept = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      await owner`update public.tenants set documents_enabled = false where id = ${A.tenantId}`;
      const jobs = await owner<{ payload: Record<string, unknown> }[]>`
        select payload from public.jobs
        where tenant_id = ${A.tenantId} and queue = 'documents.automation'
          and payload->>'quoteId' = ${quoteId}`;
      expect(jobs.map((j) => j.payload)).toEqual([{ event: 'quote_accepted', quoteId }]);
      expect(accept.statusCode).toBe(200);
      expect(accept.body).toContain('You accepted this quote');
      [q] = await owner<
        { status: string }[]
      >`select status from public.quotes where id = ${quoteId}`;
      expect(q!.status).toBe('accepted');
      const [lead] = await owner<
        { stage: string }[]
      >`select stage from public.leads where id = ${A.leadId}`;
      expect(lead!.stage).toBe('accepted');
      const [n] = await owner<{ kind: string; payload: { quoteId: string } }[]>`
        select kind, payload from public.notifications
        where tenant_id = ${A.tenantId} and kind = 'quote_accepted' and payload->>'quoteId' = ${quoteId}`;
      expect(n?.kind).toBe('quote_accepted');

      // A second click changes nothing.
      const again = await app.inject({ method: 'POST', url, payload: '' });
      expect(again.body).toContain('You accepted this quote');
      expect(again.body).not.toContain('Accept quote</button>');
    });

    it('an expired quote cannot be accepted', async () => {
      const past = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
      const { quoteId } = await pendingQuote(A, candle, { status: 'sent', validUntil: past });
      const url = link(A.tenantId, quoteId, past);
      const view = await app.inject({ method: 'GET', url });
      expect(view.body).toContain('This quote has expired');
      expect(view.body).not.toContain('Accept quote</button>');
      await app.inject({ method: 'POST', url, payload: '' });
      const [q] = await owner<
        { status: string }[]
      >`select status from public.quotes where id = ${quoteId}`;
      expect(q!.status).toBe('expired');
    });

    it('a quote not sent yet, a bad token and a forged tenant show nothing', async () => {
      const valid = future();
      const { quoteId } = await pendingQuote(A, candle, { validUntil: valid });
      expect(
        (await app.inject({ method: 'GET', url: link(A.tenantId, quoteId, valid) })).statusCode,
      ).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/q/q1.abc.def' })).statusCode).toBe(404);
      const { quoteId: sent } = await pendingQuote(A, candle, {
        status: 'sent',
        validUntil: valid,
      });
      const forged = await app.inject({ method: 'GET', url: link(B.tenantId, sent, valid) });
      expect(forged.statusCode).toBe(404);
      const [q] = await owner<
        { status: string }[]
      >`select status from public.quotes where id = ${sent}`;
      expect(q!.status).toBe('sent');
    });

    it("speaks the customer's language (page, notes, PDF name)", async () => {
      const valid = future();
      const { quoteId } = await pendingQuote(A, candle, { status: 'sent', validUntil: valid });
      await owner`update public.quotes set language = 'lv' where id = ${quoteId}`;
      const url = link(A.tenantId, quoteId, valid);
      const view = await app.inject({ method: 'GET', url });
      expect(view.body).toContain('<html lang="lv">');
      expect(view.body).toContain('Piedāvājums');
      expect(view.body).toContain('Apstiprināt piedāvājumu');
      expect(view.body).toContain('PVN 21%');
      expect(view.body).toMatch(/29,04\s€/);
      expect(view.body).not.toContain('Accept quote');
      const done = await app.inject({ method: 'POST', url, payload: '' });
      expect(done.body).toContain('Jūs apstiprinājāt šo piedāvājumu');
      const pdf = await app.inject({ method: 'GET', url: `${url}/pdf` });
      expect(pdf.headers['content-disposition']).toContain('Piedavajums-Q-2026-');
    });

    it('a bad link answers in the browser language', async () => {
      const r = await app.inject({
        method: 'GET',
        url: '/q/q1.abc.def',
        headers: { 'accept-language': 'de-DE,de;q=0.9' },
      });
      expect(r.statusCode).toBe(404);
      expect(r.body).toContain('Link ungültig');
      expect(r.body).toContain('<html lang="de">');
    });

    it('downloads the PDF', async () => {
      const valid = future();
      const { quoteId } = await pendingQuote(A, candle, { status: 'sent', validUntil: valid });
      const res = await app.inject({
        method: 'GET',
        url: `${link(A.tenantId, quoteId, valid)}/pdf`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    });
  });
});
