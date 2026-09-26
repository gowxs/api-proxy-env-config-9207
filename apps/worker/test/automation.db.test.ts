import { randomUUID } from 'node:crypto';
import { withTenant } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import {
  createDocument,
  issueDocument,
  loadDocument,
  markDocumentPaid,
  writeDocumentData,
} from '@noctiv/documents';
import { simpleParser } from 'mailparser';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { runAutomation } from '../src/jobs/documents-automation.ts';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, keys, readFolder } from './helpers.ts';

const gm = inject('greenmail');

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

type Mode = 'draft_only' | 'auto_send';
let n = 0;

async function tenant(mode: Mode, o: { limitCents?: number } = {}) {
  const t = await seedTenant(owner, `auto-${++n}-${randomUUID().slice(0, 6)}`, {
    embeddingAxis: 200,
  });
  await owner`update public.tenants
              set mode = ${mode}, documents_enabled = true, seller_legal_name = 'SIA Nordlicht',
                  seller_legal_address = 'Rīga', seller_vat_no = 'LV40003123456',
                  seller_iban = 'LV80BANK0000435195001', quotes_vat_mode = 'exclusive',
                  quotes_vat_rate = 21, quotes_auto_send_limit_cents = ${o.limitCents ?? 100000}
              where id = ${t.tenantId}`;
  return t;
}

/** An accepted quote on the seeded conversation: 20 × 24.00 + 21 % VAT = 580.80. */
async function acceptedQuote(t: SeededTenant, email: string) {
  const id = randomUUID();
  await owner`
    insert into public.quotes (id, tenant_id, number, thread_id, lead_id, status, language, customer_name,
                               customer_email, currency, vat_mode, vat_rate, subtotal_cents, vat_cents,
                               total_cents, valid_until, accepted_at)
    values (${id}, ${t.tenantId}, ${`Q-2000-${String(++n).padStart(4, '0')}`}, ${t.threadId}, ${t.leadId},
            'accepted', 'en', 'Māris', ${email}, 'EUR', 'exclusive', 21, 48000, 10080, 58080,
            current_date + 14, now())`;
  await owner`
    insert into public.quote_lines (tenant_id, quote_id, position, name, unit, qty, unit_price_cents, line_total_cents)
    values (${t.tenantId}, ${id}, 0, 'Lavender candle', 'pcs', 20, 2400, 48000)`;
  return id;
}

/** An earlier invoice to the same e-mail address, with the buyer details the owner confirmed. */
async function earlierInvoice(t: SeededTenant, email: string) {
  await withTenant(worker, t.tenantId, async (tx) => {
    const id = await createDocument(tx, { tenantId: t.tenantId, type: 'invoice' });
    const d = (await loadDocument(tx, { id }))!;
    await writeDocumentData(tx, d, {
      ...d.data,
      buyer: {
        name: 'SIA Ozols Būve',
        address: 'Krasta iela 12, Rīga',
        regNo: '40103987654',
        vatNo: '',
        email: email.toUpperCase(),
      },
      lines: [{ name: 'Gift box', unit: 'box', qty: 1, unitPriceCents: 650 }],
    } as never);
    const r = await issueDocument(tx, (await loadDocument(tx, { id }))!, {});
    if (!r.ok) throw new Error(r.problems.join('; '));
  });
}

const run = (t: SeededTenant, p: Parameters<typeof runAutomation>[2]) =>
  withTenant(worker, t.tenantId, (tx) => runAutomation(tx, t.tenantId, p));
const draftOf = async (id: string) =>
  (
    await owner<{ status: string; kind: string; body: string; decided_by: string | null }[]>`
      select status, kind, body, decided_by from public.drafts where id = ${id}`
  )[0]!;
const sendJobs = (t: SeededTenant) =>
  owner<{ payload: { draftId: string; sentVia: string } }[]>`
    select payload from public.jobs where tenant_id = ${t.tenantId} and queue = 'mail.send'`;
const notes = (t: SeededTenant, kind: string) =>
  owner<{ payload: Record<string, unknown> }[]>`
    select payload from public.notifications where tenant_id = ${t.tenantId} and kind = ${kind}`;

