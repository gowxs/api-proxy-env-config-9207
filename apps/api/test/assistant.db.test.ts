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
});
