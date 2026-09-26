import { randomUUID } from 'node:crypto';
import type { GenerateRequest } from '@noctiv/core';
import { withTenant, type Job } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { createSafeFetcher } from '@noctiv/kb';
import { FakeProvider } from '@noctiv/llm';
import type { InboundMessage } from '@noctiv/mail';
import { simpleParser } from 'mailparser';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { storeInbound } from '../src/ingest/store.ts';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { quotesImportHandler } from '../src/jobs/quotes-import.ts';
import { processMessage } from '../src/pipeline/process.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, keys, readFolder } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
const QUOTES = { secret: 's'.repeat(40), publicApiUrl: 'https://app.noctiv.test/api' };

type Kind = 'classify' | 'map' | 'generate' | 'verify' | 'import';
const kindOf = (req: GenerateRequest): Kind =>
  req.system.startsWith('You classify')
    ? 'classify'
    : req.system.startsWith("You map a customer's price request")
      ? 'map'
      : req.system.startsWith('You read a small business price list')
        ? 'import'
        : req.system.startsWith('You check a draft')
          ? 'verify'
          : 'generate';

const quoteRequest = JSON.stringify({
  category: 'quote_request',
  sentiment: 'neutral',
  urgency: 'normal',
  language: 'en',
  summary: 'Customer asks for a price for candles and gift boxes.',
});

/** The price-list label the mapping prompt gave an item ("P2"). */
const labelFor = (req: GenerateRequest, name: string) => {
  const list = req.parts.find((p) => p.kind === 'kb_context')?.text ?? '';
  return new RegExp(`(P\\d+): ${name}`).exec(list)?.[1] ?? 'P99';
};

/** Fake model: classifies as a quote request and maps with `lines(req)`. */
function model(
  lines: (req: GenerateRequest) => { item: string; qty: number; customer_text: string }[],
  unmapped: string[] = [],
) {
  return new FakeProvider({
    responder: (req) => {
      switch (kindOf(req)) {
        case 'classify':
          return quoteRequest;
        case 'map':
          return JSON.stringify({ lines: lines(req), unmapped, language: 'en' });
        case 'verify':
          return '{"supported":true,"unsupported_claims":[]}';
        default:
          return JSON.stringify({
            intent: 'price',
            language: 'en',
            reply: 'Thanks, we will check.',
            sources: [],
            confidence: 0.2,
            action: 'escalate',
            escalate_reason: 'no source',
          });
      }
    },
  });
}
const candlesAndBoxes = (req: GenerateRequest) => [
  { item: labelFor(req, 'Lavender candle'), qty: 3, customer_text: '3 lavender candles' },
  { item: labelFor(req, 'Gift box'), qty: 2, customer_text: '2 gift boxes' },
];

function inbound(text: string, from = 'anna@example-mail.test'): InboundMessage {
  return {
    messageId: `<${randomUUID()}@example-mail.test>`,
    inReplyTo: null,
    references: [],
    from: { address: from, name: 'Anna Berzina' },
    replyTo: [],
    to: ['shop@nordlicht.test'],
    cc: [],
    subject: 'Price request',
    text,
    htmlHiddenText: false,
    loopHeaders: {},
    attachments: [],
    date: new Date(),
  };
}

async function tenant(label: string, mode: 'draft_only' | 'auto_send' = 'draft_only') {
  const t = await seedTenant(owner, label, { embeddingAxis: 150 });
  await owner`update public.tenants set mode = ${mode}, quotes_enabled = true, name = 'Nordlicht Candles',
                max_ai_replies_per_sender_24h = 2 where id = ${t.tenantId}`;
  await owner`insert into public.price_items (tenant_id, name, unit, unit_price_cents, min_qty, max_qty, status)
              values (${t.tenantId}, 'Lavender candle', 'pcs', 2400, 1, 50, 'confirmed'),
                     (${t.tenantId}, 'Gift box', 'pcs', 450, null, null, 'confirmed'),
                     (${t.tenantId}, 'Secret draft item', 'pcs', 100, null, null, 'draft')`;
  return t;
}

