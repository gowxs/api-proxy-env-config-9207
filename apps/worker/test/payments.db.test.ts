import { randomUUID } from 'node:crypto';
import type { GenerateRequest } from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import {
  createDocument,
  issueDocument,
  linkPayment,
  loadDocument,
  writeDocumentData,
} from '@noctiv/documents';
import { FakeProvider } from '@noctiv/llm';
import type { InboundMessage } from '@noctiv/mail';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { storeInbound } from '../src/ingest/store.ts';
import { processMessage } from '../src/pipeline/process.ts';
import { queuePaymentReminders } from '../src/ops/payment-reminders.ts';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, keys, readFolder } from './helpers.ts';
import { GREENMAIL_USERS } from '@noctiv/db/testing';
import { simpleParser } from 'mailparser';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

const BANK = 'swedbank.test';
const PASS = `mx.example.test; dkim=pass header.d=${BANK}; dmarc=pass header.from=${BANK}`;
const bankMail = (
  text: string,
  o: { from?: string; auth?: string | null } = {},
): InboundMessage => ({
  messageId: `<${randomUUID()}@${BANK}>`,
  inReplyTo: null,
  references: [],
  from: { address: o.from ?? `noreply@notify.${BANK}`, name: 'Swedbank' },
  replyTo: [],
  to: ['shop@nordlicht.test'],
  cc: [],
  subject: 'Incoming payment',
  text,
  htmlHiddenText: false,
  loopHeaders: {
    'auto-submitted': 'auto-generated',
    ...(o.auth === null ? {} : { 'authentication-results': o.auth ?? PASS }),
  },
  attachments: [],
  date: new Date(),
});
const credit = (amount: string, payer: string, details: string) =>
  `You have received a payment. Amount: ${amount} EUR. Payer: ${payer}. Payment details: ${details}.`;

/** The fake model: reads the bank e-mail like a careful model would (copying its words). */
function model(reply: (text: string) => Record<string, unknown>) {
  return new FakeProvider({
    responder: (req: GenerateRequest) => {
      const email = req.parts.find((p) => p.kind === 'untrusted_email')?.text ?? '';
      if (req.system.startsWith('You read a notification e-mail from a bank'))
        return JSON.stringify(reply(email));
      return JSON.stringify({
        category: 'other',
        sentiment: 'neutral',
        urgency: 'normal',
        language: 'en',
        summary: 'Says a payment was made.',
      });
    },
  });
}
const readAll = (email: string) => {
  const g = (re: RegExp) => {
    const m = re.exec(email);
    return m ? { value: m[1]!, source: m[0]! } : null;
  };
  return {
    credit: true,
    amount: g(/Amount: ([\d.,]+) EUR/),
    currency: null,
    payer_name: g(/Payer: ([^.]+)/),
    reference: g(/Payment details: ([^.]+?)\.(?:\s|$)/),
  };
};

async function tenant(label: string, mode: 'draft_only' | 'auto_send') {
  const t = await seedTenant(owner, label, { embeddingAxis: 190 });
  await owner`delete from public.documents where tenant_id = ${t.tenantId}`;
  await owner`delete from public.payments where tenant_id = ${t.tenantId}`;
  await owner`update public.tenants
              set mode = ${mode}, documents_enabled = true, seller_legal_name = 'SIA Nordlicht',
                  seller_legal_address = 'Rīga', seller_vat_no = 'LV40003123456',
                  seller_iban = 'LV80BANK0000435195001'
              where id = ${t.tenantId}`;
  await owner`delete from public.bank_senders where tenant_id = ${t.tenantId}`;
  await owner`insert into public.bank_senders (tenant_id, domain) values (${t.tenantId}, ${BANK})`;
  return t;
}

