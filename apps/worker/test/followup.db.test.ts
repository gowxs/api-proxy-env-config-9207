import { randomUUID } from 'node:crypto';
import { nextFollowupAt, type GenerateRequest } from '@noctiv/core';
import { withTenant, type Job } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant } from '@noctiv/db/testing';
import { createNoteSource, createSafeFetcher, ingestSource } from '@noctiv/kb';
import { FakeProvider } from '@noctiv/llm';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { KB_CHUNKS } from '../../../packages/core/test/fixtures/kb.ts';
import { generateFollowup, scanFollowups } from '../src/followups/followup.ts';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, header, keys, readFolder } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

const U = GREENMAIL_USERS;
// Tuesday 2026-09-22 10:00 in Riga (UTC+3): inside the business window.
const TUESDAY_10 = new Date('2026-09-22T07:00:00Z');
const SENT_AT = new Date('2026-09-17T08:00:00Z'); // our reply, the Thursday before
const DUE_AT = new Date('2026-09-22T06:30:00Z');

const FOLLOWUP =
  'Hello again! Do you have any other questions about our candles? We are happy to help.';
function model(generate: Record<string, unknown> = {}) {
  return new FakeProvider({
    responder: (req: GenerateRequest) => {
      if (req.system.startsWith('You check a draft'))
        return '{"supported":true,"unsupported_claims":[]}';
      return JSON.stringify({
        intent: 'followup',
        language: 'en',
        reply: FOLLOWUP,
        sources: [],
        confidence: 0.95,
        action: 'auto_send',
        escalate_reason: null,
        ...generate,
      });
    },
  });
}
const genCalls = (p: FakeProvider) =>
  p.calls.filter((c) => c.system.startsWith('You draft a short follow-up')).length;

async function tenant(label: string, mode: 'draft_only' | 'auto_send') {
  const t = await seedTenant(owner, label, { embeddingAxis: 95 });
  await owner`update public.tenants set mode = ${mode}, name = 'Lumen Studio', followup_max = 2, followup_after_days = 3
              where id = ${t.tenantId}`;
  const embeddings = new FakeProvider();
  for (const c of KB_CHUNKS.slice(0, 3)) {
    const id = await withTenant(worker, t.tenantId, (tx) =>
      createNoteSource(tx, { tenantId: t.tenantId, title: 'kb', text: c.content }),
    );
    await ingestSource({ sql: worker, embeddings, fetcher: createSafeFetcher() }, t.tenantId, id);
  }
  const connectionId = await addGreenmailConnection(owner, gm, {
    tenantId: t.tenantId,
    address: U.sendShop.address,
    password: U.sendShop.password,
  });
  return { ...t, connectionId };
}

/** A thread where we answered and the customer has been silent since. */
async function silentThread(
  t: Awaited<ReturnType<typeof tenant>>,
  opts: { followupsSent?: number; nextAt?: Date } = {},
) {
  const tag = randomUUID().slice(0, 8);
  const [lead] = await owner<{ id: string }[]>`
    insert into public.leads (tenant_id, email, stage) values (${t.tenantId}, ${`c-${tag}@example-mail.test`}, 'sent')
    returning id`;
  const customer = U.sendCustomer.address;
  const [th] = await owner<{ id: string }[]>`
    insert into public.threads (tenant_id, connection_id, lead_id, subject, status, last_inbound_at, last_outbound_at,
                                followups_sent, next_followup_at)
    values (${t.tenantId}, ${t.connectionId}, ${lead!.id}, 'Candle price', 'awaiting_customer',
            ${new Date(SENT_AT.getTime() - 3_600_000)}, ${SENT_AT}, ${opts.followupsSent ?? 0}, ${opts.nextAt ?? DUE_AT})
    returning id`;
  const inId = `<fq-${tag}@example-mail.test>`;
  const [m] = await owner<{ id: string }[]>`
    insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, from_address,
                                 subject, body_text, received_at)
    values (${t.tenantId}, ${t.connectionId}, ${th!.id}, 'inbound', ${inId}, ${customer}, ${`Candle price ${tag}`},
            'Hello, how much is one candle?', ${new Date(SENT_AT.getTime() - 3_600_000)})
    returning id`;
  await owner`insert into public.message_processing (tenant_id, message_id, status, classification)
              values (${t.tenantId}, ${m!.id}, 'drafted', ${owner.json({
                category: 'product_question',
                sentiment: 'neutral',
                urgency: 'normal',
                language: 'en',
                summary: 'Asks for a price.',
              })})`;
  await owner`insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, in_reply_to,
                                           reference_ids, from_address, subject, body_text, received_at)
              values (${t.tenantId}, ${t.connectionId}, ${th!.id}, 'outbound', ${`<out-${tag}@lumen-studio.test>`}, ${inId},
                      ${[inId]}, ${U.sendShop.address}, ${`Re: Candle price ${tag}`}, 'One candle costs 24 EUR.', ${SENT_AT})`;
  return { threadId: th!.id, leadId: lead!.id, tag, inId, outId: `<out-${tag}@lumen-studio.test>` };
}

