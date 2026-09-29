import { randomUUID } from 'node:crypto';
import type { Job } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant } from '@noctiv/db/testing';
import { ImapFlow } from 'imapflow';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { mailFetchHandler } from '../src/jobs/mail-fetch.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, createFolder, keys, sendMail } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

const shop = GREENMAIL_USERS.sentShop;
const customer = GREENMAIL_USERS.sentCustomer.address;
const fetchHandler = mailFetchHandler({ sql: worker, keys, allowInsecure: true });

interface Ctx {
  tenantId: string;
  connectionId: string;
  run: () => Promise<unknown>;
}
let n = 0;

/** A tenant + mailbox whose first fetch has recorded the INBOX and Sent positions. */
async function setup(
  provider: 'generic' | 'yahoo' | 'hostinger' = 'generic',
  sentFolder: string | null = 'Sent',
  user: { address: string; password: string } = shop,
): Promise<Ctx> {
  const T = await seedTenant(owner, `sent-${provider}-${n++}`, { embeddingAxis: 200 + n });
  if (sentFolder) await createFolder(gm, user, sentFolder);
  const connectionId = await addGreenmailConnection(owner, gm, {
    tenantId: T.tenantId,
    address: user.address,
    password: user.password,
    provider,
    ...(sentFolder ? { sentFolder, sentAppendMode: 'append' as const } : {}),
  });
  const job = (): Job => ({
    id: 'x',
    tenantId: T.tenantId,
    queue: QUEUES.mailFetch,
    payload: { connectionId },
    attempts: 1,
    maxAttempts: 5,
  });
  const ctx = { tenantId: T.tenantId, connectionId, run: () => fetchHandler(job()) };
  await ctx.run(); // baseline
  return ctx;
}

const id = (label: string) => `<${label}-${randomUUID().slice(0, 8)}@sent-sync.test>`;

