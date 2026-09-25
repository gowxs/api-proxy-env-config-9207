import { randomUUID } from 'node:crypto';
import { nextFollowupAt } from '@noctiv/core';
import { JobError, type Job } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { buildOutboundMessage } from '@noctiv/mail';
import { simpleParser } from 'mailparser';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { QUEUES } from '../src/queues.ts';
import {
  addGreenmailConnection,
  createFolder,
  header,
  keys,
  readFolder,
  startFakeSmtp,
} from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
const shop = GREENMAIL_USERS.sendShop;
const customer = GREENMAIL_USERS.sendCustomer;

const send = mailSendHandler({ sql: worker, keys, allowInsecure: true });
const sendRecovering = mailSendHandler({ sql: worker, keys, allowInsecure: true, inProgressMs: 0 });

let T: SeededTenant;
let connectionId: string;

const job = (tenantId: string, draftId: string, attempts = 1): Job => ({
  id: randomUUID(),
  tenantId,
  queue: QUEUES.mailSend,
  payload: { draftId },
  attempts,
  maxAttempts: 5,
});

/** An inbound customer email in its own thread, plus a reply draft for it. */
async function makeDraft(opts: {
  tenantId?: string;
  connectionId?: string;
  status?: string;
  decidedBy?: string | null;
  body?: string;
  to?: string;
  subject?: string;
  kind?: 'reply' | 'followup' | 'acknowledgement';
}) {
  const tenantId = opts.tenantId ?? T.tenantId;
  const conn = opts.connectionId ?? connectionId;
  const tag = randomUUID().slice(0, 8);
  const to = opts.to ?? customer.address;
  const [lead] = await owner<{ id: string }[]>`
    insert into public.leads (tenant_id, email) values (${tenantId}, ${to})
    on conflict (tenant_id, email) do update set last_activity_at = now() returning id`;
  const [thread] = await owner<{ id: string }[]>`
    insert into public.threads (tenant_id, connection_id, lead_id, subject, status)
    values (${tenantId}, ${conn}, ${lead!.id}, 'Candle order', 'open') returning id`;
  const inboundId = `<in-${tag}@example-mail.test>`;
  const [msg] = await owner<{ id: string }[]>`
    insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, reference_ids,
                                 from_address, subject, body_text, received_at)
    values (${tenantId}, ${conn}, ${thread!.id}, 'inbound', ${inboundId}, ${[`<root-${tag}@example-mail.test>`]},
            ${to}, 'Candle order', 'Do you have lavender candles?', now())
    returning id`;
  await owner`insert into public.message_processing (tenant_id, message_id, status, classification)
              values (${tenantId}, ${msg!.id}, 'drafted', ${owner.json({ summary: 'Asks about lavender candles.' })})`;
  const [draft] = await owner<{ id: string }[]>`
    insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, status, decided_by, decided_at)
    values (${tenantId}, ${thread!.id}, ${msg!.id}, ${opts.kind ?? 'reply'}, ${to}, ${opts.subject ?? `Re: Candle order ${tag}`},
            ${opts.body ?? 'Yes, lavender candles are in stock.'}, ${opts.status ?? 'approved'},
            ${opts.decidedBy === undefined ? 'owner' : opts.decidedBy}, now())
    returning id`;
  return {
    tenantId,
    draftId: draft!.id,
    threadId: thread!.id,
    leadId: lead!.id,
    messageId: msg!.id,
    inboundId,
    rootId: `<root-${tag}@example-mail.test>`,
    tag,
  };
}

const outbound = (draftId: string) =>
  owner<
    {
      status: string;
      message_id_header: string;
      sent_via: string;
      appended_to_sent: boolean;
      sent_at: Date | null;
      attempts: number;
      error: string | null;
    }[]
  >`select status, message_id_header, sent_via, appended_to_sent, sent_at, attempts, error
    from public.outbound_emails where draft_id = ${draftId}`;