const thread = async (id: string) =>
  (
    await owner<
      {
        status: string;
        followups_sent: number;
        next_followup_at: Date | null;
        followup_stop_reason: string | null;
      }[]
    >`select status, followups_sent, next_followup_at, followup_stop_reason from public.threads where id = ${id}`
  )[0]!;
const followupDrafts = (threadId: string) =>
  owner<{ id: string; status: string; to_address: string; subject: string; body: string }[]>`
    select id, status, to_address, subject, body from public.drafts where thread_id = ${threadId} and kind = 'followup'
    order by created_at`;
const deps = (llm: FakeProvider) => ({ sql: worker, llm, embeddings: llm });
const send = mailSendHandler({ sql: worker, keys, allowInsecure: true });
const sendJob = (tenantId: string, draftId: string): Job => ({
  id: randomUUID(),
  tenantId,
  queue: QUEUES.mailSend,
  payload: { draftId },
  attempts: 1,
  maxAttempts: 5,
});

describe('follow-up scan', () => {
  it('queues one job per due thread, and none for threads that are not due', async () => {
    const t = await tenant('fu-scan', 'draft_only');
    const due = await silentThread(t);
    const later = await silentThread(t, { nextAt: new Date(Date.now() + 86_400_000) });
    const maxed = await silentThread(t, { followupsSent: 2 });
    await scanFollowups(worker);
    await scanFollowups(worker); // singleton: still one job
    const jobs = await owner<{ payload: { threadId: string } }[]>`
      select payload from public.jobs where tenant_id = ${t.tenantId} and queue = ${QUEUES.followup}`;
    expect(jobs.map((j) => j.payload.threadId)).toEqual([due.threadId]);
    expect(jobs.map((j) => j.payload.threadId)).not.toContain(later.threadId);
    expect(jobs.map((j) => j.payload.threadId)).not.toContain(maxed.threadId);
  });

  it('skips mailboxes that are disconnected', async () => {
    const t = await tenant('fu-scan-disc', 'draft_only');
    await silentThread(t);
    await owner`update public.email_connections set status = 'disconnected' where id = ${t.connectionId}`;
    await scanFollowups(worker);
    expect(
      await owner`select 1 from public.jobs where tenant_id = ${t.tenantId} and queue = ${QUEUES.followup}`,
    ).toHaveLength(0);
  });
});

