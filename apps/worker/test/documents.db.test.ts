import { randomUUID } from 'node:crypto';
import { withTenant, type Job } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { createDocument, issueDocument, loadDocument, writeDocumentData } from '@noctiv/documents';
import { FakeProvider } from '@noctiv/llm';
import { simpleParser } from 'mailparser';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { documentsPrefillHandler } from '../src/jobs/documents-prefill.ts';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, keys, readFolder } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
const shop = GREENMAIL_USERS.docShop;
const customer = GREENMAIL_USERS.docCustomer;
const year = new Date().getUTCFullYear();
const pages = (pdf: Buffer) => (pdf.toString('latin1').match(/\/Type \/Page\b(?!s)/g) ?? []).length;

let T: SeededTenant;
let connectionId: string;

const job = (queue: string, payload: Record<string, unknown>, attempts = 1): Job => ({
  id: randomUUID(),
  tenantId: T.tenantId,
  queue,
  payload,
  attempts,
  maxAttempts: 5,
});

beforeAll(async () => {
  T = await seedTenant(owner, 'docs-worker', { embeddingAxis: 180 });
  await owner`update public.tenants
              set documents_enabled = true, seller_legal_name = 'SIA Nordlicht',
                  seller_legal_address = 'Brīvības iela 1, Rīga', seller_vat_no = 'LV40003123456',
                  seller_iban = 'LV80BANK0000435195001', seller_country = 'Latvia'
              where id = ${T.tenantId}`;
  connectionId = await addGreenmailConnection(owner, gm, {
    tenantId: T.tenantId,
    address: shop.address,
    password: shop.password,
    displayName: 'Nordlicht Candles',
  });
  await owner`update public.threads set connection_id = ${connectionId} where id = ${T.threadId}`;
});
afterAll(() => Promise.all([owner.end(), worker.end()]));