const draftStatus = async (draftId: string) =>
  (await owner<{ status: string }[]>`select status from public.drafts where id = ${draftId}`)[0]
    ?.status;
const inboxWith = async (text: string) =>
  (await readFolder(gm, customer)).filter((m) => m.raw.includes(text));
const notifications = (tenantId: string, kind: string) =>
  owner<{ channel: string; payload: Record<string, unknown> }[]>`
    select channel, payload from public.notifications where tenant_id = ${tenantId} and kind = ${kind} order by channel`;

beforeAll(async () => {
  T = await seedTenant(owner, 'send', { embeddingAxis: 70 });
  await owner`update public.tenants set reply_signature = 'Liga — Lumen Studio', mode = 'auto_send',
                                        followup_after_days = 3, followup_max = 2 where id = ${T.tenantId}`;
  connectionId = await addGreenmailConnection(owner, gm, {
    tenantId: T.tenantId,
    address: shop.address,
    password: shop.password,
    displayName: 'Lumen Studio',
  });
});
afterAll(() => Promise.all([owner.end(), worker.end()]));

describe('mail.send against GreenMail', () => {
  it('sends an owner-approved reply with threading headers and the signature', async () => {
    const d = await makeDraft({});
    expect(await send(job(d.tenantId, d.draftId))).toEqual({ status: 'sent' });

    const [o] = await outbound(d.draftId);
    expect(o).toMatchObject({ status: 'sent', sent_via: 'owner_approval', attempts: 1 });
    const [mail] = await inboxWith(d.tag);
    expect(mail).toBeDefined();
    const raw = mail!.raw;
    expect(header(raw, 'Message-ID')).toBe(o!.message_id_header);
    expect(header(raw, 'In-Reply-To')).toBe(d.inboundId);
    expect(header(raw, 'References')).toBe(`${d.rootId} ${d.inboundId}`);
    expect(header(raw, 'From')).toBe(`Lumen Studio <${shop.address}>`);
    expect(header(raw, 'To')).toBe(customer.address);
    expect(header(raw, 'Subject')).toBe(`Re: Candle order ${d.tag}`);
    expect(header(raw, 'Auto-Submitted')).toBeNull();
    expect(raw).toContain('Yes, lavender candles are in stock.');
    expect(raw).toMatch(/Liga =E2=80=94 Lumen Studio|Liga — Lumen Studio/);

    expect(await draftStatus(d.draftId)).toBe('sent');
    const [th] = await owner<
      {
        status: string;
        next_followup_at: Date;
        followups_sent: number;
        last_outbound_at: Date;
      }[]
    >`select status, next_followup_at, followups_sent, last_outbound_at from public.threads where id = ${d.threadId}`;
    expect(th!.status).toBe('awaiting_customer');
    expect(th!.followups_sent).toBe(0);
    expect(th!.next_followup_at.toISOString()).toBe(
      nextFollowupAt(o!.sent_at!, 3, 'Europe/Riga').toISOString(),
    );
    const [lead] = await owner<
      { stage: string }[]
    >`select stage from public.leads where id = ${d.leadId}`;
    expect(lead!.stage).toBe('sent');
    const stored = await owner<{ direction: string; body_text: string; thread_id: string }[]>`
      select direction, body_text, thread_id from public.messages where message_id_header = ${o!.message_id_header}`;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ direction: 'outbound', thread_id: d.threadId });
    expect(stored[0]!.body_text).toContain('Liga — Lumen Studio');
  });

  it('marks automatic replies with Auto-Submitted: auto-replied (loop prevention)', async () => {
    const d = await makeDraft({ decidedBy: 'auto' });
    expect(await send(job(d.tenantId, d.draftId))).toEqual({ status: 'sent' });
    const [mail] = await inboxWith(d.tag);
    expect(header(mail!.raw, 'Auto-Submitted')).toBe('auto-replied');
    const [o] = await outbound(d.draftId);
    expect(o!.sent_via).toBe('auto');
    const [mp] = await owner<
      { status: string }[]
    >`select status from public.message_processing where message_id = ${d.messageId}`;
    expect(mp!.status).toBe('auto_sent');
  });

  it('a repeated job or a double approval never sends twice', async () => {
    const d = await makeDraft({});
    const results = await Promise.allSettled([
      send(job(d.tenantId, d.draftId)),
      send(job(d.tenantId, d.draftId)),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
    expect(await send(job(d.tenantId, d.draftId))).toEqual({ status: 'already_sent' });
    expect(await inboxWith(d.tag)).toHaveLength(1);
  });

  it('does nothing for drafts that are not approved', async () => {
    for (const status of ['pending_approval', 'rejected', 'suggestion']) {
      const d = await makeDraft({ status, decidedBy: null });
      expect(await send(job(d.tenantId, d.draftId))).toEqual({ skipped: `draft_${status}` });
      expect(await inboxWith(d.tag)).toHaveLength(0);
      expect(await outbound(d.draftId)).toHaveLength(0);
    }
  });

  it('appends the sent message to the Sent folder (marked read)', async () => {
    const t = await seedTenant(owner, 'send-append', { embeddingAxis: 71 });
    await createFolder(gm, shop, 'Sent');
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
      sentAppendMode: 'append',
      sentFolder: 'Sent',
    });
    const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn });
    expect(await send(job(t.tenantId, d.draftId))).toEqual({ status: 'sent' });
    const [o] = await outbound(d.draftId);
    expect(o!.appended_to_sent).toBe(true);
    const sent = (await readFolder(gm, shop, 'Sent')).filter(
      (m) => header(m.raw, 'Message-ID') === o!.message_id_header,
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.flags).toContain('\\Seen');
    expect(await inboxWith(d.tag)).toHaveLength(1);
  });
});