describe('follow-up generation', () => {
  it('draft-only tenant: a follow-up draft for approval and an owner email', async () => {
    const t = await tenant('fu-draft', 'draft_only');
    const th = await silentThread(t);
    const llm = model();
    expect(await generateFollowup(deps(llm), t.tenantId, th.threadId, TUESDAY_10)).toEqual({
      status: 'drafted',
      reasons: ['tenant_draft_only'],
    });
    const [d] = await followupDrafts(th.threadId);
    expect(d).toMatchObject({
      status: 'pending_approval',
      to_address: U.sendCustomer.address,
      subject: `Re: Candle price ${th.tag}`,
      body: FOLLOWUP,
    });
    expect((await thread(th.threadId)).next_followup_at).toBeNull(); // paused until sent
    const [n] = await owner<{ payload: Record<string, unknown> }[]>`
      select payload from public.notifications where tenant_id = ${t.tenantId} and dedupe_key = ${`draft:${d!.id}`}`;
    expect(n!.payload).toMatchObject({ kind: 'draft_ready', draftId: d!.id });
    expect(String(n!.payload.summary)).toContain('Follow-up 1 of 2');
    expect(n!.payload.draftText).toBeUndefined();
    // Running again does nothing: a follow-up is already waiting.
    expect(await generateFollowup(deps(llm), t.tenantId, th.threadId, TUESDAY_10)).toMatchObject({
      status: 'skipped',
    });
    expect(genCalls(llm)).toBe(1);
  });

  it('auto-send tenant: follow-ups 1 and 2 go out threaded, then they stop', async () => {
    const t = await tenant('fu-auto', 'auto_send');
    const th = await silentThread(t);
    const llm = model();
    expect(await generateFollowup(deps(llm), t.tenantId, th.threadId, TUESDAY_10)).toEqual({
      status: 'auto_send',
      reasons: [],
    });
    const [d1] = await followupDrafts(th.threadId);
    expect(d1!.status).toBe('approved');
    expect(await send(sendJob(t.tenantId, d1!.id))).toEqual({ status: 'sent' });

    const mail = (await readFolder(gm, U.sendCustomer)).find(
      (m) => header(m.raw, 'In-Reply-To') === th.outId,
    );
    expect(mail).toBeDefined();
    expect(header(mail!.raw, 'Auto-Submitted')).toBe('auto-replied');
    expect(header(mail!.raw, 'References')).toBe(`${th.inId} ${th.outId}`);
    let state = await thread(th.threadId);
    expect(state.followups_sent).toBe(1);
    expect(state.next_followup_at).not.toBeNull();
    const [lead] = await owner<
      { stage: string }[]
    >`select stage from public.leads where id = ${th.leadId}`;
    expect(lead!.stage).toBe('followed_up');

    // Second (last) follow-up.
    await owner`update public.threads set next_followup_at = ${DUE_AT} where id = ${th.threadId}`;
    const sentAt = (
      await owner<
        { last_outbound_at: Date }[]
      >`select last_outbound_at from public.threads where id = ${th.threadId}`
    )[0]!.last_outbound_at;
    // The next moment inside the business window after the first follow-up went out.
    const later = nextFollowupAt(new Date(sentAt.getTime() + 60_000), 0, 'Europe/Riga');
    expect(await generateFollowup(deps(llm), t.tenantId, th.threadId, later)).toEqual({
      status: 'auto_send',
      reasons: [],
    });
    {
      const [, d2] = await followupDrafts(th.threadId);
      expect(await send(sendJob(t.tenantId, d2!.id))).toEqual({ status: 'sent' });
      state = await thread(th.threadId);
      expect(state).toMatchObject({
        followups_sent: 2,
        next_followup_at: null,
        followup_stop_reason: 'max_reached',
      });
      const last = llm.calls
        .filter((c) => c.system.startsWith('You draft a short follow-up'))
        .at(-1)!;
      expect(last.system).toContain('follow-up number 2');
      expect(last.system).toContain('last message');
    }
  });

  it('stops when the customer has answered, without calling the model', async () => {
    const t = await tenant('fu-replied', 'auto_send');
    const th = await silentThread(t);
    await owner`insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, from_address,
                                             subject, body_text, received_at)
                values (${t.tenantId}, ${t.connectionId}, ${th.threadId}, 'inbound', ${`<ans-${th.tag}@example-mail.test>`},
                        ${U.sendCustomer.address}, 'Re: Candle price', 'Thanks!', ${new Date(SENT_AT.getTime() + 3_600_000)})`;
    const llm = model();
    expect(await generateFollowup(deps(llm), t.tenantId, th.threadId, TUESDAY_10)).toEqual({
      status: 'stopped',
      reason: 'customer_replied',
    });
    expect(genCalls(llm)).toBe(0);
    expect((await thread(th.threadId)).next_followup_at).toBeNull();
  });

  it('outside business hours it waits for the next window (Q7)', async () => {
    const t = await tenant('fu-weekend', 'auto_send');
    const th = await silentThread(t);
    const llm = model();
    const saturday = new Date('2026-09-26T09:00:00Z');
    expect(await generateFollowup(deps(llm), t.tenantId, th.threadId, saturday)).toEqual({
      status: 'rescheduled',
      at: '2026-09-28T06:00:00.000Z', // Monday 09:00 Riga
    });
    expect(genCalls(llm)).toBe(0);
  });

  it('never follows up with converted or escalated leads', async () => {
    const t = await tenant('fu-lead', 'auto_send');
    const th = await silentThread(t);
    await owner`update public.leads set stage = 'converted' where id = ${th.leadId}`;
    expect(await generateFollowup(deps(model()), t.tenantId, th.threadId, TUESDAY_10)).toEqual({
      status: 'stopped',
      reason: 'lead_converted',
    });
  });

  it('a follow-up the policy would escalate is not sent and follow-ups stop', async () => {
    const t = await tenant('fu-escalate', 'auto_send');
    const th = await silentThread(t);
    const llm = model({
      reply: 'Order today and get 20% off, only until Friday!',
      confidence: 0.9,
    });
    expect(await generateFollowup(deps(llm), t.tenantId, th.threadId, TUESDAY_10)).toEqual({
      status: 'stopped',
      reason: 'policy_escalate',
    });
    expect(await followupDrafts(th.threadId)).toHaveLength(0);
    expect((await thread(th.threadId)).followup_stop_reason).toBe('policy_escalate');
  });

  it('an approved follow-up is not sent if the customer answered in the meantime', async () => {
    const t = await tenant('fu-stale', 'draft_only');
    const th = await silentThread(t);
    await generateFollowup(deps(model()), t.tenantId, th.threadId, TUESDAY_10);
    const [d] = await followupDrafts(th.threadId);
    await owner`update public.drafts set status = 'approved', decided_by = 'owner' where id = ${d!.id}`;
    await owner`insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, from_address,
                                             subject, body_text, received_at)
                values (${t.tenantId}, ${t.connectionId}, ${th.threadId}, 'inbound', ${`<late-${th.tag}@example-mail.test>`},
                        ${U.sendCustomer.address}, 'Re: Candle price', 'I will take two.', now())`;
    expect(await send(sendJob(t.tenantId, d!.id))).toEqual({ skipped: 'followup_superseded' });
    expect((await followupDrafts(th.threadId))[0]!.status).toBe('superseded');
    expect(
      (await readFolder(gm, U.sendCustomer)).filter(
        (m) => header(m.raw, 'In-Reply-To') === th.outId,
      ),
    ).toHaveLength(0);
  });
});
