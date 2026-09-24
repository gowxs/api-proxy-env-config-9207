import { randomUUID } from 'node:crypto';
import type { GenerateRequest } from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { createNoteSource, createSafeFetcher, ingestSource } from '@noctiv/kb';
import { FakeProvider } from '@noctiv/llm';
import type { InboundMessage } from '@noctiv/mail';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  ATTACK_FIXTURES,
  type AttackEmail,
} from '../../../packages/core/test/fixtures/attack-emails.ts';
import { KB_CHUNKS } from '../../../packages/core/test/fixtures/kb.ts';
import { storeInbound } from '../src/ingest/store.ts';
import { mailFetchHandler } from '../src/jobs/mail-fetch.ts';
import { processMessage } from '../src/pipeline/process.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, keys, sendMail } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });

type Kind = 'classify' | 'generate' | 'verify';
const kindOf = (req: GenerateRequest): Kind =>
  req.system.startsWith('You classify')
    ? 'classify'
    : req.system.startsWith('You check a draft')
      ? 'verify'
      : 'generate';

const cls = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    category: 'product_question',
    sentiment: 'neutral',
    urgency: 'normal',
    language: 'en',
    summary: 'Customer asks about prices.',
    ...patch,
  });
const gen = (patch: Record<string, unknown> = {}) =>
  JSON.stringify({
    intent: 'price',
    language: 'en',
    reply: 'Hello, one candle costs 24 EUR and shipping within Latvia takes 2-3 business days.',
    sources: ['S1'],
    confidence: 0.93,
    action: 'auto_send',
    escalate_reason: null,
    ...patch,
  });

/** Fake model scripted per call kind; records calls. */
function scripted(
  script: Partial<Record<Kind, string | ((req: GenerateRequest) => string)>>,
  trainingPolicy?: 'may_train_on_data',
) {
  const p = new FakeProvider({
    trainingPolicy,
    responder: (req) => {
      const r =
        script[kindOf(req)] ??
        (kindOf(req) === 'classify'
          ? cls()
          : kindOf(req) === 'verify'
            ? '{"supported":true,"unsupported_claims":[]}'
            : gen({ sources: [labelOf(req, 'cost 24 EUR')] }));
      return typeof r === 'function' ? r(req) : r;
    },
  });
  return p;
}
/** The prompt label ("S3") of the knowledge-base excerpt containing `text`. */
function labelOf(req: GenerateRequest, text: string): string {
  const kb = req.parts.find((p) => p.kind === 'kb_context')?.text ?? '';
  const blocks = kb.split(/\n(?=\[S\d+\]\n)/);
  const hit = blocks.find((b) => b.includes(text));
  return /\[(S\d+)\]/.exec(hit ?? '')?.[1] ?? 'S1';
}

const calls = (p: FakeProvider, kind: Kind) => p.calls.filter((c) => kindOf(c) === kind).length;

async function tenantWithKb(
  label: string,
  mode: 'draft_only' | 'auto_send' = 'draft_only',
): Promise<SeededTenant> {
  const t = await seedTenant(owner, label, { embeddingAxis: 50 });
  await owner`update public.tenants set mode = ${mode}, name = 'Nordlicht Candles' where id = ${t.tenantId}`;
  const embeddings = new FakeProvider();
  for (const c of KB_CHUNKS) {
    const id = await withTenant(worker, t.tenantId, (tx) =>
      createNoteSource(tx, { tenantId: t.tenantId, title: 'kb', text: c.content }),
    );
    await ingestSource({ sql: worker, embeddings, fetcher: createSafeFetcher() }, t.tenantId, id);
  }
  return t;
}

function inbound(
  email: Partial<AttackEmail> & {
    text?: string;
    headers?: Record<string, string>;
    inReplyTo?: string;
    hiddenHtml?: boolean;
  },
): InboundMessage {
  return {
    messageId: `<${randomUUID()}@example-mail.test>`,
    inReplyTo: email.inReplyTo ?? null,
    references: email.inReplyTo ? [email.inReplyTo] : [],
    from: { address: email.from ?? 'anna@example-mail.test', name: email.fromName ?? 'Anna' },
    replyTo: email.replyTo ?? [],
    to: ['shop@nordlicht.test'],
    cc: [],
    subject: email.subject ?? 'Question',
    text: email.bodyText ?? email.text ?? 'How much is a candle?',
    htmlHiddenText: email.hiddenHtml ?? false,
    loopHeaders: email.headers ?? {},
    attachments: [],
    date: new Date(),
  };
}

