import { randomUUID } from 'node:crypto';
import {
  createFakeGoogleCalendar,
  DEFAULT_SETTINGS,
  freeSlots,
  sealCalendarToken,
} from '@noctiv/bookings';
import type { GenerateRequest } from '@noctiv/core';
import { withTenant, type Job } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { FakeProvider } from '@noctiv/llm';
import type { InboundMessage } from '@noctiv/mail';
import { simpleParser } from 'mailparser';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { storeInbound } from '../src/ingest/store.ts';
import {
  bookingCancelHandler,
  bookingConfirmHandler,
  calendarSyncHandler,
} from '../src/jobs/bookings.ts';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { processMessage } from '../src/pipeline/process.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, keys, readFolder, waitFor } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
const SECRET = 'k'.repeat(40);
const shop = GREENMAIL_USERS.bookShop;
const customer = GREENMAIL_USERS.bookCustomer;
const google = createFakeGoogleCalendar();
const deps = { sql: worker, keys, google, secret: SECRET, appUrl: 'https://app.noctiv.test' };

const job = (
  tenantId: string,
  queue: string,
  payload: Record<string, unknown>,
  attempts = 1,
): Job => ({
  id: randomUUID(),
  tenantId,
  queue,
  payload,
  attempts,
  maxAttempts: 5,
});
const send = mailSendHandler({ sql: worker, keys, allowInsecure: true });

let T: SeededTenant;
let connectionId = '';

/** Sends every queued mail.send job of the tenant, like the worker loop would. */
async function flushMail(tenantId: string) {
  const jobs = await owner<{ id: string; payload: { draftId: string } }[]>`
    select id, payload from public.jobs where tenant_id = ${tenantId} and queue = 'mail.send' and status = 'queued'`;
  for (const j of jobs) {
    await send(job(tenantId, QUEUES.mailSend, j.payload));
    await owner`update public.jobs set status = 'done' where id = ${j.id}`;
  }
  return jobs.length;
}

/** A pending booking at the tenant's first free time (as the API's booking page makes it). */
async function pendingBooking(
  extra: { rescheduledFrom?: string; leadId?: string; answers?: unknown[] } = {},
) {
  const busy = await owner<{ s: Date; e: Date }[]>`
    select starts_at as s, ends_at as e from public.bookings
    where tenant_id = ${T.tenantId} and status in ('pending', 'confirmed')`;
  const slot = freeSlots({
    settings: { ...DEFAULT_SETTINGS, noticeHours: 0 },
    timeZone: 'Europe/Riga',
    busy: [
      ...busy.map((b) => ({ start: b.s, end: b.e })),
      ...(await google.freeBusy('x', new Date(), new Date(Date.now() + 40 * 86_400_000))),
    ],
    now: new Date(),
    limit: 1,
  })[0]!;
  const [b] = await owner<{ id: string }[]>`
    insert into public.bookings (tenant_id, lead_id, name, email, starts_at, ends_at, language, status,
                                 rescheduled_from, answers, note)
    values (${T.tenantId}, ${extra.leadId ?? null}, 'Dace Ozola', ${customer.address}, ${slot.start}, ${slot.end}, 'en',
            'pending', ${extra.rescheduledFrom ?? null}, ${owner.json((extra.answers ?? []) as never)}, 'About the website')
    returning id`;
  return { id: b!.id, slot };
}

beforeAll(async () => {
  T = await seedTenant(owner, 'bookings-w', { embeddingAxis: 160 });
  await owner`delete from public.bookings where tenant_id = ${T.tenantId}`;
  await owner`delete from public.calendar_connections where tenant_id = ${T.tenantId}`;
  await owner`delete from public.calendar_busy where tenant_id = ${T.tenantId}`;
  connectionId = await addGreenmailConnection(owner, gm, {
    tenantId: T.tenantId,
    address: shop.address,
    password: shop.password,
    displayName: 'Lumen Studio',
  });
  await owner`update public.email_connections set status = 'disconnected' where id = ${T.connectionId}`;
  await owner`update public.threads set connection_id = ${connectionId} where tenant_id = ${T.tenantId}`;
  await owner`update public.tenants set bookings_enabled = true, booking_slug = 'lumen-studio', name = 'Lumen Studio'
              where id = ${T.tenantId}`;
  await owner`update public.booking_settings
              set location_kind = 'google_meet', meeting_title = 'Intro call', notice_hours = 0, form_id = null,
                  hours = ${owner.json(Object.fromEntries(['1', '2', '3', '4', '5', '6', '7'].map((d) => [d, [{ from: '00:00', to: '23:30' }]])))}
              where tenant_id = ${T.tenantId}`;
  const id = randomUUID();
  const sealed = sealCalendarToken('fake-refresh-token', keys.publicKey, T.tenantId, id);
  await owner`insert into public.calendar_connections (id, tenant_id, provider, account_email, credentials_ciphertext,
                                                        credentials_key_id, status)
              values (${id}, ${T.tenantId}, 'google', 'calendar@example.com', ${sealed.ciphertext}, ${sealed.keyId}, 'connected')`;
});
afterAll(() => Promise.all([owner.end(), worker.end()]));