async function run(t: SeededTenant, llm: FakeProvider, text: string, quotes = true) {
  const id = await withTenant(worker, t.tenantId, (tx) =>
    storeInbound(tx, {
      tenantId: t.tenantId,
      connectionId: t.connectionId,
      uid: Math.floor(Math.random() * 1e6),
      msg: inbound(text),
    }),
  );
  const outcome = await processMessage(
    { sql: worker, llm, embeddings: new FakeProvider(), ...(quotes ? { quotes: QUOTES } : {}) },
    t.tenantId,
    id!,
  );
  return { outcome, messageId: id! };
}

const quoteFor = async (messageId: string) =>
  (
    await owner<
      {
        id: string;
        number: string;
        status: string;
        subtotal_cents: number;
        vat_cents: number;
        total_cents: number;
        hold_reasons: string[];
        draft_id: string;
      }[]
    >`select id, number, status, subtotal_cents, vat_cents, total_cents, hold_reasons, draft_id
      from public.quotes where source_message_id = ${messageId}`
  )[0];

afterAll(() => Promise.all([owner.end(), worker.end()]));

describe('quote drafting', () => {
  let T: SeededTenant;
  beforeAll(async () => {
    T = await tenant('quotes-mode1');
  });

  it('mode 1: a quote waits for approval; every number comes from the price list', async () => {
    const llm = model(candlesAndBoxes);
    const { outcome, messageId } = await run(
      T,
      llm,
      'Hello, what would 3 lavender candles and 2 gift boxes cost?',
    );
    expect(outcome).toMatchObject({ status: 'drafted', reasons: ['tenant_draft_only'] });
    const q = (await quoteFor(messageId))!;
    // 3 × 24.00 + 2 × 4.50 = 81.00; VAT 21% = 17.01; total 98.01.
    expect(q).toMatchObject({
      status: 'pending_approval',
      subtotal_cents: 8100,
      vat_cents: 1701,
      total_cents: 9801,
    });
    expect(q.number).toMatch(/^Q-\d{4}-0001$/);
    const [d] = await owner<{ kind: string; status: string; body: string }[]>`
      select kind, status, body from public.drafts where id = ${q.draft_id}`;
    expect(d).toMatchObject({ kind: 'quote', status: 'pending_approval' });
    expect(d!.body).toContain('Hello Anna,');
    expect(d!.body).toContain('3 × Lavender candle; 2 × Gift box, €98.01 including VAT');
    expect(d!.body).toContain('https://app.noctiv.test/api/q/q1.');
    // The model never saw a price, nor a draft item.
    const map = llm.calls.find((c) => kindOf(c) === 'map')!;
    const list = map.parts.find((p) => p.kind === 'kb_context')!.text;
    expect(list).not.toMatch(/24|4[.,]50/);
    expect(list).not.toContain('Secret draft item');
    const [n] = await owner<{ kind: string }[]>`
      select kind from public.notifications where tenant_id = ${T.tenantId} and dedupe_key = ${`draft:${q.draft_id}`}`;
    expect(n?.kind).toBe('draft_ready');
    // A second quote gets the next number.
    const second = await run(
      T,
      model(candlesAndBoxes),
      'And 3 lavender candles with 2 gift boxes again?',
    );
    expect((await quoteFor(second.messageId))!.number).toMatch(/-0002$/);
  });

  it('a quantity the customer did not write → one clarifying question and the owner is told', async () => {
    const { outcome, messageId } = await run(
      T,
      model((req) => [
        { item: labelFor(req, 'Lavender candle'), qty: 7, customer_text: 'some candles' },
      ]),
      'How much for some lavender candles?',
    );
    expect(outcome.status).toBe('drafted');
    expect(await quoteFor(messageId)).toBeUndefined();
    const [d] = await owner<{ kind: string; body: string }[]>`
      select kind, body from public.drafts where source_message_id = ${messageId}`;
    expect(d!.kind).toBe('reply');
    expect(d!.body).toContain('“some candles”');
    expect(d!.body).not.toMatch(/€|\d+[.,]\d\d/);
    const [n] = await owner<{ payload: { questionSent: boolean } }[]>`
      select payload from public.notifications
      where tenant_id = ${T.tenantId} and kind = 'quote_needs_you' and dedupe_key = ${`quote_needs_you:${messageId}`}`;
    expect(n!.payload.questionSent).toBe(false);
  });

  it('items not on the price list → clarifying question, no quote', async () => {
    const { messageId } = await run(
      T,
      model(() => [], ['a wedding cake']),
      'Could you quote a wedding cake?',
    );
    expect(await quoteFor(messageId)).toBeUndefined();
    const [d] = await owner<{ body: string }[]>`
      select body from public.drafts where source_message_id = ${messageId}`;
    expect(d!.body).toContain('“a wedding cake”');
  });

  it('with quotes off, a quote request is answered like any sales inquiry', async () => {
    const off = await tenant('quotes-off');
    await owner`update public.tenants set quotes_enabled = false where id = ${off.tenantId}`;
    const llm = model(candlesAndBoxes);
    const { messageId } = await run(off, llm, 'What would 3 lavender candles cost?');
    expect(llm.calls.some((c) => kindOf(c) === 'map')).toBe(false);
    expect(llm.calls.some((c) => kindOf(c) === 'generate')).toBe(true);
    expect(await quoteFor(messageId)).toBeUndefined();
  });
});