/** An issued document with a reply draft approved by the owner. */
async function approvedDocument(type: 'invoice' | 'cmr', data: Record<string, unknown>) {
  return withTenant(worker, T.tenantId, async (tx) => {
    const id = await createDocument(tx, { tenantId: T.tenantId, type, threadId: T.threadId });
    const d0 = (await loadDocument(tx, { id }))!;
    await writeDocumentData(tx, d0, { ...d0.data, ...data } as never, 'lv');
    const r = await issueDocument(tx, (await loadDocument(tx, { id }))!, {});
    if (!r.ok) throw new Error(r.problems.join('; '));
    const [dr] = await tx<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                                 status, decided_by, decided_at)
      values (${T.tenantId}, ${T.threadId}, ${T.messageId}, 'document', ${customer.address},
              ${`Re: Order ${r.number}`}, ${`Please find attached ${r.number}.`}, 'approved', 'owner', now())
      returning id`;
    await tx`update public.documents set draft_id = ${dr!.id} where id = ${id}`;
    return { id, draftId: dr!.id, number: r.number };
  });
}

describe('sending a document', () => {
  const send = mailSendHandler({ sql: worker, keys, allowInsecure: true });

  it('an invoice goes out as a PDF in the customer’s language and becomes sent', async () => {
    const { id, draftId, number } = await approvedDocument('invoice', {
      buyer: { name: 'SIA Ozols', address: 'Rīga', regNo: '', vatNo: '', email: '' },
      lines: [{ name: 'Lavender candle', unit: 'pcs', qty: 20, unitPriceCents: 2400 }],
    });
    expect(number).toBe(`INV-${year}-0001`);
    expect(await send(job(QUEUES.mailSend, { draftId }))).toEqual({ status: 'sent' });
    const mail = (await readFolder(gm, customer)).find((m) => m.raw.includes(number));
    const parsed = await simpleParser(mail!.raw);
    expect(parsed.attachments.map((a) => [a.filename, a.contentType])).toEqual([
      [`Rekins-${number}.pdf`, 'application/pdf'],
    ]);
    const [doc] = await owner<{ status: string; sent_at: Date | null }[]>`
      select status, sent_at from public.documents where id = ${id}`;
    expect(doc!.status).toBe('sent');
    // No follow-up is scheduled after an invoice.
    const [th] = await owner<{ next_followup_at: Date | null }[]>`
      select next_followup_at from public.threads where id = ${T.threadId}`;
    expect(th!.next_followup_at).toBeNull();
  });

  it('a CMR goes out with four copies; a cancelled one is not sent', async () => {
    const cmr = {
      consignee: {
        name: 'Keller Wohnen GmbH',
        address: 'Torstraße 140, Berlin',
        country: 'Germany',
      },
      deliveryPlace: { place: 'Berlin', country: 'Germany' },
      takingOver: { place: 'Rīga', country: 'Latvia', date: `${year}-10-14` },
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
    const { draftId, number } = await approvedDocument('cmr', cmr);
    await send(job(QUEUES.mailSend, { draftId }));
    const mail = (await readFolder(gm, customer)).find((m) => m.raw.includes(number));
    const parsed = await simpleParser(mail!.raw);
    expect(parsed.attachments[0]!.filename).toBe(`${number}.pdf`);
    expect(pages(parsed.attachments[0]!.content)).toBe(4);

    const second = await approvedDocument('cmr', cmr);
    await owner`update public.documents set status = 'cancelled' where id = ${second.id}`;
    expect(await send(job(QUEUES.mailSend, { draftId: second.draftId }))).toEqual({
      skipped: 'document_cancelled',
    });
  });
});

describe('CMR pre-fill job', () => {
  const email = `Hello, please pick up 4 pallets of scented candles (620 kg) on 14.10.${year} and deliver them to
Keller Wohnen GmbH, Torstraße 140, 10119 Berlin. Freight paid by us. Carrier: Baltic Road Cargo SIA.`;
  const draftCmr = async () => {
    await owner`update public.messages set body_text = ${email}, subject = 'Transport order' where id = ${T.messageId}`;
    return withTenant(worker, T.tenantId, (tx) =>
      createDocument(tx, { tenantId: T.tenantId, type: 'cmr', fromMessageId: T.messageId }),
    );
  };
  const f = (field: string, value: string, source: string) => ({ field, value, source });

  it('keeps only what the e-mail says, with its source, and marks it done', async () => {
    const id = await draftCmr();
    const llm = new FakeProvider({
      responder: () =>
        JSON.stringify({
          fields: [
            f('consignee.name', 'Keller Wohnen GmbH', 'Keller Wohnen GmbH'),
            f('consignee.address', 'Torstraße 140, 10119 Berlin', 'Torstraße 140, 10119 Berlin'),
            f('goods.0.packages', '4', '4 pallets'),
            f('goods.0.grossKg', '620', '620 kg'),
            f('takingOver.date', `${year}-10-14`, `on 14.10.${year}`),
            f('carriagePayment', 'paid', 'Freight paid by us'),
            f('carrier.name', 'Baltic Road Cargo SIA', 'Baltic Road Cargo SIA'),
            // Invented: not in the e-mail.
            f('carrier.address', 'Ganību dambis 1, Rīga', 'Ganību dambis 1, Rīga'),
          ],
        }),
    });
    const r = await documentsPrefillHandler({ sql: worker, llm })(
      job(QUEUES.documentsPrefill, { documentId: id }),
    );
    expect(r).toEqual({ status: 'done', filled: 7, dropped: 1 });
    const d = await withTenant(worker, T.tenantId, (tx) => loadDocument(tx, { id }));
    expect(d!.prefillStatus).toBe('done');
    expect(d!.data).toMatchObject({
      sender: { name: 'SIA Nordlicht', country: 'Latvia' },
      consignee: { name: 'Keller Wohnen GmbH' },
      goods: [{ packages: 4, grossKg: 620 }],
      takingOver: { date: `${year}-10-14`, country: 'Latvia' },
      carriagePayment: 'paid',
      carrier: { name: 'Baltic Road Cargo SIA', address: '' },
    });
    expect(Object.keys(d!.prefill!).sort()).toEqual([
      'carriagePayment',
      'carrier.name',
      'consignee.address',
      'consignee.name',
      'goods.0.grossKg',
      'goods.0.packages',
      'takingOver.date',
    ]);
    // The model never saw the business's own details as something to fill.
    expect(llm.calls[0]!.system).toContain('Never fill details of the business');
  });

  it('the free AI tier may not read a customer mailbox', async () => {
    const id = await draftCmr();
    const llm = new FakeProvider({ trainingPolicy: 'may_train_on_data', responder: () => '{}' });
    const r = await documentsPrefillHandler({ sql: worker, llm })(
      job(QUEUES.documentsPrefill, { documentId: id }),
    );
    expect(r).toEqual({ status: 'failed', why: 'free_tier_refused' });
    expect(llm.calls).toHaveLength(0);
  });
});
