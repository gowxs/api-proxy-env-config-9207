import { randomUUID } from 'node:crypto';
import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let A: SeededTenant;
let B: SeededTenant;
const year = new Date().getUTCFullYear();

beforeAll(async () => {
  auth = await testAuth();
  app = buildApp({
    logger: createLogger({ service: 'api-test', level: 'silent' }),
    sql: apiSql,
    checkDatabase: async () => true,
    verifyToken: createTokenVerifier({ jwks: auth.jwks }),
    credentialsPublicKey: generateSealingKeyPair().publicKey,
    connectionTestWaitMs: 1_000,
    rateLimits: false,
  });
  A = await seedTenant(owner, 'docs-a', { embeddingAxis: 170 });
  B = await seedTenant(owner, 'docs-b', { embeddingAxis: 171 });
  await owner`delete from public.documents where tenant_id in (${A.tenantId}, ${B.tenantId})`;
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
  return {
    status: res.statusCode,
    json:
      res.headers['content-type']?.toString().includes('json') && res.body ? res.json() : undefined,
    raw: res.rawPayload,
    headers: res.headers,
  };
}

const readyInvoice = {
  buyer: { name: 'SIA Ozols', address: 'Krasta iela 12, Rīga', regNo: '', vatNo: '', email: '' },
  supplyDate: null,
  dueDate: null,
  paymentReference: '',
  reverseCharge: false,
  lines: [
    { name: 'Lavender candle', unit: 'pcs', qty: 20, unitPriceCents: 2400 },
    { name: 'Gift box', unit: 'box', qty: 2.5, unitPriceCents: 650 },
  ],
  notes: '',
};

describe('settings', () => {
  it('documents are off by default; creating one needs them on', async () => {
    expect((await call('GET', A, '')).json).toMatchObject({
      documents_enabled: false,
      invoice_due_days: 14,
    });
    const r = await call('POST', A, '/documents', { type: 'invoice' });
    expect(r.status).toBe(409);
  });

  it('saves seller details, checking the IBAN and VAT number', async () => {
    expect((await call('PATCH', A, '', { sellerIban: 'LV81BANK0000435195001' })).status).toBe(400);
    expect((await call('PATCH', A, '', { sellerVatNo: '40003123456' })).status).toBe(400);
    const r = await call('PATCH', A, '', {
      documentsEnabled: true,
      sellerLegalName: 'SIA Nordlicht',
      sellerLegalAddress: 'Brīvības iela 1, Rīga',
      sellerRegNo: '40003123456',
      sellerVatNo: 'lv 40003123456',
      sellerBankName: 'Swedbank',
      sellerIban: 'LV80 BANK 0000 4351 9500 1',
      sellerBic: 'habalv22',
      sellerCountry: 'Latvia',
    });
    expect(r.status).toBe(200);
    expect((await call('GET', A, '')).json).toMatchObject({
      documents_enabled: true,
      seller_iban: 'LV80BANK0000435195001',
      seller_vat_no: 'LV40003123456',
      seller_bic: 'HABALV22',
    });
  });
});

describe('invoices', () => {
  let invoiceId: string;

  it('a new invoice in a conversation starts with the customer and a due date', async () => {
    const r = await call('POST', A, '/documents', { type: 'invoice', threadId: A.threadId });
    expect(r.status).toBe(200);
    invoiceId = r.json.id;
    const d = (await call('GET', A, `/documents/${invoiceId}`)).json;
    expect(d).toMatchObject({
      type: 'invoice',
      status: 'draft',
      number: null,
      thread_id: A.threadId,
      lead_id: A.leadId,
      currency: 'EUR',
      vat_mode: 'exclusive',
      data: { buyer: { name: 'Customer docs-a' } },
      seller: { legalName: 'SIA Nordlicht' },
    });
    expect(d.data.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(d.problems).toContain('Buyer: address is missing');
  });

  it('saving computes the totals; issuing numbers it', async () => {
    const saved = await call('PATCH', A, `/documents/${invoiceId}`, {
      data: { ...readyInvoice, dueDate: `${year + 1}-01-15` },
      language: 'lv',
    });
    expect(saved.status).toBe(200);
    // 480 + 16.25 = 496.25; VAT 21 % = 104.21; total 600.46.
    expect(saved.json).toMatchObject({
      subtotal_cents: 49625,
      vat_cents: 10421,
      total_cents: 60046,
      counterparty_name: 'SIA Ozols',
      problems: [],
      language: 'lv',
    });
    const issued = await call('POST', A, `/documents/${invoiceId}/issue`, {});
    expect(issued.status).toBe(200);
    expect(issued.json).toMatchObject({ status: 'issued', number: `INV-${year}-0001` });
    expect(issued.json.issue_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('refuses to issue an incomplete document and lists what is missing', async () => {
    const r = await call('POST', A, '/documents', { type: 'invoice' });
    const bad = await call('POST', A, `/documents/${r.json.id}/issue`, {});
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('Buyer: name is missing');
    await call('DELETE', A, `/documents/${r.json.id}`, {});
  });

  it('numbers run per type and per year; a cancelled number stays used', async () => {
    const make = async (type: string, data: unknown) => {
      const c = await call('POST', A, '/documents', { type, threadId: A.threadId });
      await call('PATCH', A, `/documents/${c.json.id}`, { data });
      return (await call('POST', A, `/documents/${c.json.id}/issue`, {})).json;
    };
    const second = await make('invoice', readyInvoice);
    expect(second.number).toBe(`INV-${year}-0002`);
    expect((await call('POST', A, `/documents/${second.id}/cancel`, {})).json.status).toBe(
      'cancelled',
    );
    expect((await make('invoice', readyInvoice)).number).toBe(`INV-${year}-0003`);
    const dn = await make('delivery_note', {
      receiver: { name: 'SIA Ozols', address: 'Rīga', regNo: '', vatNo: '' },
      deliveryAddress: 'Rīga',
      lines: [{ name: 'Candle', unit: 'pcs', qty: 3 }],
    });
    expect(dn.number).toBe(`DN-${year}-0001`);
  });

  it('a delivery note from an invoice copies the buyer and lines, without prices', async () => {
    const r = await call('POST', A, '/documents', {
      type: 'delivery_note',
      fromDocumentId: invoiceId,
    });
    const d = (await call('GET', A, `/documents/${r.json.id}`)).json;
    expect(d).toMatchObject({
      source_document_id: invoiceId,
      language: 'lv',
      data: {
        receiver: { name: 'SIA Ozols', address: 'Krasta iela 12, Rīga' },
        deliveryAddress: 'Krasta iela 12, Rīga',
        loadingAddress: 'Brīvības iela 1, Rīga',
        lines: [
          { name: 'Lavender candle', unit: 'pcs', qty: 20, unitPriceCents: 2400 },
          { name: 'Gift box', unit: 'box', qty: 2.5, unitPriceCents: 650 },
        ],
      },
    });
    // Prices come along but are shown only when the owner turns on the pavadzīme-rēķins.
    expect(d.data.withPrices).toBe(false);
    expect(d.total_cents).toBe(0);
    const priced = await call('PATCH', A, `/documents/${r.json.id}`, {
      data: { ...d.data, withPrices: true },
    });
    expect(priced.json).toMatchObject({
      subtotal_cents: 49625,
      vat_cents: 10421,
      total_cents: 60046,
    });
    const issued = await call('POST', A, `/documents/${r.json.id}/issue`, {});
    expect(issued.status).toBe(200);
    const pdf = await call('GET', A, `/documents/${r.json.id}/pdf`);
    expect(pdf.headers['content-disposition']).toContain('Precu-pavadzime-rekins-DN-');
    // With prices it asks for payment: paid, not delivered.
    expect(issued.json).toMatchObject({ payable: true });
    expect(issued.json.due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      (await call('POST', A, `/documents/${r.json.id}/mark`, { status: 'delivered' })).status,
    ).toBe(400);
    expect(
      (await call('POST', A, `/documents/${r.json.id}/mark`, { status: 'paid' })).json.status,
    ).toBe('paid');
  });

  it('an invoice from an accepted quote copies its lines, VAT and customer', async () => {
    const qid = randomUUID();
    await owner`insert into public.quotes (id, tenant_id, number, thread_id, lead_id, status, language, customer_name,
                  customer_email, currency, vat_mode, vat_rate, subtotal_cents, vat_cents, total_cents, valid_until)
                values (${qid}, ${A.tenantId}, 'Q-2026-0100', ${A.threadId}, ${A.leadId}, 'accepted', 'de', 'Jonas Keller',
                  'jonas@keller.test', 'EUR', 'inclusive', 19, 4800, 766, 4800, current_date + 10)`;
    await owner`insert into public.quote_lines (tenant_id, quote_id, position, name, unit, qty, unit_price_cents, line_total_cents)
                values (${A.tenantId}, ${qid}, 0, 'Lavender candle', 'pcs', 2, 2400, 4800)`;
    const r = await call('POST', A, '/documents', { type: 'invoice', fromQuoteId: qid });
    const d = (await call('GET', A, `/documents/${r.json.id}`)).json;
    expect(d).toMatchObject({
      quote_id: qid,
      language: 'de',
      vat_mode: 'inclusive',
      vat_rate: 19,
      total_cents: 4800,
      data: {
        buyer: { name: 'Jonas Keller', email: 'jonas@keller.test' },
        lines: [{ name: 'Lavender candle', unit: 'pcs', qty: 2, unitPriceCents: 2400 }],
      },
    });
    await owner`update public.quotes set status = 'sent' where id = ${qid}`;
    expect(
      (await call('POST', A, '/documents', { type: 'invoice', fromQuoteId: qid })).status,
    ).toBe(400);
  });

  it('mode 1: sending prepares a reply that waits for approval, and edits follow into it', async () => {
    const r = await call('POST', A, `/documents/${invoiceId}/send`, {});
    expect(r.json.status).toBe('pending_approval');
    const [dr] = await owner<{ kind: string; status: string; body: string; to_address: string }[]>`
      select kind, status, body, to_address from public.drafts where id = ${r.json.draftId}`;
    expect(dr).toMatchObject({ kind: 'document', status: 'pending_approval' });
    expect(dr!.body).toContain(`INV-${year}-0001`);
    expect(dr!.body).toContain('600,46');
    // Change a line before approval: the reply's total follows.
    const lines = [{ name: 'Lavender candle', unit: 'pcs', qty: 10, unitPriceCents: 2400 }];
    await call('PATCH', A, `/documents/${invoiceId}`, {
      data: { ...readyInvoice, dueDate: `${year + 1}-01-15`, lines },
    });
    const [after] = await owner<
      { body: string }[]
    >`select body from public.drafts where id = ${r.json.draftId}`;
    expect(after!.body).toContain('290,40');
    // Asking again returns the same reply.
    expect((await call('POST', A, `/documents/${invoiceId}/send`, {})).json.draftId).toBe(
      r.json.draftId,
    );
    // Once approved it is locked.
    await owner`update public.drafts set status = 'approved' where id = ${r.json.draftId}`;
    expect((await call('PATCH', A, `/documents/${invoiceId}`, { data: readyInvoice })).status).toBe(
      409,
    );
  });

  it('modes 2 and 3: the owner’s click sends it', async () => {
    await owner`update public.tenants set mode = 'auto_send' where id = ${A.tenantId}`;
    const c = await call('POST', A, '/documents', { type: 'invoice', threadId: A.threadId });
    await call('PATCH', A, `/documents/${c.json.id}`, { data: readyInvoice });
    await call('POST', A, `/documents/${c.json.id}/issue`, {});
    const r = await call('POST', A, `/documents/${c.json.id}/send`, {});
    expect(r.json.status).toBe('approved');
    const [job] = await owner<{ queue: string }[]>`
      select queue from public.jobs where tenant_id = ${A.tenantId} and payload->>'draftId' = ${r.json.draftId}`;
    expect(job?.queue).toBe('mail.send');
    await owner`update public.tenants set mode = 'draft_only' where id = ${A.tenantId}`;
  });

  it('paid, delivered, delete and the PDF', async () => {
    expect(
      (await call('POST', A, `/documents/${invoiceId}/mark`, { status: 'delivered' })).status,
    ).toBe(400);
    const paid = await call('POST', A, `/documents/${invoiceId}/mark`, { status: 'paid' });
    expect(paid.json.status).toBe('paid');
    expect((await call('DELETE', A, `/documents/${invoiceId}`, {})).status).toBe(409);
    const pdf = await call('GET', A, `/documents/${invoiceId}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toContain(`Rekins-INV-${year}-0001.pdf`);
    expect(pdf.raw.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('another tenant sees nothing', async () => {
    await owner`update public.tenants set documents_enabled = true where id = ${B.tenantId}`;
    expect((await call('GET', B, `/documents/${invoiceId}`)).status).toBe(404);
    expect((await call('GET', B, '/documents')).json).toEqual([]);
    expect(
      (await call('POST', B, '/documents', { type: 'delivery_note', fromDocumentId: invoiceId }))
        .status,
    ).toBe(400);
  });
});

describe('CMR from an e-mail', () => {
  it('queues the reading, and the PDF needs the owner to confirm the filled fields', async () => {
    const r = await call('POST', A, '/documents', { type: 'cmr', fromMessageId: A.messageId });
    expect(r.status).toBe(200);
    const id = r.json.id;
    const d = (await call('GET', A, `/documents/${id}`)).json;
    expect(d).toMatchObject({
      prefill_status: 'pending',
      thread_id: A.threadId,
      data: {
        sender: { name: 'SIA Nordlicht', country: 'Latvia' },
        takingOver: { country: 'Latvia' },
      },
    });
    const [job] = await owner<{ queue: string }[]>`
      select queue from public.jobs where tenant_id = ${A.tenantId} and payload->>'documentId' = ${id}`;
    expect(job?.queue).toBe('documents.prefill');
    expect((await call('PATCH', A, `/documents/${id}`, { data: d.data })).status).toBe(409);

    // As the worker leaves it: fields filled with their e-mail sources.
    const data = {
      ...d.data,
      consignee: {
        name: 'Keller Wohnen GmbH',
        address: 'Torstraße 140, Berlin',
        country: 'Germany',
      },
      deliveryPlace: { place: 'Berlin', country: 'Germany' },
      takingOver: { place: 'Rīga', country: 'Latvia', date: `${year + 1}-01-14` },
      goods: [
        {
          marks: '',
          packages: 4,
          packing: 'pallets',
          nature: 'candles',
          statNo: '',
          grossKg: 620,
          volumeM3: null,
        },
      ],
      carrier: { name: 'Baltic Road Cargo', address: 'Ganību dambis 1, Rīga', country: 'Latvia' },
      establishedIn: 'Rīga',
    };
    await owner`update public.documents
                set data = ${owner.json(data)}, prefill_status = 'done',
                    prefill = ${owner.json({ 'consignee.name': { source: 'Keller Wohnen GmbH' }, 'goods.0.grossKg': { source: '620 kg' } })}
                where id = ${id}`;
    // Changing a filled field removes its highlight; the other stays.
    const edited = await call('PATCH', A, `/documents/${id}`, {
      data: { ...data, consignee: { ...data.consignee, name: 'Keller Wohnen GmbH & Co. KG' } },
    });
    expect(Object.keys(edited.json.prefill)).toEqual(['goods.0.grossKg']);
    const refused = await call('POST', A, `/documents/${id}/issue`, {});
    expect(refused.status).toBe(400);
    expect(refused.json.error).toContain('Confirm that you checked every field');
    const ok = await call('POST', A, `/documents/${id}/issue`, { confirmPrefill: true });
    expect(ok.json).toMatchObject({ status: 'issued', number: `CMR-${year}-0001`, prefill: null });
    const pdf = await call('GET', A, `/documents/${id}/pdf`);
    const pages = (pdf.raw.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;
    expect(pages).toBe(4);
    expect(pdf.headers['content-disposition']).toContain(`CMR-${year}-0001.pdf`);
  });

  it('the conversation page and dashboard show documents', async () => {
    const conv = (await call('GET', A, `/conversations/${A.threadId}`)).json;
    expect(conv.documentsEnabled).toBe(true);
    expect(conv.documents.length).toBeGreaterThan(2);
    const dash = (await call('GET', A, '/dashboard')).json;
    expect(dash.documents).toMatchObject({ enabled: true, currency: 'EUR' });
  });
});

describe('number prefixes', () => {
  beforeAll(async () => {
    await owner`update public.tenants
                set documents_enabled = true, seller_legal_name = 'SIA Other', seller_legal_address = 'Rīga',
                    seller_vat_no = 'LV40003999999', seller_iban = 'LV80BANK0000435195001'
                where id = ${B.tenantId}`;
  });

  it('are validated and distinct', async () => {
    expect((await call('GET', B, '')).json).toMatchObject({
      doc_prefix_invoice: 'INV',
      doc_prefix_delivery_note: 'DN',
      doc_prefix_cmr: 'CMR',
      doc_prefix_locks: { invoice: false, delivery_note: false, cmr: false },
    });
    expect((await call('PATCH', B, '', { docPrefixInvoice: 'RĒĶ' })).status).toBe(400);
    expect((await call('PATCH', B, '', { docPrefixInvoice: 'R-1' })).status).toBe(400);
    expect((await call('PATCH', B, '', { docPrefixInvoice: 'TOOLONGPREFIX' })).status).toBe(400);
    const dup = await call('PATCH', B, '', { docPrefixInvoice: 'DN' });
    expect(dup.status).toBe(400);
    expect(dup.json.error).toBe('Each document type needs its own prefix.');
    expect((await call('PATCH', B, '', { docPrefixInvoice: 'rek' })).status).toBe(200);
  });

  it('numbers use the prefix, which is then fixed for the year', async () => {
    const c = await call('POST', B, '/documents', { type: 'invoice', threadId: B.threadId });
    await call('PATCH', B, `/documents/${c.json.id}`, { data: readyInvoice });
    const issued = await call('POST', B, `/documents/${c.json.id}/issue`, {});
    expect(issued.json.number).toBe(`REK-${year}-0001`);
    expect((await call('GET', B, '')).json.doc_prefix_locks).toEqual({
      invoice: true,
      delivery_note: false,
      cmr: false,
    });
    const locked = await call('PATCH', B, '', { docPrefixInvoice: 'FAKT' });
    expect(locked.status).toBe(409);
    expect(locked.json.error).toContain('fixed for this year');
    // Saving the same prefix again is fine; other types can still change.
    expect(
      (await call('PATCH', B, '', { docPrefixInvoice: 'REK', docPrefixDeliveryNote: 'PAV' }))
        .status,
    ).toBe(200);
    const dn = await call('POST', B, '/documents', { type: 'delivery_note', threadId: B.threadId });
    await call('PATCH', B, `/documents/${dn.json.id}`, {
      data: {
        receiver: { name: 'R', address: 'A', regNo: '', vatNo: '' },
        deliveryAddress: 'A',
        lines: [{ name: 'Candle', unit: 'pcs', qty: 1, unitPriceCents: null }],
      },
    });
    expect((await call('POST', B, `/documents/${dn.json.id}/issue`, {})).json.number).toBe(
      `PAV-${year}-0001`,
    );
  });

  it('reverse charge with VAT-inclusive prices invoices net prices without VAT', async () => {
    await owner`update public.tenants set quotes_vat_mode = 'inclusive' where id = ${B.tenantId}`;
    const c = await call('POST', B, '/documents', { type: 'invoice', threadId: B.threadId });
    const r = await call('PATCH', B, `/documents/${c.json.id}`, {
      data: {
        ...readyInvoice,
        reverseCharge: true,
        buyer: { ...readyInvoice.buyer, vatNo: 'DE123456789' },
      },
    });
    // 24.00 → 19.83 net, 6.50 → 5.37: 396.60 + 13.43 = 410.03, no VAT.
    expect(r.json).toMatchObject({
      vat_mode: 'inclusive',
      subtotal_cents: 41003,
      vat_cents: 0,
      total_cents: 41003,
      problems: [],
    });
    expect((await call('POST', B, `/documents/${c.json.id}/issue`, {})).status).toBe(200);
  });
});

describe('incoming payments (owner side)', () => {
  it('bank senders are normalised and checked', async () => {
    expect((await call('POST', A, '/bank-senders', { domain: 'not a domain' })).status).toBe(400);
    const r = await call('POST', A, '/bank-senders', { domain: 'https://www.Swedbank.lv/biz' });
    expect(r.json).toMatchObject({ domain: 'swedbank.lv' });
    expect(
      (await call('GET', A, '/bank-senders')).json.map((b: { domain: string }) => b.domain),
    ).toContain('swedbank.lv');
    expect((await call('DELETE', A, `/bank-senders/${r.json.id}`, {})).status).toBe(200);
  });

  it('confirm a proposal, link manually, dismiss; the invoice shows the payment', async () => {
    const make = async () => {
      const c = await call('POST', A, '/documents', { type: 'invoice', threadId: A.threadId });
      await call('PATCH', A, `/documents/${c.json.id}`, { data: readyInvoice });
      await call('POST', A, `/documents/${c.json.id}/issue`, {});
      return c.json.id as string;
    };
    const first = await make();
    const second = await make();
    const pay = async (status: string, documentId: string | null) =>
      (
        await owner<{ id: string }[]>`
          insert into public.payments (tenant_id, amount_cents, currency, payer_name, reference, status, match_kind, document_id)
          values (${A.tenantId}, 60046, 'EUR', 'SIA Ozols', 'order 12', ${status}, ${documentId ? 'amount' : null}, ${documentId})
          returning id`
      )[0]!.id;
    const proposed = await pay('proposed', first);
    const c = await call('POST', A, `/payments/${proposed}/confirm`, {});
    expect(c.json).toMatchObject({ status: 'matched', matched_by: 'owner', match_kind: 'amount' });
    const doc = (await call('GET', A, `/documents/${first}`)).json;
    expect(doc.status).toBe('paid');
    expect(doc.payments[0]).toMatchObject({
      amount_cents: 60046,
      payer_name: 'SIA Ozols',
      status: 'matched',
    });

    const loose = await pay('unmatched', null);
    const l = await call('POST', A, `/payments/${loose}/link`, { documentId: second });
    expect(l.json).toMatchObject({ status: 'matched', match_kind: 'manual', document_id: second });
    expect((await call('GET', A, `/documents/${second}`)).json.status).toBe('paid');
    // A paid invoice cannot take another payment.
    const again = await pay('unmatched', null);
    expect((await call('POST', A, `/payments/${again}/link`, { documentId: second })).status).toBe(
      409,
    );
    expect((await call('POST', A, `/payments/${again}/dismiss`, {})).json.status).toBe('dismissed');
    // Another tenant sees none of it.
    expect(
      (await call('GET', B, '/payments')).json.some((p: { id: string }) => p.id === proposed),
    ).toBe(false);
    expect((await call('POST', B, `/payments/${loose}/dismiss`, {})).status).toBe(404);
  });
});