describe('quote numbers', () => {
  it('restart every year and stay unique per tenant', async () => {
    const T = await tenant('quotes-numbers');
    const other = await tenant('quotes-numbers-other');
    const year = new Date().getUTCFullYear();
    const insert = (t: SeededTenant, number: string) =>
      owner`insert into public.quotes (tenant_id, number, thread_id, status, customer_email, currency,
                                       vat_mode, vat_rate, subtotal_cents, vat_cents, total_cents, valid_until)
            values (${t.tenantId}, ${number}, ${t.threadId}, 'sent', 'x@example.test', 'EUR', 'none', 0,
                    100, 0, 100, current_date + 14)`;
    // Last year's numbers do not count; another tenant's numbers do not count.
    await insert(T, `Q-${year - 1}-0041`);
    await insert(other, `Q-${year}-0077`);
    const first = await run(
      T,
      model(candlesAndBoxes),
      'Price for 3 lavender candles and 2 gift boxes?',
    );
    expect((await quoteFor(first.messageId))!.number).toBe(`Q-${year}-0001`);
    const second = await run(
      T,
      model(candlesAndBoxes),
      'And 3 lavender candles, 2 gift boxes again?',
    );
    expect((await quoteFor(second.messageId))!.number).toBe(`Q-${year}-0002`);
    // A duplicate number is refused by the database.
    await expect(insert(T, `Q-${year}-0002`)).rejects.toMatchObject({ code: '23505' });
  });
});