const raw = (o: { id: string; inReplyTo?: string; subject?: string; body?: string; to?: string }) =>
  Buffer.from(
    [
      `From: ${shop.address}`,
      `To: ${o.to ?? customer}`,
      `Subject: ${o.subject ?? 'Re: Candles'}`,
      `Message-ID: ${o.id}`,
      ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`, `References: ${o.inReplyTo}`] : []),
      `Date: ${new Date().toUTCString()}`,
      '',
      o.body ?? 'Sent from my own client.',
      '',
    ].join('\r\n'),
  );

const appendToSent = (buf: Buffer, folder = 'Sent') => createFolder(gm, shop, folder, buf);

/** A customer e-mail, fetched into a conversation. Returns its Message-ID. */
async function inboundMail(ctx: Ctx, subject = 'Candles?'): Promise<string> {
  const mid = id('in');
  await sendMail(gm, { from: customer, to: shop.address, subject, text: 'Price?', messageId: mid });
  await ctx.run();
  return mid;
}

const rows = (ctx: Ctx) =>
  owner<
    {
      message_id_header: string;
      direction: string;
      sent_by: string | null;
      seen: boolean | null;
      thread_id: string;
      body_text: string | null;
    }[]
  >`select message_id_header, direction, sent_by, seen, thread_id, body_text from public.messages
    where connection_id = ${ctx.connectionId} order by received_at, created_at`;

const state = async (ctx: Ctx) =>
  (
    await owner<
      {
        sent_uidvalidity: string | null;
        sent_last_uid: string | null;
        sent_sync_started_at: Date | null;
        sent_sync_error: string | null;
      }[]
    >`select sent_uidvalidity::text, sent_last_uid::text, sent_sync_started_at, sent_sync_error
      from public.email_connections where id = ${ctx.connectionId}`
  )[0]!;

describe('Sent folder sync', () => {
  it('the first run only records the position: existing Sent mail is not imported', async () => {
    await createFolder(gm, shop, 'Sent');
    // Mail sitting in Sent before the mailbox is connected (a reply to a customer thread).
    await appendToSent(raw({ id: id('old'), inReplyTo: '<whatever@x.test>' }));
    const ctx = await setup();
    expect(await rows(ctx)).toEqual([]);
    const s = await state(ctx);
    expect(s.sent_uidvalidity).not.toBeNull();
    expect(Number(s.sent_last_uid)).toBeGreaterThanOrEqual(1);
    expect(s.sent_sync_started_at).not.toBeNull();
    // Still nothing on later runs.
    await ctx.run();
    expect(await rows(ctx)).toEqual([]);
  });

  it('shows an owner reply in the thread, stops the follow-up and supersedes a waiting follow-up draft', async () => {
    const ctx = await setup();
    const inbound = await inboundMail(ctx);
    const [thread] = await owner<{ id: string }[]>`
      select thread_id as id from public.messages where connection_id = ${ctx.connectionId} limit 1`;
    await owner`update public.threads set status = 'awaiting_customer', next_followup_at = now() + interval '1 day'
                where id = ${thread!.id}`;
    const [d] = await owner<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, kind, to_address, subject, body, status)
      values (${ctx.tenantId}, ${thread!.id}, 'followup', ${customer}, 'Re: Candles', 'Just checking in', 'pending_approval')
      returning id`;

    const replyId = id('owner');
    await appendToSent(raw({ id: replyId, inReplyTo: inbound, body: 'Hi Nora, it is 12 EUR.' }));
    expect(await ctx.run()).toMatchObject({ sentStored: 1 });

    const all = await rows(ctx);
    const reply = all.find((m) => m.message_id_header === replyId)!;
    expect(reply).toMatchObject({
      direction: 'outbound',
      sent_by: 'owner',
      seen: true,
      thread_id: thread!.id,
    });
    expect(reply.body_text).toContain('12 EUR');
    const [t] = await owner<
      { next_followup_at: Date | null; followup_stop_reason: string | null }[]
    >`
      select next_followup_at, followup_stop_reason from public.threads where id = ${thread!.id}`;
    expect(t).toEqual({ next_followup_at: null, followup_stop_reason: 'owner_replied' });
    const [dr] = await owner<
      { status: string }[]
    >`select status from public.drafts where id = ${d!.id}`;
    expect(dr!.status).toBe('superseded');
    // A second sync run does not add it again.
    await ctx.run();
    expect((await rows(ctx)).filter((m) => m.message_id_header === replyId)).toHaveLength(1);
  });

  it('drops Sent mail that belongs to no known conversation, without keeping its Message-ID', async () => {
    const ctx = await setup();
    const inbound = await inboundMail(ctx);
    void inbound;
    const stranger = id('private');
    const strangerReply = id('private-reply');
    await appendToSent(raw({ id: stranger, subject: 'Lunch?', to: 'friend@example.org' }));
    await appendToSent(
      raw({ id: strangerReply, inReplyTo: '<unknown@elsewhere.test>', to: 'friend@example.org' }),
    );
    expect(await ctx.run()).toEqual({ stored: 0 });
    const ids = (await rows(ctx)).map((m) => m.message_id_header);
    expect(ids).not.toContain(stranger);
    expect(ids).not.toContain(strangerReply);
    // Nowhere else either: not in threads, outbound mail or the raw text of any table row.
    const [leak] = await owner<{ n: number }[]>`
      select (
        (select count(*) from public.threads where tenant_id = ${ctx.tenantId}
           and root_message_id_header in (${stranger}, ${strangerReply}))
        + (select count(*) from public.outbound_emails where message_id_header in (${stranger}, ${strangerReply}))
        + (select count(*) from public.messages where tenant_id = ${ctx.tenantId}
             and (message_id_header in (${stranger}, ${strangerReply}) or in_reply_to in (${stranger}, ${strangerReply})))
      )::int as n`;
    expect(leak!.n).toBe(0);
    // The position moved on: they are not looked at again.
    const s = await state(ctx);
    expect(Number(s.sent_last_uid)).toBeGreaterThanOrEqual(2);
  });

  it.each(['yahoo', 'hostinger', 'generic'] as const)(
    "does not duplicate Noctiv's own sent copy appended to Sent (%s)",
    async (provider) => {
      const ctx = await setup(provider);
      const inbound = await inboundMail(ctx);
      const [thread] = await owner<{ id: string }[]>`
        select thread_id as id from public.messages where connection_id = ${ctx.connectionId} limit 1`;
      // Noctiv sent this reply itself: its message row exists, then the copy is appended to Sent.
      const ours = id('noctiv');
      await owner`
        insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, in_reply_to,
                                     from_address, to_addresses, subject, body_text, received_at, seen, mailbox_folder, sent_by)
        values (${ctx.tenantId}, ${ctx.connectionId}, ${thread!.id}, 'outbound', ${ours}, ${inbound},
                ${shop.address}, ${[customer]}, 'Re: Candles', 'Our reply', now(), true, 'sent', 'noctiv')`;
      await appendToSent(raw({ id: ours, inReplyTo: inbound, body: 'Our reply' }));
      expect(await ctx.run()).toEqual({ stored: 0 });
      const copies = (await rows(ctx)).filter((m) => m.message_id_header === ours);
      expect(copies).toHaveLength(1);
      expect(copies[0]!.sent_by).toBe('noctiv');
    },
  );

  it('also skips a copy of a message that is still queued for sending (outbound_emails)', async () => {
    const ctx = await setup();
    const inbound = await inboundMail(ctx);
    const [thread] = await owner<{ id: string; lead_id: string | null }[]>`
      select thread_id as id, null::uuid as lead_id from public.messages where connection_id = ${ctx.connectionId} limit 1`;
    const [d] = await owner<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, kind, to_address, subject, body, status)
      values (${ctx.tenantId}, ${thread!.id}, 'reply', ${customer}, 'Re: Candles', 'Hello', 'approved')
      returning id`;
    const ours = id('queued');
    await owner`
      insert into public.outbound_emails (tenant_id, draft_id, thread_id, message_id_header, to_address, subject, sent_via, status)
      values (${ctx.tenantId}, ${d!.id}, ${thread!.id}, ${ours}, ${customer}, 'Re: Candles', 'owner_approval', 'sending')`;
    await appendToSent(raw({ id: ours, inReplyTo: inbound }));
    await ctx.run();
    expect((await rows(ctx)).filter((m) => m.message_id_header === ours)).toHaveLength(0);
  });

  it('a Sent UIDVALIDITY change re-reads recent mail, without duplicates or history', async () => {
    const ctx = await setup();
    const inbound = await inboundMail(ctx);
    const first = id('first');
    await appendToSent(raw({ id: first, inReplyTo: inbound, body: 'first reply' }));
    await ctx.run();
    expect((await rows(ctx)).filter((m) => m.sent_by === 'owner')).toHaveLength(1);

    // The provider renumbers the folder (a different UIDVALIDITY): stored UIDs are meaningless.
    await owner`update public.email_connections set sent_uidvalidity = sent_uidvalidity + 12345 where id = ${ctx.connectionId}`;
    const second = id('second');
    await appendToSent(raw({ id: second, inReplyTo: inbound, body: 'second reply' }));
    await ctx.run();

    const owned = (await rows(ctx)).filter((m) => m.sent_by === 'owner');
    expect(owned.map((m) => m.message_id_header).sort()).toEqual([first, second].sort());
    const s = await state(ctx);
    expect(s.sent_uidvalidity).not.toBeNull();
    // The position is reset to the folder's current state, and the next run finds nothing new.
    expect(await ctx.run()).toEqual({ stored: 0 });
    expect((await rows(ctx)).filter((m) => m.sent_by === 'owner')).toHaveLength(2);
  });

  it('a UIDVALIDITY change never imports mail from before syncing began', async () => {
    const ctx = await setup();
    const inbound = await inboundMail(ctx);
    const early = id('early');
    await appendToSent(raw({ id: early, inReplyTo: inbound }));
    // Pretend syncing began after that message arrived, then renumber the folder.
    await owner`update public.email_connections
                set sent_sync_started_at = now() + interval '1 hour', sent_uidvalidity = sent_uidvalidity + 999
                where id = ${ctx.connectionId}`;
    await ctx.run();
    expect((await rows(ctx)).map((m) => m.message_id_header)).not.toContain(early);
  });

  it('asks for the folder name when there is no Sent marker, and reports a wrong name', async () => {
    // A mailbox with no Sent folder at all (the customer account never had one).
    const noFolder = await setup('generic', null, GREENMAIL_USERS.sentCustomer);
    await noFolder.run();
    expect(await state(noFolder)).toMatchObject({ sent_sync_error: 'NO_SENT_FOLDER' });

    const wrong = await setup('generic', null, GREENMAIL_USERS.sentCustomer);
    await owner`update public.email_connections set sent_folder_path = 'Does.Not.Exist' where id = ${wrong.connectionId}`;
    await wrong.run();
    expect(await state(wrong)).toMatchObject({ sent_sync_error: 'FOLDER_NOT_FOUND' });

    // The owner enters a real name: syncing starts (from now, no history) and the error clears.
    await owner`update public.email_connections
                set sent_folder_path = 'Sent', sent_uidvalidity = null, sent_last_uid = null,
                    sent_sync_started_at = null, sent_sync_error = null
                where id = ${wrong.connectionId}`;
    await createFolder(gm, GREENMAIL_USERS.sentCustomer, 'Sent');
    await wrong.run();
    const s = await state(wrong);
    expect(s.sent_sync_error).toBeNull();
    expect(s.sent_sync_started_at).not.toBeNull();
  });
});

describe('read state', () => {
  it('mirrors the provider \\Seen flag, read-only', async () => {
    const ctx = await setup();
    const mid = await inboundMail(ctx, 'Seen test');
    const seen = async () => (await rows(ctx)).find((m) => m.message_id_header === mid)!.seen;
    expect(await seen()).toBe(false);

    // The owner reads it in their own mail client.
    const client = new ImapFlow({
      host: gm.host,
      port: gm.imapPort,
      secure: false,
      auth: { user: shop.address, pass: shop.password },
      logger: false,
    });
    await client.connect();
    try {
      await client.mailboxOpen('INBOX');
      await client.messageFlagsAdd({ header: { 'message-id': mid } }, ['\\Seen']);
    } finally {
      await client.logout();
    }
    await ctx.run();
    expect(await seen()).toBe(true);
  });
});