describe('invoice when a quote is accepted', () => {
  it('modes 2/3: made from the quote, numbered, and sent (total within the limit)', async () => {
    const t = await tenant('auto_send');
    const email = `buyer-${randomUUID()}@example.test`;
    await earlierInvoice(t, email);
    const quoteId = await acceptedQuote(t, email);
    const r = await run(t, { event: 'quote_accepted', quoteId });
    expect(r).toMatchObject({ autoSend: true, reasons: [] });
    if (!('draftId' in r)) throw new Error('no draft');
    const d = await withTenant(worker, t.tenantId, (tx) => loadDocument(tx, { id: r.documentId }));
    expect(d).toMatchObject({
      type: 'invoice',
      status: 'issued',
      quoteId,
      autoSource: 'quote_accepted',
      totalCents: 58080,
      draftId: r.draftId,
    });
    expect(d!.number).toMatch(/^INV-\d{4}-\d{4}$/);
    // Buyer details come from the earlier invoice to the same address; nothing is invented.
    expect(d!.data).toMatchObject({
      buyer: { name: 'SIA Ozols Būve', address: 'Krasta iela 12, Rīga', regNo: '40103987654' },
    });
    const draft = await draftOf(r.draftId);
    expect(draft).toMatchObject({ kind: 'document', status: 'approved', decided_by: 'auto' });
    expect(draft.body).toContain(`Thank you for accepting quote Q-2000-`);
    expect(draft.body).toContain(`Invoice ${d!.number} for €580.80 is attached, due `);
    expect(await sendJobs(t)).toEqual([{ payload: { draftId: r.draftId, sentVia: 'auto' } }]);

    // Once per quote.
    expect(await run(t, { event: 'quote_accepted', quoteId })).toEqual({
      skipped: 'invoice_exists',
    });
  });

  it('mode 1 waits for approval; above the limit it waits too', async () => {
    const t1 = await tenant('draft_only');
    const e1 = `buyer-${randomUUID()}@example.test`;
    await earlierInvoice(t1, e1);
    const r1 = await run(t1, { event: 'quote_accepted', quoteId: await acceptedQuote(t1, e1) });
    expect(r1).toMatchObject({ autoSend: false, reasons: ['tenant_draft_only'] });
    if (!('draftId' in r1)) throw new Error('no draft');
    expect((await draftOf(r1.draftId)).status).toBe('pending_approval');
    expect(await sendJobs(t1)).toEqual([]);
    expect((await notes(t1, 'draft_ready')).map((x) => x.payload.draftId)).toContain(r1.draftId);

    const t2 = await tenant('auto_send', { limitCents: 50000 });
    const e2 = `buyer-${randomUUID()}@example.test`;
    await earlierInvoice(t2, e2);
    const r2 = await run(t2, { event: 'quote_accepted', quoteId: await acceptedQuote(t2, e2) });
    expect(r2).toMatchObject({ autoSend: false, reasons: ['invoice_over_limit'] });
    expect(await sendJobs(t2)).toEqual([]);
  });

  it('a new customer (no billing address known): the invoice waits for the owner, nothing is sent', async () => {
    const t = await tenant('auto_send');
    const r = await run(t, {
      event: 'quote_accepted',
      quoteId: await acceptedQuote(t, `new-${randomUUID()}@example.test`),
    });
    expect(r).toMatchObject({ held: 'needs_owner', problems: ['Buyer: address is missing'] });
    if (!('held' in r)) throw new Error('not held');
    const d = await withTenant(worker, t.tenantId, (tx) => loadDocument(tx, { id: r.documentId }));
    expect(d).toMatchObject({ status: 'draft', number: null, draftId: null });
    expect((await notes(t, 'document_needs_you'))[0]!.payload).toMatchObject({
      documentId: r.documentId,
      type: 'invoice',
      event: 'quote_accepted',
    });
    expect(await sendJobs(t)).toEqual([]);
  });

  it('a new customer who gave billing details on the Accept page: issued and sent', async () => {
    const t = await tenant('auto_send');
    await owner`update public.leads
                set billing_name = 'Rūta Kalniņa', billing_address = 'Lāčplēša iela 5, Rīga',
                    billing_vat_no = 'LV12345678901'
                where id = ${t.leadId}`;
    const r = await run(t, {
      event: 'quote_accepted',
      quoteId: await acceptedQuote(t, `new-${randomUUID()}@example.test`),
    });
    expect(r).toMatchObject({ autoSend: true });
    if (!('documentId' in r)) throw new Error('no invoice');
    const d = await withTenant(worker, t.tenantId, (tx) => loadDocument(tx, { id: r.documentId }));
    expect(d!.status).toBe('issued');
    expect(d!.data).toMatchObject({
      buyer: {
        name: 'Rūta Kalniņa',
        address: 'Lāčplēša iela 5, Rīga',
        regNo: '',
        vatNo: 'LV12345678901',
      },
    });
  });

  it('switched off, or Documents off: nothing happens', async () => {
    const t = await tenant('auto_send');
    const email = `buyer-${randomUUID()}@example.test`;
    const quoteId = await acceptedQuote(t, email);
    await owner`update public.tenants set auto_invoice_on_accept = false where id = ${t.tenantId}`;
    expect(await run(t, { event: 'quote_accepted', quoteId })).toEqual({
      skipped: 'automation_off',
    });
    await owner`update public.tenants set auto_invoice_on_accept = true, documents_enabled = false
                where id = ${t.tenantId}`;
    expect(await run(t, { event: 'quote_accepted', quoteId })).toEqual({
      skipped: 'documents_off',
    });
    expect(
      await owner`select 1 from public.documents where tenant_id = ${t.tenantId} and quote_id = ${quoteId}`,
    ).toHaveLength(0);
  });
});