/** A sent invoice to "SIA Ozols Būve" for 600.46 EUR. */
async function sentInvoice(t: SeededTenant) {
  return withTenant(worker, t.tenantId, async (tx) => {
    const id = await createDocument(tx, {
      tenantId: t.tenantId,
      type: 'invoice',
      threadId: t.threadId,
    });
    const d = (await loadDocument(tx, { id }))!;
    await writeDocumentData(tx, d, {
      ...d.data,
      buyer: { name: 'SIA Ozols Būve', address: 'Rīga', regNo: '', vatNo: '', email: '' },
      lines: [
        { name: 'Lavender candle', unit: 'pcs', qty: 20, unitPriceCents: 2400 },
        { name: 'Gift box', unit: 'box', qty: 2.5, unitPriceCents: 650 },
      ],
    } as never);
    const r = await issueDocument(tx, (await loadDocument(tx, { id }))!, {});
    if (!r.ok) throw new Error(r.problems.join('; '));
    await tx`update public.documents set status = 'sent', sent_at = now() where id = ${id}`;
    return { id, number: r.number };
  });
}

async function receive(t: SeededTenant, msg: InboundMessage, llm: FakeProvider) {
  const id = await withTenant(worker, t.tenantId, (tx) =>
    storeInbound(tx, {
      tenantId: t.tenantId,
      connectionId: t.connectionId,
      uid: Math.floor(Math.random() * 1e6),
      msg,
    }),
  );
  const outcome = await processMessage(
    { sql: worker, llm, embeddings: new FakeProvider() },
    t.tenantId,
    id!,
  );
  return { id: id!, outcome };
}
const docStatus = async (id: string) =>
  (await owner<{ status: string }[]>`select status from public.documents where id = ${id}`)[0]!
    .status;
const paymentOf = async (messageId: string) =>
  (
    await owner<
      {
        status: string;
        match_kind: string | null;
        document_id: string | null;
        amount_cents: number;
      }[]
    >`
      select status, match_kind, document_id, amount_cents from public.payments where message_id = ${messageId}`
  )[0];