describe('auto-send safety re-checked at send time', () => {
  it('a sender cap reached meanwhile turns the auto reply back into a draft for approval', async () => {
    const t = await seedTenant(owner, 'send-cap', { embeddingAxis: 72 });
    await owner`update public.tenants set mode = 'auto_send', max_ai_replies_per_sender_24h = 1 where id = ${t.tenantId}`;
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    const first = await makeDraft({ tenantId: t.tenantId, connectionId: conn, decidedBy: 'auto' });
    const second = await makeDraft({ tenantId: t.tenantId, connectionId: conn, decidedBy: 'auto' });
    expect(await send(job(t.tenantId, first.draftId))).toEqual({ status: 'sent' });
    expect(await send(job(t.tenantId, second.draftId))).toEqual({
      status: 'downgraded',
      reasons: ['sender_cap_reached'],
    });
    expect(await draftStatus(second.draftId)).toBe('pending_approval');
    expect(await inboxWith(second.tag)).toHaveLength(0);
    const n = await notifications(t.tenantId, 'draft_ready');
    expect(n).toHaveLength(1);
    expect(n[0]!.payload).toMatchObject({
      draftId: second.draftId,
      reasons: ['sender_cap_reached'],
      senderDomain: 'example-mail.test',
    });
    expect(n[0]!.payload.draftText).toBeUndefined(); // privacy mode
  });

  it('an owner switch to draft-only stops a queued auto reply', async () => {
    const t = await seedTenant(owner, 'send-mode', { embeddingAxis: 73 });
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn, decidedBy: 'auto' });
    // seedTenant leaves the tenant in draft_only mode.
    expect(await send(job(t.tenantId, d.draftId))).toEqual({
      status: 'downgraded',
      reasons: ['mode_changed_to_draft_only'],
    });
    expect(await inboxWith(d.tag)).toHaveLength(0);
  });

  it('a lapsed subscription stops queued auto replies; the owner can still approve them', async () => {
    const t = await seedTenant(owner, 'send-lapsed', { embeddingAxis: 74 });
    await owner`update public.tenants set mode = 'auto_send', billing_status = 'canceled' where id = ${t.tenantId}`;
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn, decidedBy: 'auto' });
    expect(await send(job(t.tenantId, d.draftId))).toEqual({
      status: 'downgraded',
      reasons: ['billing_inactive'],
    });
    expect(await inboxWith(d.tag)).toHaveLength(0);
    const approved = await makeDraft({ tenantId: t.tenantId, connectionId: conn });
    expect(await send(job(t.tenantId, approved.draftId))).toEqual({ status: 'sent' });
  });
});