describe('quote auto-send (mode 2)', () => {
  let T: SeededTenant;
  beforeAll(async () => {
    T = await tenant('quotes-mode2', 'auto_send');
  });

  it('under the limit with every line mapped → sent automatically', async () => {
    const { outcome, messageId } = await run(
      T,
      model(candlesAndBoxes),
      'Hi! Price for 3 lavender candles and 2 gift boxes please.',
    );
    expect(outcome).toEqual({ status: 'auto_send', reasons: [] });
    const q = (await quoteFor(messageId))!;
    const [d] = await owner<{ status: string; decided_by: string }[]>`
      select status, decided_by from public.drafts where id = ${q.draft_id}`;
    expect(d).toEqual({ status: 'approved', decided_by: 'auto' });
    const [job] = await owner<{ queue: string }[]>`
      select queue from public.jobs where tenant_id = ${T.tenantId} and payload->>'draftId' = ${q.draft_id}`;
    expect(job?.queue).toBe(QUEUES.mailSend);
  });

  it('over the limit → held for approval', async () => {
    const { outcome, messageId } = await run(
      T,
      model((req) => [
        { item: labelFor(req, 'Lavender candle'), qty: 30, customer_text: '30 candles' },
      ]),
      'We need 30 lavender candles for an event.',
    );
    // 30 × 24.00 = 720.00 + VAT > 500.00
    expect(outcome).toEqual({ status: 'drafted', reasons: ['quote_over_limit'] });
    expect((await quoteFor(messageId))!.hold_reasons).toEqual(['quote_over_limit']);
  });

  it('above an item’s maximum → clarifying question instead of a quote', async () => {
    const { messageId } = await run(
      T,
      model((req) => [
        { item: labelFor(req, 'Lavender candle'), qty: 80, customer_text: '80 candles' },
      ]),
      'Price for 80 lavender candles?',
    );
    expect(await quoteFor(messageId)).toBeUndefined();
    const [d] = await owner<{ body: string; status: string }[]>`
      select body, status from public.drafts where source_message_id = ${messageId}`;
    expect(d!.body).toContain('For Lavender candle we can quote 1–50 pcs.');
    // It states no facts, so it follows the mode like any reply.
    expect(d!.status).toBe('approved');
  });
});