describe('calendar sync', () => {
  it('stores busy times only, and marks a revoked calendar', async () => {
    const r = await calendarSyncHandler(deps)(job(T.tenantId, QUEUES.calendarSync, {}));
    expect(r).toMatchObject({ busy: expect.any(Number) });
    const [c] = await owner<
      { n: number }[]
    >`select count(*)::int as n from public.calendar_busy where tenant_id = ${T.tenantId}`;
    expect(c!.n).toBeGreaterThan(20);
    const [conn] =
      await owner`select synced_at from public.calendar_connections where tenant_id = ${T.tenantId}`;
    expect(conn!.synced_at).toBeTruthy();
  });
});

describe('confirming a booking', () => {
  it('creates the event with a Meet link, confirms, books the lead, stores answers and e-mails the customer', async () => {
    // A thread waiting for a follow-up: booking stops it.
    const [lead] = await owner<{ id: string }[]>`
      insert into public.leads (tenant_id, email, stage) values (${T.tenantId}, ${customer.address}, 'sent') returning id`;
    await owner`update public.threads set lead_id = ${lead!.id}, status = 'awaiting_customer',
                next_followup_at = now() + interval '2 days' where id = ${T.threadId}`;
    const { id, slot } = await pendingBooking({
      answers: [{ key: 'f1', label: 'Company', type: 'text', value: 'Ozola Design' }],
    });
    const r = await bookingConfirmHandler(deps)(
      job(T.tenantId, QUEUES.bookingsConfirm, { bookingId: id }),
    );
    expect(r).toMatchObject({ status: 'confirmed', calendar: true });
    const [b] =
      await owner`select status, lead_id, google_event_id, meet_url, thread_id from public.bookings where id = ${id}`;
    expect(b).toMatchObject({ status: 'confirmed', lead_id: lead!.id });
    expect(b!.google_event_id).toBe(`nb${id.replace(/-/g, '')}`);
    expect(b!.meet_url).toMatch(/^https:\/\/meet\.google\.com\//);
    expect(google.events.get(b!.google_event_id)).toMatchObject({
      summary: 'Intro call: Dace Ozola',
      attendee: customer.address,
    });
    const [l] = await owner`select stage from public.leads where id = ${lead!.id}`;
    expect(l!.stage).toBe('booked');
    const [th] =
      await owner`select next_followup_at, followup_stop_reason from public.threads where id = ${T.threadId}`;
    expect(th).toMatchObject({ next_followup_at: null, followup_stop_reason: 'booked' });
    const [sub] =
      await owner`select answers, form_name from public.intake_submissions where booking_id = ${id}`;
    expect(sub!.answers[0]).toMatchObject({ label: 'Company', value: 'Ozola Design' });
    const [n] =
      await owner`select kind, payload from public.notifications where dedupe_key = ${`booking_created:${id}`}`;
    expect(n!.payload).toMatchObject({
      customerName: 'Dace Ozola',
      senderDomain: 'example-mail.test',
    });
    expect(n!.payload.note).toBeUndefined();

    // The confirmation goes out from the business's mailbox with a calendar invite.
    expect(await flushMail(T.tenantId)).toBe(1);
    const mails = await waitFor(async () => {
      const m = await readFolder(gm, customer);
      return m.length ? m : null;
    });
    const parsed = await simpleParser(mails.at(-1)!.raw);
    expect(parsed.subject).toMatch(/^Booked: /);
    expect(parsed.text).toContain('Thank you for booking.');
    expect(parsed.text).toContain(b!.meet_url);
    expect(parsed.text).toContain('https://app.noctiv.test/book/lumen-studio/manage/b1.');
    const ics = parsed.attachments.find((a) => a.filename === 'invite.ics')!;
    expect(ics.content.toString()).toContain('METHOD:REQUEST');
    expect(ics.content.toString()).toContain(`UID:${id}@noctiv.io`);
    expect(ics.content.toString()).toContain(
      `DTSTART:${slot.start.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    );
    // No follow-up after a confirmation.
    const [after] = await owner`select status from public.threads where id = ${b!.thread_id}`;
    expect(after!.status).not.toBe('awaiting_customer');
  });

  it('a time that became busy in the calendar is refused ("taken")', async () => {
    const { id, slot } = await pendingBooking();
    google.busy.push({ start: slot.start, end: slot.end });
    const r = await bookingConfirmHandler(deps)(
      job(T.tenantId, QUEUES.bookingsConfirm, { bookingId: id }),
    );
    expect(r).toEqual({ status: 'taken' });
    const [b] = await owner`select status from public.bookings where id = ${id}`;
    expect(b!.status).toBe('taken');
    google.busy.length = 0;
  });

  it('a revoked calendar: the booking is still confirmed and the owner told', async () => {
    const { id } = await pendingBooking();
    google.failAuth = true;
    const r = await bookingConfirmHandler(deps)(
      job(T.tenantId, QUEUES.bookingsConfirm, { bookingId: id }),
    );
    google.failAuth = false;
    expect(r).toMatchObject({ status: 'confirmed', calendar: false });
    const [c] =
      await owner`select status, last_error from public.calendar_connections where tenant_id = ${T.tenantId}`;
    expect(c).toMatchObject({ status: 'error', last_error: 'access_revoked' });
    const [n] =
      await owner`select 1 from public.notifications where tenant_id = ${T.tenantId} and kind = 'calendar_disconnected'`;
    expect(n).toBeTruthy();
    await owner`update public.calendar_connections set status = 'connected', last_error = null where tenant_id = ${T.tenantId}`;
    await flushMail(T.tenantId);
  });

  it('moving keeps the event and the calendar identity; cancelling removes it and tells the customer', async () => {
    const first = await pendingBooking();
    await bookingConfirmHandler(deps)(
      job(T.tenantId, QUEUES.bookingsConfirm, { bookingId: first.id }),
    );
    const moved = await pendingBooking({ rescheduledFrom: first.id });
    const r = await bookingConfirmHandler(deps)(
      job(T.tenantId, QUEUES.bookingsConfirm, { bookingId: moved.id }),
    );
    expect(r).toMatchObject({ status: 'confirmed', calendar: true });
    const [old] = await owner`select status from public.bookings where id = ${first.id}`;
    expect(old!.status).toBe('rescheduled');
    const [nb] =
      await owner`select google_event_id, ics_uid, ics_sequence from public.bookings where id = ${moved.id}`;
    expect(nb).toMatchObject({ ics_uid: first.id, ics_sequence: 1 });
    expect(google.events.get(nb!.google_event_id)!.start.getTime()).toBe(
      moved.slot.start.getTime(),
    );
    const [n] =
      await owner`select 1 from public.notifications where dedupe_key = ${`booking_rescheduled:${moved.id}`}`;
    expect(n).toBeTruthy();

    await owner`update public.bookings set status = 'cancelled', cancelled_by = 'customer', cancelled_at = now() where id = ${moved.id}`;
    const c = await bookingCancelHandler(deps)(
      job(T.tenantId, QUEUES.bookingsCancel, { bookingId: moved.id, by: 'customer' }),
    );
    expect(c).toEqual({ status: 'cancelled', by: 'customer' });
    expect(google.events.has(nb!.google_event_id)).toBe(false);
    await flushMail(T.tenantId);
    const mails = await readFolder(gm, customer);
    const last = await simpleParser(mails.at(-1)!.raw);
    expect(last.subject).toMatch(/^Cancelled: /);
    const ics = last.attachments.find((a) => a.filename === 'invite.ics')!.content.toString();
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain(`UID:${first.id}@noctiv.io`);
    const [cn] =
      await owner`select 1 from public.notifications where dedupe_key = ${`booking_cancelled:${moved.id}`}`;
    expect(cn).toBeTruthy();
  });
});

describe('replies that offer times', () => {
  const kindOf = (req: GenerateRequest) =>
    req.system.startsWith('You classify')
      ? 'classify'
      : req.system.startsWith('You check a draft')
        ? 'verify'
        : 'generate';
  const llm = () =>
    new FakeProvider({
      responder: (req) =>
        kindOf(req) === 'classify'
          ? JSON.stringify({
              category: 'meeting_request',
              sentiment: 'positive',
              urgency: 'normal',
              language: 'de',
              summary: 'Customer wants a call about a new website.',
            })
          : kindOf(req) === 'verify'
            ? '{"supported":true,"unsupported_claims":[]}'
            : JSON.stringify({
                intent: 'meeting',
                language: 'de',
                reply: 'Gerne.',
                sources: [],
                confidence: 0.2,
                action: 'escalate',
                escalate_reason: 'no source',
              }),
    });
  const inbound = (): InboundMessage => ({
    messageId: `<${randomUUID()}@example-mail.test>`,
    inReplyTo: null,
    references: [],
    from: { address: customer.address, name: 'Dace Ozola' },
    replyTo: [],
    to: [shop.address],
    cc: [],
    subject: 'Termin?',
    text: 'Hallo, können wir nächste Woche telefonieren?',
    htmlHiddenText: false,
    loopHeaders: {},
    attachments: [],
    date: new Date(),
  });
  const run = async () => {
    const id = await withTenant(worker, T.tenantId, (tx) =>
      storeInbound(tx, {
        tenantId: T.tenantId,
        connectionId,
        uid: Math.floor(Math.random() * 1e6),
        msg: inbound(),
      }),
    );
    const outcome = await processMessage(
      { sql: worker, llm: llm(), embeddings: new FakeProvider(), bookings: deps },
      T.tenantId,
      id!,
    );
    return { outcome, messageId: id! };
  };

  it('mode 1: a draft with the next 3 free times and the booking link, in the customer language', async () => {
    await owner`update public.tenants set mode = 'draft_only' where id = ${T.tenantId}`;
    const { outcome, messageId } = await run();
    expect(outcome).toMatchObject({ status: 'drafted', reasons: ['tenant_draft_only'] });
    const [d] = await owner<
      { kind: string; status: string; body: string; booking_offer: { starts: string[] } }[]
    >`
      select kind, status, body, booking_offer from public.drafts where source_message_id = ${messageId}`;
    expect(d).toMatchObject({ kind: 'booking_offer', status: 'pending_approval' });
    expect(d!.body).toContain('Hallo Dace,');
    expect(d!.body).toContain('Die nächsten freien Zeiten');
    expect(d!.body.match(/^• /gm)).toHaveLength(3);
    expect(d!.body).toContain('https://app.noctiv.test/book/lumen-studio?r=r1.');
    expect(d!.booking_offer.starts).toHaveLength(3);
  });

  it('mode 2: sent automatically; a time taken meanwhile is replaced at send time', async () => {
    await owner`update public.tenants set mode = 'auto_send', max_ai_replies_per_sender_24h = 2 where id = ${T.tenantId}`;
    const { outcome, messageId } = await run();
    expect(outcome.status).toBe('auto_send');
    const [d] = await owner<{ id: string; booking_offer: { starts: string[] } }[]>`
      select id, booking_offer from public.drafts where source_message_id = ${messageId}`;
    // Someone books the first offered time before the e-mail goes out.
    const first = new Date(d!.booking_offer.starts[0]!);
    await owner`insert into public.bookings (tenant_id, name, email, starts_at, ends_at, status)
                values (${T.tenantId}, 'Other', 'other@example.com', ${first}, ${new Date(first.getTime() + 30 * 60_000)}, 'confirmed')`;
    await send(job(T.tenantId, QUEUES.mailSend, { draftId: d!.id }));
    const [after] = await owner<
      { status: string; body: string; booking_offer: { starts: string[] } }[]
    >`
      select status, body, booking_offer from public.drafts where id = ${d!.id}`;
    expect(after!.status).toBe('sent');
    expect(after!.booking_offer.starts).not.toContain(first.toISOString());
    expect(after!.body.match(/^• /gm)).toHaveLength(3);
  });

  it('with Bookings off it is an ordinary reply', async () => {
    await owner`update public.tenants set bookings_enabled = false, mode = 'draft_only' where id = ${T.tenantId}`;
    const { messageId } = await run();
    const drafts =
      await owner`select kind from public.drafts where source_message_id = ${messageId}`;
    expect(drafts.map((x) => x.kind)).not.toContain('booking_offer');
    await owner`update public.tenants set bookings_enabled = true where id = ${T.tenantId}`;
  });
});