describe('incoming payments', () => {
  let T2: SeededTenant;
  let T1: SeededTenant;
  beforeAll(async () => {
    T2 = await tenant('pay-mode2', 'auto_send');
    T1 = await tenant('pay-mode1', 'draft_only');
  });

  it('exact match in mode 2: the invoice is marked paid and the owner told; never a reply or a lead', async () => {
    const inv = await sentInvoice(T2);
    const leadsBefore = (await owner`select id from public.leads where tenant_id = ${T2.tenantId}`)
      .length;
    const llm = model(readAll);
    const { id, outcome } = await receive(
      T2,
      bankMail(credit('600,46', 'SIA Ozols Būve', `Rēķins ${inv.number}`)),
      llm,
    );
    expect(outcome).toEqual({ status: 'skipped', reason: 'bank_payment:matched' });
    expect(await docStatus(inv.id)).toBe('paid');
    expect(await paymentOf(id)).toMatchObject({
      status: 'matched',
      match_kind: 'exact',
      document_id: inv.id,
    });
    const [n] = await owner<{ kind: string }[]>`
      select kind from public.notifications where tenant_id = ${T2.tenantId} and kind = 'payment_matched'`;
    expect(n?.kind).toBe('payment_matched');
    expect(await owner`select 1 from public.drafts where source_message_id = ${id}`).toHaveLength(
      0,
    );
    expect((await owner`select id from public.leads where tenant_id = ${T2.tenantId}`).length).toBe(
      leadsBefore,
    );
    // Only the payment step ran: no classification, no reply generation.
    expect(llm.calls).toHaveLength(1);
  });

  it('exact match in mode 1: proposed, the invoice stays open until the owner clicks', async () => {
    const inv = await sentInvoice(T1);
    const { id } = await receive(
      T1,
      bankMail(credit('600,46', 'SIA Ozols Būve', inv.number)),
      model(readAll),
    );
    expect(await paymentOf(id)).toMatchObject({
      status: 'proposed',
      match_kind: 'exact',
      document_id: inv.id,
    });
    expect(await docStatus(inv.id)).toBe('sent');
  });

  it('partial matches are only proposed, even in mode 2', async () => {
    const T = await tenant('pay-partial', 'auto_send');
    const inv = await sentInvoice(T);
    // The amount, no invoice number.
    const a = await receive(
      T,
      bankMail(credit('600,46', 'Somebody Else', 'Thank you')),
      model(readAll),
    );
    expect(await paymentOf(a.id)).toMatchObject({
      status: 'proposed',
      match_kind: 'amount',
      document_id: inv.id,
    });
    // The buyer paid, but another amount.
    const b = await receive(
      T,
      bankMail(credit('300,00', 'SIA Ozols Būve', 'part one')),
      model(readAll),
    );
    expect(await paymentOf(b.id)).toMatchObject({
      status: 'proposed',
      match_kind: 'payer',
      document_id: inv.id,
    });
    expect(await docStatus(inv.id)).toBe('sent');
  });

  it('no match: kept for manual linking', async () => {
    const T = await tenant('pay-none', 'auto_send');
    await sentInvoice(T);
    const { id, outcome } = await receive(
      T,
      bankMail(credit('17,00', 'Unknown Person', 'gift')),
      model(readAll),
    );
    expect(outcome).toEqual({ status: 'skipped', reason: 'bank_payment:unmatched' });
    expect(await paymentOf(id)).toMatchObject({
      status: 'unmatched',
      document_id: null,
      amount_cents: 1700,
    });
  });

  it('a forged "payment received" e-mail from a non-bank sender is ignored', async () => {
    const T = await tenant('pay-forged', 'auto_send');
    const inv = await sentInvoice(T);
    const llm = model(readAll);
    const { id } = await receive(
      T,
      bankMail(credit('600,46', 'SIA Ozols Būve', inv.number), {
        from: 'payments@swedbank-secure.test',
        auth: 'mx; dkim=pass header.d=swedbank-secure.test',
      }),
      llm,
    );
    expect(await paymentOf(id)).toBeUndefined();
    expect(await docStatus(inv.id)).toBe('sent');
    expect(
      llm.calls.some((c) => c.system.startsWith('You read a notification e-mail from a bank')),
    ).toBe(false);
  });

  it('an e-mail that only claims to be from the bank (not verified) is ignored and not answered', async () => {
    const T = await tenant('pay-spoof', 'auto_send');
    const inv = await sentInvoice(T);
    const llm = model(readAll);
    const { id, outcome } = await receive(
      T,
      bankMail(credit('600,46', 'SIA Ozols Būve', inv.number), {
        auth: `mx; dkim=fail header.d=${BANK}; dmarc=fail header.from=${BANK}`,
      }),
      llm,
    );
    expect(outcome).toEqual({ status: 'skipped', reason: 'bank_sender_unverified' });
    expect(await paymentOf(id)).toBeUndefined();
    expect(await docStatus(inv.id)).toBe('sent');
    expect(llm.calls).toHaveLength(0);
  });
});

