import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 4, onnotice: () => {} });
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;
let A: SeededTenant;
let B: SeededTenant;

beforeAll(async () => {
  auth = await testAuth();
  app = buildApp({
    logger: createLogger({ service: 'api-test', level: 'silent' }),
    sql: apiSql,
    checkDatabase: async () => true,
    verifyToken: createTokenVerifier({ jwks: auth.jwks }),
    credentialsPublicKey: generateSealingKeyPair().publicKey,
    connectionTestWaitMs: 1_000,
    assistantWaitMs: 300,
  });
  A = await seedTenant(owner, 'asst-api-a', { embeddingAxis: 211 });
  B = await seedTenant(owner, 'asst-api-b', { embeddingAxis: 212 });
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

async function call(method: 'GET' | 'POST', url: string, userId: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await auth.token(userId)}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : undefined };
}

/** What the worker writes (apps/worker/src/jobs/assistant-turn.ts). */
async function propose(
  t: SeededTenant,
  type: string,
  payload: object,
  requiresConfirmation = false,
) {
  const [c] = await owner<{ id: string }[]>`
    insert into public.assistant_conversations (tenant_id, user_id) values (${t.tenantId}, ${t.userId})
    returning id`;
  const [m] = await owner<{ id: string }[]>`
    insert into public.assistant_messages (tenant_id, conversation_id, role, text)
    values (${t.tenantId}, ${c!.id}, 'assistant', 'Here is the change.') returning id`;
  const [p] = await owner<{ id: string }[]>`
    insert into public.assistant_proposals (tenant_id, conversation_id, message_id, type, title, payload,
                                            requires_confirmation)
    values (${t.tenantId}, ${c!.id}, ${m!.id}, ${type}, 'Change', ${owner.json(payload as never)},
            ${requiresConfirmation}) returning id`;
  return p!.id;
}
const apply = (t: SeededTenant, id: string, body: object = {}, userId = t.userId) =>
  call('POST', `/v1/tenants/${t.tenantId}/assistant/proposals/${id}/apply`, userId, body);