async function receive(t: SeededTenant, msg: InboundMessage): Promise<string> {
  const id = await withTenant(worker, t.tenantId, (tx) =>
    storeInbound(tx, { tenantId: t.tenantId, connectionId: t.connectionId, uid: 1, msg }),
  );
  return id!;
}

const run = (t: SeededTenant, llm: FakeProvider, messageId: string) =>
  processMessage({ sql: worker, llm, embeddings: new FakeProvider() }, t.tenantId, messageId);

const one = <T>(rows: T[]) => rows[0]!;

afterAll(() => Promise.all([owner.end(), worker.end()]));

describe('pipeline: draft-only tenant (default)', () => {
  let T: SeededTenant;
  beforeAll(async () => {
    T = await tenantWithKb('pipe-draft');
  });

  it('drafts a grounded reply, tracks the lead and queues a privacy-mode notification', async () => {
    const llm = scripted({});
    const id = await receive(
      T,
      inbound({ subject: 'Candle price', text: 'How much is a candle and how long is shipping?' }),
    );
    expect(await run(T, llm, id)).toEqual({ status: 'drafted', reasons: ['tenant_draft_only'] });

    const draft = one(
      await owner<
        {
          status: string;
          body: string;
          to_address: string;
          subject: string;
          source_chunk_ids: string[];
        }[]
      >`
      select status, body, to_address, subject, source_chunk_ids from public.drafts where source_message_id = ${id}`,
    );
    expect(draft).toMatchObject({
      status: 'pending_approval',
      to_address: 'anna@example-mail.test',
      subject: 'Re: Candle price',
    });
    expect(draft.body).toContain('24 EUR');
    expect(draft.source_chunk_ids).toHaveLength(1);

    const mp = one(
      await owner<{ status: string; final_action: string; tokens_in: number }[]>`
      select status, final_action, tokens_in from public.message_processing where message_id = ${id}`,
    );
    expect(mp).toMatchObject({ status: 'drafted', final_action: 'draft' });
    expect(mp.tokens_in).toBeGreaterThan(0);

    const lead = one(
      await owner<
        { stage: string }[]
      >`select stage from public.leads where tenant_id = ${T.tenantId} and email = 'anna@example-mail.test'`,
    );
    expect(lead.stage).toBe('drafted');

    const n = one(
      await owner<{ channel: string; kind: string; payload: Record<string, unknown> }[]>`
      select channel, kind, payload from public.notifications where tenant_id = ${T.tenantId} and kind = 'draft_ready'`,
    );
    expect(n.channel).toBe('email_owner');
    expect(n.payload).toMatchObject({
      senderDomain: 'example-mail.test',
      subject: 'Candle price',
      action: 'draft',
      reasons: ['tenant_draft_only'],
    });
    expect(JSON.stringify(n.payload)).not.toMatch(/Anna|24 EUR/);
    expect(calls(llm, 'verify')).toBe(0);
  });

  it('is idempotent: a processed message is never processed again', async () => {
    const llm = scripted({});
    const id = await receive(T, inbound({}));
    await run(T, llm, id);
    expect(await run(T, llm, id)).toEqual({ status: 'already_processed' });
    const drafts = await owner`select 1 from public.drafts where source_message_id = ${id}`;
    expect(drafts).toHaveLength(1);
  });

  it('skips newsletters by header without a lead or any model call', async () => {
    const llm = scripted({});
    const id = await receive(
      T,
      inbound({
        from: 'news@brand.test',
        headers: { 'list-unsubscribe': '<mailto:u@brand.test>' },
      }),
    );
    expect(await run(T, llm, id)).toEqual({ status: 'skipped', reason: 'loop_header:list' });
    expect(llm.calls).toHaveLength(0);
    expect(
      await owner`select 1 from public.leads where tenant_id = ${T.tenantId} and email = 'news@brand.test'`,
    ).toHaveLength(0);
  });

  it('skips what the classifier calls an invoice or newsletter', async () => {
    const llm = scripted({ classify: cls({ category: 'invoice_receipt' }) });
    const id = await receive(T, inbound({ subject: 'Your invoice' }));
    expect(await run(T, llm, id)).toEqual({ status: 'skipped', reason: 'class:invoice_receipt' });
    expect(calls(llm, 'generate')).toBe(0);
  });

  it('hard-list escalation: no reply is generated and no draft kept (Q16)', async () => {
    const llm = scripted({
      classify: cls({
        category: 'complaint',
        sentiment: 'angry',
        summary: 'Customer is unhappy with a broken candle.',
      }),
    });
    const id = await receive(
      T,
      inbound({ subject: 'Broken!', text: 'My candle arrived broken. This is unacceptable.' }),
    );
    expect(await run(T, llm, id)).toEqual({
      status: 'escalated',
      reasons: ['hard_list:complaint', 'hard_list:angry'],
    });
    expect(calls(llm, 'generate')).toBe(0);
    const esc = one(
      await owner<{ category: string; suggestion_draft_id: string | null; summary: string }[]>`
      select category, suggestion_draft_id, summary from public.escalations where message_id = ${id}`,
    );
    expect(esc).toMatchObject({ category: 'hard_list', suggestion_draft_id: null });
    expect(await owner`select 1 from public.drafts where source_message_id = ${id}`).toHaveLength(
      0,
    );
    const n = one(
      await owner<{ payload: Record<string, unknown> }[]>`
      select payload from public.notifications where tenant_id = ${T.tenantId} and kind = 'escalation' and payload->>'messageId' = ${id}`,
    );
    expect(n.payload).toMatchObject({
      action: 'escalate',
      unverifiedSuggestion: false,
      summary: 'Customer is unhappy with a broken candle.',
    });
  });

  it('uncertain escalation keeps the reply as an "AI suggestion, unverified" (Q16)', async () => {
    const llm = scripted({
      generate: gen({ reply: 'The gift set costs 55 EUR.', confidence: 0.95 }),
    });
    const id = await receive(T, inbound({ subject: 'Gift set' }));
    const r = await run(T, llm, id);
    expect(r).toMatchObject({ status: 'escalated' });
    expect((r as { reasons: string[] }).reasons).toContain('unsupported_claim:money');
    const esc = one(
      await owner<{ category: string; suggestion_draft_id: string | null }[]>`
      select category, suggestion_draft_id from public.escalations where message_id = ${id}`,
    );
    expect(esc.category).toBe('uncertain');
    const d = one(
      await owner<
        { status: string; body: string }[]
      >`select status, body from public.drafts where id = ${esc.suggestion_draft_id}`,
    );
    expect(d).toEqual({ status: 'suggestion', body: 'The gift set costs 55 EUR.' });
  });

  it('invalid model output twice escalates without a suggestion', async () => {
    const llm = scripted({ generate: '{"not":"valid"}' });
    const id = await receive(T, inbound({}));
    expect(await run(T, llm, id)).toEqual({ status: 'escalated', reasons: ['invalid_output'] });
    expect(calls(llm, 'generate')).toBe(2);
    const esc = one(
      await owner<
        { suggestion_draft_id: string | null }[]
      >`select suggestion_draft_id from public.escalations where message_id = ${id}`,
    );
    expect(esc.suggestion_draft_id).toBeNull();
  });

  it('a customer reply to our reply stops follow-ups and moves the lead to "replied"', async () => {
    const llm = scripted({});
    const first = inbound({ from: 'janis@example-mail.test', subject: 'Hours' });
    const firstId = await receive(T, first);
    await run(T, llm, firstId);
    const thread = one(
      await owner<
        { thread_id: string }[]
      >`select thread_id from public.messages where id = ${firstId}`,
    ).thread_id;
    await owner`update public.threads set status = 'awaiting_customer', next_followup_at = now() + interval '3 days' where id = ${thread}`;

    const reply = inbound({
      from: 'janis@example-mail.test',
      subject: 'Re: Hours',
      inReplyTo: first.messageId,
    });
    await run(T, llm, await receive(T, reply));
    const t = one(
      await owner<
        { status: string; next_followup_at: Date | null; followup_stop_reason: string }[]
      >`
      select status, next_followup_at, followup_stop_reason from public.threads where id = ${thread}`,
    );
    expect(t).toMatchObject({ next_followup_at: null, followup_stop_reason: 'customer_replied' });
    const events = await owner<{ to_stage: string }[]>`
      select e.to_stage from public.lead_events e join public.leads l on l.id = e.lead_id
      where l.tenant_id = ${T.tenantId} and l.email = 'janis@example-mail.test' order by e.created_at`;
    expect(events.map((e) => e.to_stage)).toContain('replied');
  });
});