describe('sending a quote', () => {
  const shop = GREENMAIL_USERS.quoteShop;
  const customer = GREENMAIL_USERS.quoteCustomer;

  it('attaches the PDF, marks the quote sent and the lead quoted', async () => {
    const T = await tenant('quotes-send');
    const connectionId = await addGreenmailConnection(owner, gm, {
      tenantId: T.tenantId,
      address: shop.address,
      password: shop.password,
      displayName: 'Nordlicht Candles',
    });
    await owner`update public.threads set connection_id = ${connectionId} where tenant_id = ${T.tenantId}`;
    const [lead] = await owner<{ id: string }[]>`
      insert into public.leads (tenant_id, email, stage) values (${T.tenantId}, ${customer.address}, 'drafted') returning id`;
    const [draft] = await owner<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                                 status, decided_by, decided_at)
      values (${T.tenantId}, ${T.threadId}, ${T.messageId}, 'quote', ${customer.address}, 'Re: Price request',
              'Please find our quote attached.', 'approved', 'owner', now()) returning id`;
    await owner`update public.threads set lead_id = ${lead!.id} where id = ${T.threadId}`;
    const [q] = await owner<{ id: string }[]>`
      insert into public.quotes (tenant_id, number, thread_id, lead_id, draft_id, status, customer_email, currency,
                                 vat_mode, vat_rate, subtotal_cents, vat_cents, total_cents, valid_until)
      values (${T.tenantId}, 'Q-2026-0042', ${T.threadId}, ${lead!.id}, ${draft!.id}, 'pending_approval',
              ${customer.address}, 'EUR', 'exclusive', 21, 2400, 504, 2904, current_date + 14) returning id`;
    await owner`insert into public.quote_lines (tenant_id, quote_id, position, name, unit, qty, unit_price_cents, line_total_cents)
                values (${T.tenantId}, ${q!.id}, 0, 'Lavender candle', 'pcs', 1, 2400, 2400)`;

    const send = mailSendHandler({
      sql: worker,
      keys,
      allowInsecure: true,
      quotes: { ...QUOTES, fetchLogo: createSafeFetcher() },
    });
    const job: Job = {
      id: randomUUID(),
      tenantId: T.tenantId,
      queue: QUEUES.mailSend,
      payload: { draftId: draft!.id },
      attempts: 1,
      maxAttempts: 5,
    };
    expect(await send(job)).toEqual({ status: 'sent' });

    const mails = (await readFolder(gm, customer)).filter((m) => m.raw.includes('Q-2026-0042'));
    expect(mails).toHaveLength(1);
    const parsed = await simpleParser(mails[0]!.raw);
    expect(parsed.text).toContain('Please find our quote attached.');
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      ['Quote-Q-2026-0042.pdf', 'application/pdf'],
    ]);
    expect(parsed.attachments[0]!.content.subarray(0, 5).toString('latin1')).toBe('%PDF-');

    const [after] = await owner<{ status: string; sent_at: Date | null }[]>`
      select status, sent_at from public.quotes where id = ${q!.id}`;
    expect(after!.status).toBe('sent');
    expect(after!.sent_at).not.toBeNull();
    const [l] = await owner<
      { stage: string }[]
    >`select stage from public.leads where id = ${lead!.id}`;
    expect(l!.stage).toBe('quoted');
  });
});

describe('price list import', () => {
  it('keeps only items whose price is written in the document, as drafts', async () => {
    const T = await tenant('quotes-import');
    const text =
      'Nordlicht price list 2026\nLavender candle ........ 24,00 EUR\nGift box ...... 4,50 EUR';
    const [imp] = await owner<{ id: string }[]>`
      insert into public.price_imports (tenant_id, file_name, extracted_text) values (${T.tenantId}, 'prices.pdf', ${text})
      returning id`;
    const llm = new FakeProvider({
      responder: () =>
        JSON.stringify({
          items: [
            {
              name: 'Lavender candle',
              description: null,
              unit: 'pcs',
              price: '24,00',
              min_qty: null,
              max_qty: null,
            },
            {
              name: 'Gift box',
              description: null,
              unit: null,
              price: '4,50',
              min_qty: null,
              max_qty: null,
            },
            {
              name: 'Invented vase',
              description: null,
              unit: 'pcs',
              price: '39,00',
              min_qty: null,
              max_qty: null,
            },
          ],
        }),
    });
    const r = await quotesImportHandler({ sql: worker, llm })({
      id: randomUUID(),
      tenantId: T.tenantId,
      queue: QUEUES.quotesImport,
      payload: { importId: imp!.id },
      attempts: 1,
      maxAttempts: 5,
    });
    expect(r).toEqual({ status: 'ready', items: 2, dropped: 1 });
    const items = await owner<
      { name: string; unit_price_cents: number; status: string; source: string }[]
    >`
      select name, unit_price_cents, status, source from public.price_items
      where import_id = ${imp!.id} order by name`;
    expect(items).toEqual([
      { name: 'Gift box', unit_price_cents: 450, status: 'draft', source: 'file' },
      { name: 'Lavender candle', unit_price_cents: 2400, status: 'draft', source: 'file' },
    ]);
    const [after] = await owner<
      { status: string; item_count: number; extracted_text: string | null }[]
    >`
      select status, item_count, extracted_text from public.price_imports where id = ${imp!.id}`;
    expect(after).toEqual({ status: 'ready', item_count: 2, extracted_text: null });
  });
});

describe('expiry', () => {
  it('the hourly job expires sent quotes past their validity', async () => {
    const T = await tenant('quotes-expiry');
    const [q] = await owner<{ id: string }[]>`
      insert into public.quotes (tenant_id, number, thread_id, status, customer_email, currency, vat_mode, vat_rate,
                                 subtotal_cents, vat_cents, total_cents, valid_until)
      values (${T.tenantId}, 'Q-2026-0900', ${T.threadId}, 'sent', 'x@example.test', 'EUR', 'none', 0, 100, 0, 100,
              current_date - 2) returning id`;
    await worker`select app.expire_quotes()`;
    const [after] = await owner<
      { status: string }[]
    >`select status from public.quotes where id = ${q!.id}`;
    expect(after!.status).toBe('expired');
  });
});
