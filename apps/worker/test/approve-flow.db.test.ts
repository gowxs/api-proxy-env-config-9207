/**
 * Step 10 end to end: customer email → draft (fake model) → owner email with
 * signed links → confirmation page → approve → mail.send → customer gets the
 * threaded reply. Everything over GreenMail; the API runs in-process.
 */
import { createLogger, type GenerateRequest } from '@noctiv/core';
import { withTenant, type Job } from '@noctiv/db';
import { GREENMAIL_USERS, seedTenant } from '@noctiv/db/testing';
import { createNoteSource, createSafeFetcher, ingestSource } from '@noctiv/kb';
import { FakeProvider } from '@noctiv/llm';
import { parseInbound } from '@noctiv/mail';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../../api/src/app.ts';
import { KB_CHUNKS } from '../../../packages/core/test/fixtures/kb.ts';
import { mailFetchHandler } from '../src/jobs/mail-fetch.ts';
import { mailSendHandler } from '../src/jobs/mail-send.ts';
import { deliverNotifications } from '../src/notify/delivery.ts';
import { createSystemTransport, EmailChannel } from '../src/notify/email-channel.ts';
import { processMessage } from '../src/pipeline/process.ts';
import { QUEUES } from '../src/queues.ts';
import { addGreenmailConnection, header, keys, readFolder, sendMail } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 6, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
const U = GREENMAIL_USERS;
const SECRET = 'approve-flow-secret-0123456789abcdef';
const API = 'https://api.noctiv.test';

const app = buildApp({
  logger: createLogger({ service: 'api-test', level: 'silent' }),
  sql: apiSql,
  checkDatabase: async () => true,
  verifyToken: async () => {
    throw new Error('not used');
  },
  credentialsPublicKey: keys.publicKey,
  connectionTestWaitMs: 1_000,
  actionSecret: SECRET,
  appUrl: 'https://app.noctiv.test',
});
const channel = new EmailChannel({
  transport: createSystemTransport({
    host: gm.host,
    port: gm.smtpPort,
    security: 'none',
    user: U.system.address,
    pass: U.system.password,
    from: `Noctiv <${U.system.address}>`,
  }),
  from: `Noctiv <${U.system.address}>`,
});
const deliver = () =>
  deliverNotifications({
    sql: worker,
    routes: { email_owner: { channel, audience: 'owner' } },
    links: { apiUrl: API, appUrl: 'https://app.noctiv.test', actionSecret: SECRET },
  });
const send = mailSendHandler({ sql: worker, keys, allowInsecure: true });

const fake = new FakeProvider({
  responder: (req: GenerateRequest) => {
    if (req.system.startsWith('You classify')) {
      return JSON.stringify({
        category: 'product_question',
        sentiment: 'neutral',
        urgency: 'normal',
        language: 'en',
        summary: 'Customer asks what one candle costs.',
      });
    }
    if (req.system.startsWith('You check a draft'))
      return '{"supported":true,"unsupported_claims":[]}';
    const kb = req.parts.find((p) => p.kind === 'kb_context')?.text ?? '';
    const label =
      /\[(S\d+)\]/.exec(
        kb.split(/\n(?=\[S\d+\]\n)/).find((b) => b.includes('cost 24 EUR')) ?? '',
      )?.[1] ?? 'S1';
    return JSON.stringify({
      intent: 'price',
      language: 'en',
      reply: 'Hello, one candle costs 24 EUR.',
      sources: [label],
      confidence: 0.95,
      action: 'auto_send',
      escalate_reason: null,
    });
  },
});

let tenantId: string;
let connectionId: string;

beforeAll(async () => {
  const t = await seedTenant(owner, 'approve-flow', { embeddingAxis: 90 });
  tenantId = t.tenantId;
  await owner`update auth.users set email = ${U.customer.address} where id = ${t.userId}`;
  await owner`update public.tenants set name = 'Lumen Studio', reply_signature = 'Lumen Studio team' where id = ${tenantId}`;
  for (const c of KB_CHUNKS) {
    const id = await withTenant(worker, tenantId, (tx) =>
      createNoteSource(tx, { tenantId, title: 'kb', text: c.content }),
    );
    await ingestSource(
      { sql: worker, embeddings: new FakeProvider(), fetcher: createSafeFetcher() },
      tenantId,
      id,
    );
  }
  connectionId = await addGreenmailConnection(owner, gm, {
    tenantId,
    address: U.sendShop.address,
    password: U.sendShop.password,
    displayName: 'Lumen Studio',
  });
});
afterAll(() => Promise.all([owner.end(), worker.end(), apiSql.end()]));

/** Customer email → stored → processed; returns the new draft id. */
async function customerAsks(subject: string, messageId: string): Promise<string> {
  const fetch = mailFetchHandler({ sql: worker, keys, allowInsecure: true });
  const fetchJob: Job = {
    id: 'f',
    tenantId,
    queue: QUEUES.mailFetch,
    payload: { connectionId },
    attempts: 1,
    maxAttempts: 1,
  };
  await fetch(fetchJob); // baseline (first run) or no-op
  await sendMail(gm, {
    from: U.sendCustomer.address,
    to: U.sendShop.address,
    subject,
    text: 'Hello, how much is one candle?',
    messageId,
  });
  expect(await fetch(fetchJob)).toEqual({ stored: 1 });
  const [m] = await owner<{ id: string }[]>`
    select id from public.messages where tenant_id = ${tenantId} and message_id_header = ${messageId}`;
  const outcome = await processMessage(
    { sql: worker, llm: fake, embeddings: fake },
    tenantId,
    m!.id,
  );
  expect(outcome.status).toBe('drafted'); // new tenants are draft-only
  const [d] = await owner<
    { id: string }[]
  >`select id from public.drafts where source_message_id = ${m!.id}`;
  return d!.id;
}