describe('Noctiv Assistant: proposals are applied only when the owner confirms (PLAN.md §27)', () => {
  it('a settings card: applied through the Settings validation, logged', async () => {
    const id = await propose(A, 'settings', {
      changes: { timezone: 'Europe/Berlin', quotesVatRate: 19 },
      lines: [['Time zone', 'Europe/Riga → Europe/Berlin']],
    });
    const r = await apply(A, id);
    expect(r.status).toBe(200);
    expect(r.json.proposal.status).toBe('applied');
    const [t] = await owner<{ timezone: string; vat: number }[]>`
      select timezone, quotes_vat_rate::float8 as vat from public.tenants where id = ${A.tenantId}`;
    expect(t).toEqual({ timezone: 'Europe/Berlin', vat: 19 });
    const logs = await owner<{ action: string }[]>`
      select action from public.audit_log where tenant_id = ${A.tenantId}
        and action in ('assistant.applied', 'settings.updated') order by created_at`;
    expect(logs.map((l) => l.action)).toEqual(['settings.updated', 'assistant.applied']);
    expect((await apply(A, id)).status).toBe(409); // once only
  });

  it('anything that affects sending needs the confirmation dialog first', async () => {
    const id = await propose(
      A,
      'settings',
      { changes: { mode: 'auto_send' }, lines: [['Reply mode', 'Mode 1 → Mode 2']] },
      true,
    );
    const no = await apply(A, id);
    expect(no.status).toBe(409);
    expect(no.json.needsConfirmation).toBe(true);
    const yes = await apply(A, id, { confirmSending: true });
    expect(yes.json.proposal.status).toBe('applied');
    const [t] = await owner<
      { mode: string }[]
    >`select mode from public.tenants where id = ${A.tenantId}`;
    expect(t!.mode).toBe('auto_send');
    await owner`update public.tenants set mode = 'draft_only' where id = ${A.tenantId}`;
  });

  it('a rejected change is reported on the card, not applied', async () => {
    const id = await propose(A, 'settings', { changes: { followupMax: 9 }, lines: [] });
    const r = await apply(A, id);
    expect(r.json.proposal.status).toBe('failed');
    expect(r.json.proposal.error).toBeTruthy();
  });

  it('knowledge note and price items go through the Knowledge and Price list routes', async () => {
    const note = await propose(A, 'knowledge_note', {
      title: 'Shipping',
      text: 'Shipping costs €4.90, free from €50.',
    });
    expect((await apply(A, note)).json.proposal.status).toBe('applied');
    const src =
      await owner`select 1 from public.kb_sources where tenant_id = ${A.tenantId} and title = 'Shipping'`;
    expect(src).toHaveLength(1);
    const items = await propose(A, 'price_items', {
      items: [{ name: 'Small candle', unit: 'pcs', unitPriceCents: 1200, currency: 'EUR' }],
    });
    expect((await apply(A, items)).json.proposal.status).toBe('applied');
    const [i] = await owner<{ cents: number }[]>`
      select unit_price_cents as cents from public.price_items
      where tenant_id = ${A.tenantId} and name = 'Small candle'`;
    expect(i!.cents).toBe(1200);
  });

  it('dismiss; other businesses can neither see nor apply it', async () => {
    const id = await propose(A, 'settings', { changes: { weeklyReportEnabled: false }, lines: [] });
    expect((await apply(B, id, {}, B.userId)).status).toBe(404); // B's own route: RLS hides it
    expect(
      (
        await call(
          'POST',
          `/v1/tenants/${A.tenantId}/assistant/proposals/${id}/apply`,
          B.userId,
          {},
        )
      ).status,
    ).toBe(403);
    const d = await call(
      'POST',
      `/v1/tenants/${A.tenantId}/assistant/proposals/${id}/dismiss`,
      A.userId,
      {},
    );
    expect(d.json.proposal.status).toBe('dismissed');
    const g = await call('GET', `/v1/tenants/${A.tenantId}/assistant?purpose=app`, A.userId);
    expect(g.status).toBe(200);
    expect(g.json.messages.at(-1).proposals[0]).toMatchObject({ id, status: 'dismissed' });
    const other = await call('GET', `/v1/tenants/${B.tenantId}/assistant?purpose=app`, B.userId);
    expect(other.status).toBe(200);
    expect(JSON.stringify(other.json)).not.toContain(id);
    expect(JSON.stringify(other.json)).not.toContain('Here is the change.');
  });

  it('a slow answer: the message returns "pending" and the app fetches the answer when ready', async () => {
    const send = await call('POST', `/v1/tenants/${A.tenantId}/assistant/messages`, A.userId, {
      text: 'How did last week go?',
      locale: 'en',
    });
    expect(send.status).toBe(202);
    expect(send.json).toMatchObject({ pending: true, messages: [{ role: 'owner' }] });
    const turn = `/v1/tenants/${A.tenantId}/assistant/turns/${send.json.jobId}`;
    expect((await call('GET', turn, A.userId)).status).toBe(202);
    // Another business cannot look at it.
    expect((await call('GET', turn, B.userId)).status).toBe(403);
    expect(
      (await call('GET', `/v1/tenants/${B.tenantId}/assistant/turns/${send.json.jobId}`, B.userId))
        .status,
    ).toBe(404);

    // What the worker does when it has answered (apps/worker/src/jobs/assistant-turn.ts).
    const [m] = await owner<{ id: string }[]>`
      insert into public.assistant_messages (tenant_id, conversation_id, role, text)
      values (${A.tenantId}, ${send.json.conversation.id}, 'assistant', 'Last week: 12 e-mails answered.')
      returning id`;
    await owner`update public.jobs set status = 'done', result = ${owner.json({ ok: true, messageId: m!.id })}
                where id = ${send.json.jobId}`;
    const done = await call('GET', turn, A.userId);
    expect(done.status).toBe(200);
    expect(done.json.messages).toMatchObject([
      { id: m!.id, text: 'Last week: 12 e-mails answered.' },
    ]);

    const again = await call('POST', `/v1/tenants/${A.tenantId}/assistant/messages`, A.userId, {
      text: 'And this week?',
      conversationId: send.json.conversation.id,
    });
    await owner`update public.jobs set status = 'done', result = ${owner.json({ ok: false, error: 'free_tier_refused' })}
                where id = ${again.json.jobId}`;
    const refused = await call(
      'GET',
      `/v1/tenants/${A.tenantId}/assistant/turns/${again.json.jobId}`,
      A.userId,
    );
    expect(refused.status).toBe(422);
    expect(refused.json.code).toBe('free_tier_refused');
  });

  it('document card → a Ready invoice; the e-mail card waits for it, needs the dialog, goes out via Compose; mark paid', async () => {
    await owner`update public.tenants
                set documents_enabled = true, seller_legal_name = 'Wxs SIA', seller_legal_address = 'Rīga, Latvia',
                    seller_vat_no = 'DE123456789', seller_iban = 'DE89370400440532013000',
                    quotes_vat_mode = 'exclusive', quotes_vat_rate = 21, quotes_currency = 'EUR'
                where id = ${A.tenantId}`;
    const [due] = await owner<{ d: string }[]>`select (current_date + 7)::text as d`;
    // What the worker writes for "Send gowxs an invoice for €290 for website development, due in 7 days."
    const [c] = await owner<{ id: string }[]>`
      insert into public.assistant_conversations (tenant_id, user_id) values (${A.tenantId}, ${A.userId})
      returning id`;
    const [m] = await owner<{ id: string }[]>`
      insert into public.assistant_messages (tenant_id, conversation_id, role, text)
      values (${A.tenantId}, ${c!.id}, 'assistant', 'Here are the invoice and the e-mail.') returning id`;
    const insert = async (type: string, payload: object, requiresConfirmation: boolean) =>
      (
        await owner<{ id: string }[]>`
          insert into public.assistant_proposals (tenant_id, conversation_id, message_id, type, title, payload,
                                                  requires_confirmation)
          values (${A.tenantId}, ${c!.id}, ${m!.id}, ${type}, 'Card', ${owner.json(payload as never)},
                  ${requiresConfirmation}) returning id`
      )[0]!.id;
    const docCard = await insert(
      'create_document',
      {
        docType: 'invoice',
        buyer: {
          leadId: null,
          name: 'gowxs',
          email: 'gowxs@customer.test',
          address: 'Brīvības iela 1, Rīga',
          regNo: '',
          vatNo: '',
          threadId: null,
        },
        lines: [{ name: 'Website development', unit: 'pcs', qty: 1, unitPriceCents: 29000 }],
        withPrices: true,
        dueDate: due!.d,
      },
      false,
    );
    const mailCard = await insert(
      'send_email',
      {
        to: 'gowxs@customer.test',
        name: 'gowxs',
        subject: 'Invoice for website development',
        body: 'Hello,\n\nplease find the invoice attached.\n\nKind regards',
        documentIds: [],
        attachLabels: ['The new invoice'],
        attachProposalId: docCard,
      },
      true,
    );

    // Never without the click in the dialog; and not before the invoice exists.
    expect((await apply(A, mailCard)).json.needsConfirmation).toBe(true);
    const early = await apply(A, mailCard, { confirmSending: true });
    expect(early.status).toBe(409);
    expect(early.json.error).toContain('Confirm the document card above first');

    const made = await apply(A, docCard);
    expect(made.json.proposal).toMatchObject({
      status: 'applied',
      result: { number: expect.stringMatching(/^INV-/) },
    });
    const docId = made.json.proposal.result.documentId;
    const doc = await call('GET', `/v1/tenants/${A.tenantId}/documents/${docId}`, A.userId);
    expect(doc.json).toMatchObject({
      status: 'issued',
      total_cents: 35090,
      due_date: due!.d,
      data: { buyer: { name: 'gowxs', address: 'Brīvības iela 1, Rīga' } },
    });

    const sent = await apply(A, mailCard, { confirmSending: true });
    expect(sent.json.proposal).toMatchObject({
      status: 'applied',
      result: { threadId: expect.any(String) },
    });
    const [draft] = await owner<
      { kind: string; status: string; to_address: string; docs: number }[]
    >`
      select d.kind, d.status, d.to_address,
             (select count(*)::int from public.documents x where x.draft_id = d.id) as docs
      from public.drafts d where d.id = ${sent.json.proposal.result.draftId}`;
    expect(draft).toEqual({
      kind: 'compose',
      status: 'approved',
      to_address: 'gowxs@customer.test',
      docs: 1,
    });
    const jobs = await owner`select 1 from public.jobs where queue = 'mail.send'
                             and payload->>'draftId' = ${sent.json.proposal.result.draftId}`;
    expect(jobs).toHaveLength(1);

    const paidCard = await insert(
      'mark_paid',
      { documentId: docId, number: made.json.proposal.result.number },
      false,
    );
    expect((await apply(A, paidCard)).json.proposal.status).toBe('applied');
    const [paid] = await owner<
      { status: string }[]
    >`select status from public.documents where id = ${docId}`;
    expect(paid!.status).toBe('paid');
    const logs = await owner<{ action: string }[]>`
      select action from public.audit_log where tenant_id = ${A.tenantId}
        and action in ('document.created', 'document.issued', 'email.composed', 'document.paid')
        and created_at > now() - interval '1 minute' order by created_at`;
    expect(logs.map((l) => l.action)).toEqual([
      'document.created',
      'document.issued',
      'email.composed',
      'document.paid',
    ]);
  });
});