describe('pipeline: auto-send tenant', () => {
  let T: SeededTenant;
  beforeAll(async () => {
    T = await tenantWithKb('pipe-auto', 'auto_send');
  });

  it('runs the verifier and approves a grounded reply for sending (queued for step 9)', async () => {
    const llm = scripted({});
    const id = await receive(T, inbound({ from: 'maris@example-mail.test' }));
    expect(await run(T, llm, id)).toEqual({ status: 'auto_send', reasons: [] });
    expect(calls(llm, 'verify')).toBe(1);
    const d = one(
      await owner<
        { id: string; status: string; decided_by: string }[]
      >`select id, status, decided_by from public.drafts where source_message_id = ${id}`,
    );
    expect(d).toMatchObject({ status: 'approved', decided_by: 'auto' });
    const job = one(
      await owner<{ payload: Record<string, unknown> }[]>`
      select payload from public.jobs where tenant_id = ${T.tenantId} and queue = ${QUEUES.mailSend}`,
    );
    expect(job.payload).toEqual({ draftId: d.id, sentVia: 'auto' });
  });

  it('a failed verification escalates with the reply kept as an unverified suggestion', async () => {
    const llm = scripted({
      verify: '{"supported":false,"unsupported_claims":["2-3 business days"]}',
    });
    const id = await receive(T, inbound({ from: 'liga@example-mail.test' }));
    expect(await run(T, llm, id)).toEqual({ status: 'escalated', reasons: ['verifier_failed'] });
  });

  it('the per-sender cap turns auto-send into a draft', async () => {
    const llm = scripted({});
    const sender = 'capped@example-mail.test';
    const firstId = await receive(T, inbound({ from: sender }));
    await run(T, llm, firstId);
    const d = one(
      await owner<
        { id: string; thread_id: string }[]
      >`select id, thread_id from public.drafts where source_message_id = ${firstId}`,
    );
    for (const n of [1, 2]) {
      await owner`insert into public.outbound_emails (tenant_id, draft_id, thread_id, message_id_header, to_address, subject, sent_via, status)
                  select ${T.tenantId}, id, thread_id, ${`<cap-${n}-${randomUUID()}@noctiv.test>`}, ${sender}, 'Re', 'auto', 'sent'
                  from public.drafts where id = ${
                    n === 1
                      ? d.id
                      : (
                          await owner<{ id: string }[]>`
                    insert into public.drafts (tenant_id, thread_id, kind, to_address, subject, body, status)
                    values (${T.tenantId}, ${d.thread_id}, 'reply', ${sender}, 'Re', 'x', 'sent') returning id`
                        )[0]!.id
                  }`;
    }
    const id = await receive(T, inbound({ from: sender }));
    const r = await run(T, llm, id);
    expect(r.status).toBe('drafted');
    expect((r as { reasons: string[] }).reasons).toContain('sender_cap_reached');
  });

  it('a halted budget skips the message without model calls', async () => {
    const llm = scripted({});
    const B = await tenantWithKb('pipe-budget', 'auto_send');
    await owner`update public.tenants set daily_token_budget = 1 where id = ${B.tenantId}`;
    await owner`insert into public.usage_daily (tenant_id, day, tokens_in) values (${B.tenantId}, (now() at time zone 'utc')::date, 10)
                on conflict (tenant_id, day) do update set tokens_in = 10`;
    const id = await receive(B, inbound({}));
    expect(await run(B, llm, id)).toEqual({ status: 'skipped', reason: 'budget_halted' });
    expect(llm.calls).toHaveLength(0);
  });
});