describe('e-mail design', () => {
  it('sends the tenant design as multipart/alternative with a full text part', async () => {
    const t = await seedTenant(owner, 'send-design', { embeddingAxis: 75 });
    await owner`update public.tenants set email_template = 'branded', reply_signature = 'Liga — Lumen Studio',
                brand_company_name = 'Lumen Studio', brand_logo_url = 'https://lumen.test/logo.png',
                brand_color = '#2A3566', brand_website = 'https://lumen.test', brand_phone = '+371 2000 0000'
                where id = ${t.tenantId}`;
    await owner`insert into public.kb_allowlist (tenant_id, source_id, kind, value)
                values (${t.tenantId}, ${t.sourceId}, 'domain', 'lumen.test')`;
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn });
    expect(await send(job(t.tenantId, d.draftId))).toEqual({ status: 'sent' });
    const [m] = await inboxWith(d.tag);
    const parsed = await simpleParser(m!.raw);
    expect(m!.raw).toMatch(/Content-Type: multipart\/alternative/);
    // The company name is left out: the signature already has it.
    expect(parsed.text?.trimEnd()).toBe(
      'Yes, lavender candles are in stock.\n\nLiga — Lumen Studio\n\nhttps://lumen.test\n+371 2000 0000',
    );
    expect(parsed.html).toContain('Yes, lavender candles are in stock.');
    expect(parsed.html).toContain('<img src="https://lumen.test/logo.png"');
    expect(parsed.html).toContain('background:#2A3566');
  });

  it('the default (plain) design sends text only', async () => {
    const d = await makeDraft({});
    expect(await send(job(T.tenantId, d.draftId))).toEqual({ status: 'sent' });
    const [m] = await inboxWith(d.tag);
    expect(m!.raw).not.toMatch(/multipart|text\/html/);
    expect((await simpleParser(m!.raw)).text?.trimEnd()).toBe(
      'Yes, lavender candles are in stock.\n\nLiga — Lumen Studio',
    );
  });
});

describe('mode 3: acknowledgements', () => {
  async function fullAutoTenant(label: string, axis: number) {
    const t = await seedTenant(owner, label, { embeddingAxis: axis });
    await owner`update public.tenants set mode = 'full_auto', followup_after_days = 3, followup_max = 2
                where id = ${t.tenantId}`;
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    return { t, conn };
  }
  /** An acknowledgement draft for a message the pipeline escalated. */
  async function ackDraft(tenantId: string, conn: string) {
    const d = await makeDraft({
      tenantId,
      connectionId: conn,
      kind: 'acknowledgement',
      decidedBy: 'auto',
      body: "Thanks — I'll check this and get back to you today.",
    });
    await owner`update public.threads set status = 'escalated' where id = ${d.threadId}`;
    await owner`update public.leads set stage = 'escalated' where id = ${d.leadId}`;
    await owner`update public.message_processing set status = 'escalated' where message_id = ${d.messageId}`;
    return d;
  }

  it('goes out, and the conversation stays with the owner (no follow-up, lead unchanged)', async () => {
    const { t, conn } = await fullAutoTenant('send-ack', 74);
    const d = await ackDraft(t.tenantId, conn);
    expect(await send(job(t.tenantId, d.draftId))).toEqual({ status: 'sent' });
    expect(await inboxWith(d.tag)).toHaveLength(1);
    expect((await outbound(d.draftId))[0]).toMatchObject({ status: 'sent', sent_via: 'auto' });
    const [thread] = await owner<{ status: string; next_followup_at: Date | null }[]>`
      select status, next_followup_at from public.threads where id = ${d.threadId}`;
    expect(thread).toEqual({ status: 'escalated', next_followup_at: null });
    const [lead] = await owner<
      { stage: string }[]
    >`select stage from public.leads where id = ${d.leadId}`;
    expect(lead!.stage).toBe('escalated');
    const [mp] = await owner<{ status: string }[]>`
      select status from public.message_processing where message_id = ${d.messageId}`;
    expect(mp!.status).toBe('escalated');
  });

  it('is cancelled, not turned into an approval, when the owner left mode 3 meanwhile', async () => {
    const { t, conn } = await fullAutoTenant('send-ack-mode', 75);
    const d = await ackDraft(t.tenantId, conn);
    await owner`update public.tenants set mode = 'auto_send' where id = ${t.tenantId}`;
    expect(await send(job(t.tenantId, d.draftId))).toEqual({
      skipped: 'acknowledgement_cancelled',
      reasons: ['mode_changed'],
    });
    expect(await draftStatus(d.draftId)).toBe('superseded');
    expect(await inboxWith(d.tag)).toHaveLength(0);
    expect(await notifications(t.tenantId, 'draft_ready')).toHaveLength(0);
  });

  it('automatic replies go out in mode 3 as in mode 2', async () => {
    const { t, conn } = await fullAutoTenant('send-full-reply', 76);
    const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn, decidedBy: 'auto' });
    expect(await send(job(t.tenantId, d.draftId))).toEqual({ status: 'sent' });
  });
});