describe('overdue reminder', () => {
  const overdue = (id: string, days: number) =>
    owner`update public.documents set due_date = current_date - ${days}::int where id = ${id}`;
  const reminderOf = async (id: string) =>
    (
      await owner<
        { status: string; kind: string; body: string; decided_by: string | null; id: string }[]
      >`
        select dr.id, dr.status, dr.kind, dr.body, dr.decided_by from public.documents d
        join public.drafts dr on dr.id = d.reminder_draft_id where d.id = ${id}`
    )[0];

  it('mode 1: 3 days after the due date a reminder waits for approval, once', async () => {
    const T = await tenant('remind-mode1', 'draft_only');
    const inv = await sentInvoice(T);
    await overdue(inv.id, 2);
    await queuePaymentReminders(worker);
    expect(await reminderOf(inv.id)).toBeUndefined();
    await overdue(inv.id, 3);
    await queuePaymentReminders(worker);
    const r = (await reminderOf(inv.id))!;
    expect(r).toMatchObject({
      kind: 'payment_reminder',
      status: 'pending_approval',
      decided_by: null,
    });
    expect(r.body).toContain(`invoice ${inv.number}`);
    expect(r.body).toContain('€600.46');
    const [n] = await owner<{ kind: string }[]>`
      select kind from public.notifications where tenant_id = ${T.tenantId} and dedupe_key = ${`draft:${r.id}`}`;
    expect(n?.kind).toBe('draft_ready');
    await queuePaymentReminders(worker);
    const all =
      await owner`select 1 from public.drafts where tenant_id = ${T.tenantId} and kind = 'payment_reminder'`;
    expect(all).toHaveLength(1);
  });

  it('paid or not yet sent invoices get none; paying drops a queued reminder', async () => {
    const T = await tenant('remind-paid', 'draft_only');
    const paid = await sentInvoice(T);
    await owner`update public.documents set status = 'paid' where id = ${paid.id}`;
    await overdue(paid.id, 10);
    const issuedOnly = await sentInvoice(T);
    await owner`update public.documents set status = 'issued' where id = ${issuedOnly.id}`;
    await overdue(issuedOnly.id, 10);
    const queued = await sentInvoice(T);
    await overdue(queued.id, 10);
    await queuePaymentReminders(worker);
    expect(await reminderOf(paid.id)).toBeUndefined();
    expect(await reminderOf(issuedOnly.id)).toBeUndefined();
    const r = (await reminderOf(queued.id))!;
    // The customer pays before the owner approves: the reminder is dropped.
    const { id: msg } = await receive(
      T,
      bankMail(credit('600,46', 'SIA Ozols Būve', queued.number)),
      model(readAll),
    );
    await withTenant(worker, T.tenantId, async (tx) => {
      const [p] = await tx<
        { id: string }[]
      >`select id from public.payments where message_id = ${msg}`;
      await linkPayment(tx, p!.id, null);
    });
    const [after] = await owner<
      { status: string }[]
    >`select status from public.drafts where id = ${r.id}`;
    expect(after!.status).toBe('superseded');
  });

  it('mode 2: sent on its own, with the invoice attached again', async () => {
    const T = await tenant('remind-mode2', 'auto_send');
    const shop = GREENMAIL_USERS.payShop;
    const customer = GREENMAIL_USERS.payCustomer;
    const connectionId = await addGreenmailConnection(owner, gm, {
      tenantId: T.tenantId,
      address: shop.address,
      password: shop.password,
    });
    await owner`update public.threads set connection_id = ${connectionId} where id = ${T.threadId}`;
    await owner`update public.messages set from_address = ${customer.address} where id = ${T.messageId}`;
    const inv = await sentInvoice(T);
    await overdue(inv.id, 4);
    await queuePaymentReminders(worker);
    const r = (await reminderOf(inv.id))!;
    expect(r).toMatchObject({ status: 'approved', decided_by: 'auto' });
    const send = mailSendHandler({ sql: worker, keys, allowInsecure: true });
    const res = await send({
      id: randomUUID(),
      tenantId: T.tenantId,
      queue: QUEUES.mailSend,
      payload: { draftId: r.id },
      attempts: 1,
      maxAttempts: 5,
    });
    expect(res).toEqual({ status: 'sent' });
    const mail = (await readFolder(gm, customer)).find(
      (m) => m.raw.includes('friendly reminder') && m.raw.includes(inv.number),
    );
    const parsed = await simpleParser(mail!.raw);
    expect(parsed.attachments.map((a) => a.filename)).toEqual([`Invoice-${inv.number}.pdf`]);
    expect(parsed.headers.get('auto-submitted')).toBe('auto-replied');
  });
});