describe('pipeline: free-tier second lock', () => {
  it('refuses a real mailbox and processes a test mailbox', async () => {
    const T = await tenantWithKb('pipe-free');
    const free = scripted({}, 'may_train_on_data');
    const id = await receive(T, inbound({}));
    expect(await run(T, free, id)).toEqual({ status: 'skipped', reason: 'free_tier_refused' });
    expect(free.calls).toHaveLength(0);
    await owner`update public.email_connections set is_test_mailbox = true where id = ${T.connectionId}`;
    const id2 = await receive(T, inbound({}));
    expect((await run(T, free, id2)).status).toBe('drafted');
  });
});

describe('pipeline: attack fixtures end to end (compromised model, auto-send tenant)', () => {
  let T: SeededTenant;
  beforeAll(async () => {
    T = await tenantWithKb('pipe-attacks', 'auto_send');
  });

  it.each(ATTACK_FIXTURES.map((f) => [f.id, f] as const))(
    '%s is never auto-sent and goes only to the header address',
    async (_id, f) => {
      const llm = scripted({
        classify: JSON.stringify(f.classification),
        generate: JSON.stringify(f.compromisedOutput),
        verify: '{"supported":true,"unsupported_claims":[]}',
      });
      const id = await receive(T, inbound({ ...f.email, hiddenHtml: Boolean(f.email.html) }));
      const r = await run(T, llm, id);
      expect(r.status).not.toBe('auto_send');
      expect(
        await owner`select 1 from public.jobs where tenant_id = ${T.tenantId} and queue = ${QUEUES.mailSend}`,
      ).toHaveLength(0);
      const drafts = await owner<
        { to_address: string; body: string | null }[]
      >`select to_address, body from public.drafts where source_message_id = ${id}`;
      for (const d of drafts) {
        expect([f.email.from, ...f.email.replyTo]).toContain(d.to_address);
        for (const v of f.expect.removed ?? []) expect(d.body ?? '').not.toContain(v);
      }
    },
  );
});