describe('crash recovery', () => {
  async function crashedSend(appendMode: 'append' | 'none', inSent: boolean) {
    const t = await seedTenant(owner, `send-crash-${appendMode}`, { embeddingAxis: 74 });
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
      sentAppendMode: appendMode,
      sentFolder: appendMode === 'append' ? 'Sent' : undefined,
    });
    const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn });
    const messageId = `<noctiv.${randomUUID()}@lumen-studio.test>`;
    await owner`insert into public.outbound_emails (tenant_id, draft_id, thread_id, message_id_header, to_address, subject,
                                                    sent_via, status, attempts)
                values (${t.tenantId}, ${d.draftId}, ${d.threadId}, ${messageId}, ${customer.address}, 'Re: Candle order',
                        'owner_approval', 'sending', 1)`;
    if (inSent) {
      const raw = await buildOutboundMessage({
        from: { address: shop.address },
        to: customer.address,
        subject: 'Re: Candle order',
        text: 'sent before the crash',
        messageId,
      });
      await createFolder(gm, shop, 'Sent', raw);
    }
    return { t, d, messageId };
  }

  it('a send still in progress elsewhere is retried later, not repeated', async () => {
    const { t, d } = await crashedSend('none', false);
    await expect(send(job(t.tenantId, d.draftId, 2))).rejects.toMatchObject({
      message: 'send in progress',
      retryable: true,
    });
  });

  it('finds the message in the Sent folder and marks it sent without sending again', async () => {
    const { t, d } = await crashedSend('append', true);
    expect(await sendRecovering(job(t.tenantId, d.draftId, 2))).toEqual({
      status: 'sent',
      recovered: true,
    });
    expect(await draftStatus(d.draftId)).toBe('sent');
    expect(await inboxWith(d.tag)).toHaveLength(0);
  });

  it('when nothing proves the outcome it never resends: failed + owner notified', async () => {
    const { t, d } = await crashedSend('none', false);
    expect(await sendRecovering(job(t.tenantId, d.draftId, 2))).toEqual({
      status: 'failed',
      code: 'SEND_UNCERTAIN',
    });
    expect(await draftStatus(d.draftId)).toBe('send_failed');
    expect((await outbound(d.draftId))[0]!.status).toBe('failed');
    const n = await notifications(t.tenantId, 'send_failed');
    expect(n).toEqual([
      {
        channel: 'email_owner',
        payload: expect.objectContaining({ code: 'SEND_UNCERTAIN', draftId: d.draftId }),
      },
    ]);
    expect(await inboxWith(d.tag)).toHaveLength(0);
  });
});

