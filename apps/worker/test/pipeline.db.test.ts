import { randomUUID } from 'node:crypto';
import { ACKNOWLEDGEMENTS, type GenerateRequest } from '@noctiv/core';
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
import { storeSent } from '../src/ingest/sent.ts';
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
  const blocks = kb.split(/\n(?=\[S\d+\](?: \(.*\))?\n)/);
  const hit = blocks.find((b) => b.includes(text));
  return /\[(S\d+)\]/.exec(hit ?? '')?.[1] ?? 'S1';
}

const calls = (p: FakeProvider, kind: Kind) => p.calls.filter((c) => kindOf(c) === kind).length;

async function tenantWithKb(
  label: string,
  mode: 'draft_only' | 'auto_send' | 'full_auto' = 'draft_only',
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

describe('pipeline: fully automatic tenant (mode 3)', () => {
  let T: SeededTenant;
  beforeAll(async () => {
    T = await tenantWithKb('pipe-full', 'full_auto');
  });
  const draftsOf = (messageId: string) =>
    owner<{ id: string; kind: string; status: string; decided_by: string | null; body: string }[]>`
      select id, kind, status, decided_by, body from public.drafts
      where source_message_id = ${messageId} order by kind`;

  it('sends a grounded reply on its own, like mode 2', async () => {
    const id = await receive(T, inbound({ from: 'oskars@example-mail.test' }));
    expect(await run(T, scripted({}), id)).toEqual({ status: 'auto_send', reasons: [] });
    expect((await draftsOf(id)).map((d) => d.kind)).toEqual(['reply']);
  });

  it('acknowledges what it cannot ground, in the customer language, and asks the owner', async () => {
    const llm = scripted({
      classify: cls({ language: 'de', summary: 'Kunde fragt nach Sonderanfertigung.' }),
      generate: (req) =>
        gen({
          language: 'de',
          reply: 'Hallo, das kostet 24 EUR.',
          sources: [labelOf(req, 'cost 24 EUR')],
        }),
      verify: '{"supported":false,"unsupported_claims":["Sonderanfertigung"]}',
    });
    const id = await receive(
      T,
      inbound({ from: 'jonas@example-mail.test', text: 'Machen Sie Sonderanfertigungen?' }),
    );
    expect(await run(T, llm, id)).toEqual({
      status: 'escalated',
      reasons: ['verifier_failed', 'acknowledgement_sent'],
    });
    const [ack, suggestion] = await draftsOf(id);
    expect(ack).toMatchObject({
      kind: 'acknowledgement',
      status: 'approved',
      decided_by: 'auto',
      body: ACKNOWLEDGEMENTS.de,
    });
    // The AI reply itself is never sent: it stays an unverified suggestion for the owner.
    expect(suggestion).toMatchObject({ kind: 'reply', status: 'suggestion' });
    const job = one(
      await owner<{ payload: Record<string, unknown> }[]>`
        select payload from public.jobs where tenant_id = ${T.tenantId} and queue = ${QUEUES.mailSend}
        and payload->>'draftId' = ${ack!.id}`,
    );
    expect(job.payload).toEqual({ draftId: ack!.id, sentVia: 'auto' });
    const note = one(
      await owner<{ kind: string; payload: Record<string, unknown> }[]>`
        select kind, payload from public.notifications where payload->>'messageId' = ${id}`,
    );
    expect(note.kind).toBe('escalation');
    expect(note.payload.acknowledgement).toBe(ACKNOWLEDGEMENTS.de);
  });

  it('never acknowledges hard-list cases: the owner answers those', async () => {
    const llm = scripted({ classify: cls({ category: 'refund' }) });
    const id = await receive(
      T,
      inbound({ from: 'refund@example-mail.test', text: 'I want my money back.' }),
    );
    const r = await run(T, llm, id);
    expect(r).toMatchObject({ status: 'escalated', reasons: ['hard_list:refund'] });
    expect(await draftsOf(id)).toEqual([]);
  });

  it('sends nothing automatic in a language without a fixed acknowledgement', async () => {
    // Low confidence: the reply can't be grounded, so it escalates (a supported
    // language would get the acknowledgement here).
    const llm = scripted({
      classify: cls({ language: 'ja' }),
      generate: (req) => gen({ confidence: 0.3, sources: [labelOf(req, 'cost 24 EUR')] }),
    });
    const id = await receive(T, inbound({ from: 'kenji@example-mail.test' }));
    const r = await run(T, llm, id);
    expect(r.status).toBe('escalated');
    expect((r as { reasons: string[] }).reasons).not.toContain('acknowledgement_sent');
    expect((await draftsOf(id)).map((d) => d.kind)).not.toContain('acknowledgement');
  });
});

describe('pipeline: subscription (Paddle billing)', () => {
  it('after the trial without a subscription, mail is not read by the model or answered', async () => {
    const T = await tenantWithKb('pipe-lapsed', 'auto_send');
    await owner`update public.tenants set trial_ends_at = now() - interval '1 minute' where id = ${T.tenantId}`;
    const llm = scripted({});
    const id = await receive(T, inbound({}));
    expect(await run(T, llm, id)).toEqual({ status: 'skipped', reason: 'billing_inactive' });
    expect(llm.calls).toHaveLength(0);
    const listed =
      await worker`select connection_id from app.list_mail_connections() where tenant_id = ${T.tenantId}`;
    expect(listed).toHaveLength(0);
  });

  it('a subscribed tenant is served; mail from while it was paused is only drafted', async () => {
    const T = await tenantWithKb('pipe-resumed', 'auto_send');
    await owner`update public.tenants set trial_ends_at = now() - interval '20 days', billing_status = 'active',
                billing_resumed_at = now() - interval '5 minutes' where id = ${T.tenantId}`;
    const listed =
      await worker`select connection_id from app.list_mail_connections() where tenant_id = ${T.tenantId}`;
    expect(listed).toHaveLength(1);

    const old = await receive(T, { ...inbound({}), date: new Date(Date.now() - 3 * 3_600_000) });
    expect(await run(T, scripted({}), old)).toEqual({
      status: 'drafted',
      reasons: ['arrived_while_paused'],
    });
    const fresh = await receive(T, inbound({ from: 'ben@example-mail.test' }));
    expect(await run(T, scripted({}), fresh)).toMatchObject({ status: 'auto_send' });
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

// Production case 2026-09-28: "how much does a business website cost and how long does it take?"
// The owner's note says €490 and 10 business days; the website says 3–7 business days, no price.
describe('pipeline: price questions and sources that disagree', () => {
  let T: SeededTenant;
  const QUESTION = 'Hi, how much does a business website cost and how long does it take?';
  const NOTE =
    'Services and prices (EUR, excl. VAT):\n- Landing page: €290\n- Business website (up to 6 pages): €490\n\n' +
    'Delivery times:\n- Landing page: 5 business days\n- Business website: 10 business days';
  const WEBSITE = [
    'Frequently asked questions › About development A landing page — 3–5 business days, a business website — 3–7 business days after we receive the content.',
    'Pricing › Business website A complete site for a small business. - 3–8 pages - Custom design - Ready in 3–7 business days',
  ];

  beforeAll(async () => {
    T = await seedTenant(owner, 'pipe-sources', { embeddingAxis: 51 });
    await owner`update public.tenants set mode = 'auto_send', name = 'WXS' where id = ${T.tenantId}`;
    const embeddings = new FakeProvider();
    const note = await withTenant(worker, T.tenantId, (tx) =>
      createNoteSource(tx, { tenantId: T.tenantId, title: 'Services and prices', text: NOTE }),
    );
    await ingestSource({ sql: worker, embeddings, fetcher: createSafeFetcher() }, T.tenantId, note);
    const site = randomUUID();
    await owner`insert into public.kb_sources (id, tenant_id, type, title, url, status, ingested_at)
      values (${site}, ${T.tenantId}, 'website', 'example.com', 'https://example.com/', 'ready', now())`;
    const vectors = await embeddings.embed(WEBSITE, 'document', 'test_fixture');
    for (const [i, content] of WEBSITE.entries()) {
      await owner`
        insert into public.kb_chunks (tenant_id, source_id, chunk_index, content, token_count, metadata, embedding, embedding_model)
        values (${T.tenantId}, ${site}, ${i}, ${content}, 40, ${owner.json({ url: 'https://example.com/en/' })},
                ${`[${vectors.vectors[i]!.join(',')}]`}, ${embeddings.model})`;
    }
  });

  const report = (id: string) =>
    owner<
      {
        downgrade_reasons: string[];
        retrieved_chunk_ids: string[];
        guard_report: {
          excerpts: { label: string; type: string; cited: boolean }[];
          claims: { kind: string; text: string; supported: boolean }[];
          price: { asked: boolean; inExcerpts: string[]; inReply: string[]; omitted: boolean };
          conflicts: {
            about: string;
            reply: string;
            preferred: { label: string; text: string } | null;
            replyUsesPreferred: boolean;
          }[];
        };
      }[]
    >`select downgrade_reasons, retrieved_chunk_ids, guard_report from public.message_processing where message_id = ${id}`.then(
      (r) => r[0]!,
    );
  const notification = (id: string) =>
    owner<{ kind: string; payload: { reasons: string[]; conflicts?: unknown[] } }[]>`
      select kind, payload from public.notifications where tenant_id = ${T.tenantId} and payload->>'messageId' = ${id}`.then(
      (r) => r[0]!,
    );

  it('the production reply (website duration, no price) is held, and the owner is told why', async () => {
    let prompt = '';
    const llm = scripted({
      classify: cls({ category: 'quote_request' }),
      generate: (req) => {
        prompt = req.parts.find((p) => p.kind === 'kb_context')!.text;
        return gen({
          reply:
            'Hello,\n\nA business website takes 3–7 business days to complete after we receive the content.',
          sources: [labelOf(req, 'About development')],
          confidence: 0.95,
          action: 'auto_send',
        });
      },
    });
    const id = await receive(T, inbound({ subject: 'Business website', text: QUESTION }));
    expect(await run(T, llm, id)).toEqual({
      status: 'drafted',
      reasons: ['price_omitted', 'contradicts_owner_note'],
    });
    expect(calls(llm, 'verify')).toBe(0);

    // The model saw the note first, labelled as the owner's note, and the website as a website.
    expect(prompt).toMatch(
      /\[S1\] \(owner note «Services and prices», updated \d{4}-\d{2}-\d{2}\)\n/,
    );
    expect(prompt).toMatch(
      /\[S\d\] \(website page https:\/\/example\.com\/, read \d{4}-\d{2}-\d{2}\)\n/,
    );

    const r = await report(id);
    expect(r.retrieved_chunk_ids.length).toBe(r.guard_report.excerpts.length);
    expect(r.guard_report.excerpts[0]).toMatchObject({ label: 'S1', type: 'note', cited: false });
    expect(r.guard_report.claims).toEqual([
      { kind: 'duration', text: '3–7 business days', supported: true },
    ]);
    expect(r.guard_report.price).toEqual({
      asked: true,
      // A price question also gets the tenant's other priced note (the seeded price list).
      inExcerpts: ['€290', '€490', '100 eur'],
      inReply: [],
      omitted: true,
    });
    expect(r.guard_report.conflicts).toEqual([
      expect.objectContaining({
        about: 'business website',
        reply: '3–7 business days',
        preferred: { label: 'S1', text: '10 business days' },
        replyUsesPreferred: false,
      }),
    ]);

    const n = await notification(id);
    expect(n.kind).toBe('draft_ready');
    expect(n.payload.reasons).toEqual(['price_omitted', 'contradicts_owner_note']);
    expect(n.payload.conflicts).toEqual([
      {
        about: 'business website',
        reply: '3–7 business days',
        replyUsesNote: false,
        sources: [
          {
            says: '10 business days',
            source: expect.stringMatching(
              /^your note "Services and prices" \(\d{4}-\d{2}-\d{2}\)$/,
            ),
            preferred: true,
          },
          {
            says: '3–7 business days',
            source: expect.stringMatching(
              /^your website example\.com\/en\/ \(read \d{4}-\d{2}-\d{2}\)$/,
            ),
            preferred: false,
          },
        ],
      },
    ]);
  });

  it('a reply with the note’s price and time still waits, flagged, while the website disagrees', async () => {
    const llm = scripted({
      classify: cls({ category: 'quote_request' }),
      generate: (req) =>
        gen({
          reply:
            'Hello,\n\nA business website (up to 6 pages) costs €490 (excl. VAT) and takes 10 business days once we have your content.',
          sources: [labelOf(req, '€490')],
          confidence: 0.95,
          action: 'auto_send',
          conflicts: [{ fact: 'business website delivery time', used: 'S1', other: ['S2'] }],
        }),
    });
    const id = await receive(
      T,
      inbound({ subject: 'Business website', text: QUESTION, from: 'ben@example-mail.test' }),
    );
    expect(await run(T, llm, id)).toEqual({ status: 'drafted', reasons: ['source_conflict'] });
    const r = await report(id);
    expect(r.guard_report.price).toMatchObject({ omitted: false, inReply: ['€490'] });
    expect(r.guard_report.conflicts.map((c) => [c.reply, c.replyUsesPreferred])).toEqual([
      ['10 business days', true],
    ]);
    const n = await notification(id);
    expect(n.payload.conflicts).toEqual([
      expect.objectContaining({ reply: '10 business days', replyUsesNote: true }),
    ]);
  });

  it('when the sources agree and the price is given, the reply goes out as before', async () => {
    const llm = scripted({
      classify: cls({ category: 'quote_request' }),
      generate: (req) =>
        gen({
          reply: 'Hello,\n\nA landing page costs €290 (excl. VAT).',
          sources: [labelOf(req, '€290')],
          confidence: 0.95,
          action: 'auto_send',
        }),
    });
    const id = await receive(
      T,
      inbound({
        subject: 'Landing page',
        text: 'How much is a landing page?',
        from: 'cara@example-mail.test',
      }),
    );
    expect(await run(T, llm, id)).toEqual({ status: 'auto_send', reasons: [] });
  });

  it('an escalation keeps what was retrieved and what the guards found', async () => {
    const llm = scripted({
      classify: cls({ category: 'quote_request' }),
      generate: () =>
        gen({
          reply: 'Hello,\n\nThanks for asking.',
          sources: [],
          confidence: 0.5,
          action: 'escalate',
          escalate_reason: 'The excerpts do not state the price.',
        }),
    });
    const id = await receive(
      T,
      inbound({ subject: 'Business website', text: QUESTION, from: 'dan@example-mail.test' }),
    );
    expect((await run(T, llm, id)).status).toBe('escalated');
    const r = await report(id);
    expect(r.retrieved_chunk_ids.length).toBeGreaterThan(0);
    expect(r.guard_report.excerpts[0]).toMatchObject({ type: 'note' });
    expect(r.guard_report.price).toMatchObject({ asked: true, omitted: true });
  });
});

describe('owner replies from their own mail client and escalations', () => {
  let T: SeededTenant;
  beforeAll(async () => {
    T = await tenantWithKb('pipe-owner-reply');
  });
  const complaint = cls({
    category: 'complaint',
    sentiment: 'angry',
    summary: 'Customer is unhappy with a broken candle.',
  });
  const at = (ms: number) => new Date(Date.now() + ms);
  const sent = (msg: InboundMessage) =>
    withTenant(worker, T.tenantId, (tx) =>
      storeSent(tx, {
        tenantId: T.tenantId,
        connectionId: T.connectionId,
        ownAddress: 'shop@nordlicht.test',
        uid: 1,
        msg: { ...msg, from: { address: 'shop@nordlicht.test', name: null } },
      }),
    );
  const thread = async (messageId: string) =>
    one(
      await owner<{ id: string; status: string }[]>`
        select th.id, th.status from public.threads th join public.messages m on m.thread_id = th.id
        where m.id = ${messageId}`,
    );
  const escalations = (threadId: string) =>
    owner<{ resolved_at: Date | null; resolved_by: string | null }[]>`
      select resolved_at, resolved_by from public.escalations where thread_id = ${threadId} order by created_at`;

  it('an owner reply resolves the open escalation and moves the thread to answered', async () => {
    const llm = scripted({ classify: complaint });
    const first = inbound({ subject: 'Broken', text: 'My candle arrived broken. Unacceptable.' });
    const id = await receive(T, first);
    expect((await run(T, llm, id)).status).toBe('escalated');
    const th = await thread(id);
    expect(th.status).toBe('escalated');
    const [open] = await owner<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, kind, to_address, subject, body, status)
      values (${T.tenantId}, ${th.id}, 'reply', 'anna@example-mail.test', 'Re: Broken', 'AI guess', 'suggestion')
      returning id`;

    const reply = {
      ...inbound({ subject: 'Re: Broken', inReplyTo: first.messageId }),
      date: at(1_000),
    };
    expect(await sent(reply)).toBe('stored');

    expect(await escalations(th.id)).toEqual([
      { resolved_at: expect.any(Date), resolved_by: 'owner_replied' },
    ]);
    expect((await thread(id)).status).toBe('awaiting_customer');
    const [d] = await owner<
      { status: string }[]
    >`select status from public.drafts where id = ${open!.id}`;
    expect(d!.status).toBe('superseded');
  });

  it('a later customer message reopens the thread and the hard list escalates again', async () => {
    const llm = scripted({ classify: complaint });
    const first = inbound({ subject: 'Broken again', text: 'This candle is broken. Refund!' });
    const id = await receive(T, first);
    await run(T, llm, id);
    const th = await thread(id);
    const reply = {
      ...inbound({ subject: 'Re: Broken again', inReplyTo: first.messageId }),
      date: at(1_000),
    };
    await sent(reply);
    expect((await thread(id)).status).toBe('awaiting_customer');

    // A normal follow-up question goes through the usual rules: the thread is reopened.
    const question = inbound({
      subject: 'Re: Broken again',
      text: 'How much is a candle?',
      inReplyTo: reply.messageId,
    });
    const qid = await receive(T, { ...question, date: at(2_000) });
    expect((await run(T, scripted({}), qid)).status).toBe('drafted');
    expect((await thread(qid)).status).toBe('customer_replied');

    // A new complaint after the owner's reply is escalated: the reply never suppresses it.
    const angry = inbound({
      subject: 'Re: Broken again',
      text: 'Still broken, I want my money back!',
      inReplyTo: reply.messageId,
    });
    const aid = await receive(T, { ...angry, date: at(3_000) });
    expect((await run(T, llm, aid)).status).toBe('escalated');
    expect((await thread(aid)).status).toBe('escalated');
    const escs = await escalations(th.id);
    expect(escs).toHaveLength(2);
    expect(escs[0]).toMatchObject({ resolved_by: 'owner_replied' });
    expect(escs[1]).toEqual({ resolved_at: null, resolved_by: null });
  });

  it('a reply synced late does not resolve an escalation raised by a newer customer message', async () => {
    const llm = scripted({ classify: complaint });
    const first = {
      ...inbound({ subject: 'Late sync', text: 'Broken candle, unacceptable.' }),
      date: at(-10_000),
    };
    const id = await receive(T, first);
    await run(T, llm, id);
    // The owner replied 8 s ago; the customer wrote back 5 s ago; Noctiv escalated that too;
    // only now is the owner's Sent mail read.
    const ownerReply = {
      ...inbound({ subject: 'Re: Late sync', inReplyTo: first.messageId }),
      date: at(-8_000),
    };
    const again = {
      ...inbound({ subject: 'Re: Late sync', text: 'Still broken!!', inReplyTo: first.messageId }),
      date: at(-5_000),
    };
    const aid = await receive(T, again);
    await run(T, llm, aid);
    await sent(ownerReply);

    const escs = await escalations((await thread(id)).id);
    expect(escs).toHaveLength(2);
    expect(escs[0]).toMatchObject({ resolved_by: 'owner_replied' });
    expect(escs[1]).toEqual({ resolved_at: null, resolved_by: null });
    expect((await thread(id)).status).toBe('escalated');
  });

  it('unrelated Sent mail changes nothing', async () => {
    const llm = scripted({ classify: complaint });
    const id = await receive(
      T,
      inbound({ subject: 'Broken 3', text: 'Broken candle, unacceptable.' }),
    );
    await run(T, llm, id);
    const th = await thread(id);
    const [dr] = await owner<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, kind, to_address, subject, body, status)
      values (${T.tenantId}, ${th.id}, 'reply', 'anna@example-mail.test', 'Re: Broken 3', 'AI guess', 'suggestion')
      returning id`;
    const noRefs = { ...inbound({ subject: 'Lunch?' }), date: at(1_000) };
    const wrongRefs = {
      ...inbound({ subject: 'Re: Broken 3', inReplyTo: '<nobody@elsewhere.test>' }),
      date: at(1_000),
    };
    expect(await sent(noRefs)).toBe('unrelated');
    expect(await sent(wrongRefs)).toBe('unrelated');

    expect(await escalations(th.id)).toEqual([{ resolved_at: null, resolved_by: null }]);
    expect((await thread(id)).status).toBe('escalated');
    const [d] = await owner<
      { status: string }[]
    >`select status from public.drafts where id = ${dr!.id}`;
    expect(d!.status).toBe('suggestion');
  });
});