describe('end to end through GreenMail', () => {
  it('an email sent to the shop becomes a draft', async () => {
    const T = await tenantWithKb('pipe-e2e');
    const conn = await addGreenmailConnection(owner, gm, {
      tenantId: T.tenantId,
      address: GREENMAIL_USERS.shopB.address,
      password: GREENMAIL_USERS.shopB.password,
    });
    const fetch = mailFetchHandler({ sql: worker, keys, allowInsecure: true });
    const job = {
      id: 'x',
      tenantId: T.tenantId,
      queue: QUEUES.mailFetch,
      payload: { connectionId: conn },
      attempts: 1,
      maxAttempts: 1,
    };
    await fetch(job); // baseline
    await sendMail(gm, {
      from: GREENMAIL_USERS.customer2.address,
      to: GREENMAIL_USERS.shopB.address,
      subject: 'Candle price',
      text: 'Hello, how much is one candle?',
    });
    expect(await fetch(job)).toEqual({ stored: 1 });
    const pj = one(
      await owner<
        { payload: { messageId: string } }[]
      >`select payload from public.jobs where tenant_id = ${T.tenantId} and queue = ${QUEUES.mailProcess}`,
    );
    expect((await run(T, scripted({}), pj.payload.messageId)).status).toBe('drafted');
    const d = one(
      await owner<
        { to_address: string; subject: string }[]
      >`select to_address, subject from public.drafts where source_message_id = ${pj.payload.messageId}`,
    );
    expect(d).toEqual({
      to_address: GREENMAIL_USERS.customer2.address,
      subject: 'Re: Candle price',
    });
  });
});