describe('SMTP failures', () => {
  it('a permanent rejection (5xx) fails the draft and notifies the owner', async () => {
    const smtp = await startFakeSmtp('550 5.1.1 mailbox unavailable');
    try {
      const t = await seedTenant(owner, 'send-550', { embeddingAxis: 75 });
      const conn = await addGreenmailConnection(owner, gm, {
        tenantId: t.tenantId,
        address: 'fake-550@lumen-studio.test',
        password: 'x',
        smtpHost: '127.0.0.1',
        smtpPort: smtp.port,
      });
      const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn });
      const err = await send(job(t.tenantId, d.draftId)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(JobError);
      expect(err).toMatchObject({ retryable: false });
      expect(await draftStatus(d.draftId)).toBe('send_failed');
      expect((await outbound(d.draftId))[0]).toMatchObject({ status: 'failed' });
      expect(await notifications(t.tenantId, 'send_failed')).toHaveLength(1);
    } finally {
      await smtp.close();
    }
  });

  it('a temporary rejection (4xx) is retried with the same Message-ID', async () => {
    const smtp = await startFakeSmtp('451 4.3.0 try again later');
    try {
      const t = await seedTenant(owner, 'send-451', { embeddingAxis: 76 });
      const conn = await addGreenmailConnection(owner, gm, {
        tenantId: t.tenantId,
        address: 'fake-451@lumen-studio.test',
        password: 'x',
        smtpHost: '127.0.0.1',
        smtpPort: smtp.port,
      });
      const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn });
      await expect(send(job(t.tenantId, d.draftId))).rejects.toMatchObject({ retryable: true });
      const [o1] = await outbound(d.draftId);
      expect(o1).toMatchObject({ status: 'queued' });
      expect(await draftStatus(d.draftId)).toBe('approved');

      await expect(send(job(t.tenantId, d.draftId, 2))).rejects.toMatchObject({
        retryable: true,
      });
      const [o2] = await outbound(d.draftId);
      expect(o2).toMatchObject({ status: 'queued', attempts: 2 });
      expect(o2!.message_id_header).toBe(o1!.message_id_header);

      // Last attempt: give up and tell the owner.
      await expect(send(job(t.tenantId, d.draftId, 5))).rejects.toMatchObject({
        retryable: false,
      });
      expect(await draftStatus(d.draftId)).toBe('send_failed');
    } finally {
      await smtp.close();
    }
  });

  it('an SMTP login failure disconnects the mailbox and notifies owner and admin', async () => {
    const t = await seedTenant(owner, 'send-auth', { embeddingAxis: 77 });
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: 'revoked-app-password',
    });
    const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn });
    await expect(send(job(t.tenantId, d.draftId))).rejects.toMatchObject({ retryable: false });
    const [c] = await owner<{ status: string; last_error_code: string }[]>`
      select status, last_error_code from public.email_connections where id = ${conn}`;
    expect(c).toEqual({ status: 'disconnected', last_error_code: 'SMTP_AUTH_FAILED' });
    expect(await draftStatus(d.draftId)).toBe('send_failed');
    expect((await notifications(t.tenantId, 'mailbox_disconnected')).map((n) => n.channel)).toEqual(
      ['email_admin', 'email_owner'],
    );
    expect(await notifications(t.tenantId, 'send_failed')).toHaveLength(1);
  });

  it('a disconnected mailbox fails the draft without trying to send', async () => {
    const t = await seedTenant(owner, 'send-disc', { embeddingAxis: 78 });
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: t.tenantId,
      address: shop.address,
      password: shop.password,
    });
    await owner`update public.email_connections set status = 'disconnected' where id = ${conn}`;
    const d = await makeDraft({ tenantId: t.tenantId, connectionId: conn });
    expect(await send(job(t.tenantId, d.draftId))).toEqual({
      status: 'failed',
      code: 'MAILBOX_DISCONNECTED',
    });
    expect(await draftStatus(d.draftId)).toBe('send_failed');
  });
});