describe('delivery note after payment', () => {
  async function paidInvoice(t: SeededTenant) {
    const email = `buyer-${randomUUID()}@example.test`;
    await earlierInvoice(t, email);
    const r = await run(t, { event: 'quote_accepted', quoteId: await acceptedQuote(t, email) });
    if (!('documentId' in r)) throw new Error('no invoice');
    await owner`update public.documents set status = 'sent', sent_at = now() where id = ${r.documentId}`;
    await withTenant(worker, t.tenantId, (tx) => markDocumentPaid(tx, r.documentId));
    return r.documentId;
  }
  const automationJobs = (t: SeededTenant) =>
    owner<{ payload: Record<string, unknown> }[]>`
      select payload from public.jobs where tenant_id = ${t.tenantId} and queue = 'documents.automation'`;

  it('off by default: a paid invoice starts nothing', async () => {
    const t = await tenant('auto_send');
    await paidInvoice(t);
    expect(await automationJobs(t)).toEqual([]);
  });

  it('switched on: marking paid queues it; the delivery note is made from the invoice and sent', async () => {
    const t = await tenant('auto_send');
    await owner`update public.tenants set auto_delivery_note_after_payment = true where id = ${t.tenantId}`;
    const invoiceId = await paidInvoice(t);
    expect(await automationJobs(t)).toEqual([
      { payload: { event: 'invoice_paid', documentId: invoiceId } },
    ]);
    const r = await run(t, { event: 'invoice_paid', documentId: invoiceId });
    expect(r).toMatchObject({ autoSend: true });
    if (!('draftId' in r)) throw new Error('no draft');
    const [inv, dn] = await withTenant(worker, t.tenantId, async (tx) => [
      (await loadDocument(tx, { id: invoiceId }))!,
      (await loadDocument(tx, { id: r.documentId }))!,
    ]);
    expect(dn).toMatchObject({
      type: 'delivery_note',
      status: 'issued',
      sourceDocumentId: invoiceId,
      autoSource: 'invoice_paid',
      payable: false,
    });
    expect(dn.data).toMatchObject({
      receiver: { name: 'SIA Ozols Būve', address: 'Krasta iela 12, Rīga' },
      deliveryAddress: 'Krasta iela 12, Rīga',
      lines: [{ name: 'Lavender candle', qty: 20 }],
    });
    expect((await draftOf(r.draftId)).body).toContain(
      `Thank you for your payment of invoice ${inv.number}. Delivery note ${dn.number} is attached.`,
    );
    expect(await run(t, { event: 'invoice_paid', documentId: invoiceId })).toEqual({
      skipped: 'delivery_note_exists',
    });
  });

  it('mode 1: the delivery note waits for approval', async () => {
    const t = await tenant('draft_only');
    await owner`update public.tenants set auto_delivery_note_after_payment = true where id = ${t.tenantId}`;
    const invoiceId = await paidInvoice(t);
    const r = await run(t, { event: 'invoice_paid', documentId: invoiceId });
    expect(r).toMatchObject({ autoSend: false, reasons: ['tenant_draft_only'] });
    if (!('draftId' in r)) throw new Error('no draft');
    expect((await draftOf(r.draftId)).status).toBe('pending_approval');
  });
});

describe('sending the automatic invoice', () => {
  const shop = GREENMAIL_USERS.autoShop;
  const customer = GREENMAIL_USERS.autoCustomer;
  async function ready(limitCents?: number) {
    const t = await tenant('auto_send', { limitCents });
    const connectionId = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    await owner`update public.threads set connection_id = ${connectionId} where id = ${t.threadId}`;
    await owner`update public.messages set from_address = ${customer.address} where id = ${t.messageId}`;
    const email = `buyer-${randomUUID()}@example.test`;
    await earlierInvoice(t, email);
    const r = await run(t, { event: 'quote_accepted', quoteId: await acceptedQuote(t, email) });
    if (!('draftId' in r)) throw new Error('no draft');
    return { t, r };
  }
  const send = (t: SeededTenant, draftId: string) =>
    mailSendHandler({ sql: worker, keys, allowInsecure: true })({
      id: randomUUID(),
      tenantId: t.tenantId,
      queue: QUEUES.mailSend,
      payload: { draftId, sentVia: 'auto' },
      attempts: 1,
      maxAttempts: 5,
    });

  it('goes out with the invoice PDF and the invoice becomes sent', async () => {
    const { t, r } = await ready();
    expect(await send(t, r.draftId)).toEqual({ status: 'sent' });
    const d = await withTenant(worker, t.tenantId, (tx) => loadDocument(tx, { id: r.documentId }));
    expect(d!.status).toBe('sent');
    const mail = (await readFolder(gm, customer)).find((m) => m.raw.includes(d!.number!));
    const parsed = await simpleParser(mail!.raw);
    expect(parsed.text).toContain('Thank you for accepting quote');
    expect(parsed.attachments.map((a) => a.filename)).toEqual([`Invoice-${d!.number}.pdf`]);
  });

  it('the limit is checked again at send time: lowered since, the invoice waits for approval', async () => {
    const { t, r } = await ready();
    await owner`update public.tenants set quotes_auto_send_limit_cents = 10000 where id = ${t.tenantId}`;
    expect(await send(t, r.draftId)).toMatchObject({
      status: 'downgraded',
      reasons: ['invoice_over_limit'],
    });
    expect((await draftOf(r.draftId)).status).toBe('pending_approval');
  });
});