/** The owner's notification email for a draft, with its action paths. */
async function ownerEmailFor(draftId: string) {
  await deliver();
  const [n] = await owner<{ id: string; status: string }[]>`
    select id, status from public.notifications where tenant_id = ${tenantId} and kind = 'draft_ready'
      and payload->>'draftId' = ${draftId}`;
  expect(n!.status).toBe('sent');
  const mail = (await readFolder(gm, U.customer)).find(
    (m) => header(m.raw, 'Message-ID') === `<notify.${n!.id}@noctiv.test>`,
  );
  const text = (await parseInbound(Buffer.from(mail!.raw))).text;
  const path = (label: string) =>
    new RegExp(`${label}: ${API.replace(/\./g, '\\.')}(/actions/\\S+)`).exec(text)?.[1];
  return { text, approve: path('Approve and send')!, reject: path('Reject')! };
}

const draft = async (id: string) =>
  (
    await owner<{ status: string; decided_by: string | null }[]>`
    select status, decided_by from public.drafts where id = ${id}`
  )[0]!;
const sendJobs = (draftId: string) =>
  owner<{ id: string; payload: { draftId: string; sentVia: string } }[]>`
    select id, payload from public.jobs where tenant_id = ${tenantId} and queue = ${QUEUES.mailSend}
      and payload->>'draftId' = ${draftId}`;

describe('approve by email link, end to end', () => {
  it('customer email → owner email → confirm → approve → threaded reply to the customer', async () => {
    const draftId = await customerAsks('Candle price?', '<ask-1@example-mail.test>');
    const mail = await ownerEmailFor(draftId);
    expect(mail.text).toContain('Customer asks what one candle costs.');
    expect(mail.text).not.toContain('24 EUR'); // privacy mode: no draft body in email

    // Opening the link (or a mail scanner pre-fetching it) changes nothing.
    for (let i = 0; i < 2; i++) {
      const page = await app.inject({ method: 'GET', url: mail.approve });
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('<form method="post">');
      expect(page.body).toContain('Approve and send');
    }
    expect((await draft(draftId)).status).toBe('pending_approval');
    expect(await sendJobs(draftId)).toHaveLength(0);

    const approved = await app.inject({
      method: 'POST',
      url: mail.approve,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.body).toContain('Approved');
    expect(await draft(draftId)).toEqual({ status: 'approved', decided_by: 'owner:email_link' });

    // Approving twice, or rejecting afterwards, is harmless.
    const again = await app.inject({ method: 'POST', url: mail.approve });
    expect(again.body).toContain('Already decided');
    const late = await app.inject({ method: 'POST', url: mail.reject });
    expect(late.body).toContain('Already decided');
    const jobs = await sendJobs(draftId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ draftId, sentVia: 'owner_approval' });

    const job: Job = {
      id: jobs[0]!.id,
      tenantId,
      queue: QUEUES.mailSend,
      payload: jobs[0]!.payload,
      attempts: 1,
      maxAttempts: 5,
    };
    expect(await send(job)).toEqual({ status: 'sent' });
    const reply = (await readFolder(gm, U.sendCustomer)).find(
      (m) => header(m.raw, 'In-Reply-To') === '<ask-1@example-mail.test>',
    );
    expect(reply).toBeDefined();
    expect(header(reply!.raw, 'Subject')).toBe('Re: Candle price?');
    expect(header(reply!.raw, 'Auto-Submitted')).toBeNull(); // owner-approved
    expect(reply!.raw).toContain('one candle costs 24 EUR');
    expect(reply!.raw).toContain('Lumen Studio team');
    expect((await draft(draftId)).status).toBe('sent');

    const after = await app.inject({ method: 'GET', url: mail.approve });
    expect(after.body).toContain('already approved and sent');

    const audit = await owner<{ action: string; actor: string }[]>`
      select action, actor from public.audit_log where tenant_id = ${tenantId} and target_id = ${draftId} order by created_at`;
    expect(audit).toEqual([
      { action: 'draft.approved', actor: 'owner' },
      { action: 'email.sent', actor: 'system' },
    ]);
  });

  it('reject: nothing is sent and the approve link then reports the decision', async () => {
    const draftId = await customerAsks('Another question', '<ask-2@example-mail.test>');
    const mail = await ownerEmailFor(draftId);
    const confirm = await app.inject({ method: 'GET', url: mail.reject });
    expect(confirm.body).toContain('Reject draft');
    const rejected = await app.inject({ method: 'POST', url: mail.reject });
    expect(rejected.body).toContain('Rejected');
    expect((await draft(draftId)).status).toBe('rejected');
    expect(await sendJobs(draftId)).toHaveLength(0);
    const approve = await app.inject({ method: 'POST', url: mail.approve });
    expect(approve.body).toContain('already rejected');
    expect((await draft(draftId)).status).toBe('rejected');
  });

  it("a link can only reach its own tenant's draft", async () => {
    const other = await seedTenant(owner, 'approve-other', { embeddingAxis: 91 });
    await owner`update public.drafts set status = 'pending_approval' where id = ${other.draftId}`;
    const { signActionToken } = await import('@noctiv/core');
    // Signed for our tenant but naming the other tenant's draft: RLS hides it.
    const token = signActionToken({ tenantId, draftId: other.draftId, action: 'approve' }, SECRET);
    const res = await app.inject({ method: 'POST', url: `/actions/${token}` });
    expect(res.statusCode).toBe(404);
    expect((await draft(other.draftId)).status).toBe('pending_approval');
  });
});
