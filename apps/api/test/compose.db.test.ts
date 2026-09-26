import { randomUUID } from 'node:crypto';
import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { createDocument, issueDocument, loadDocument, writeDocumentData } from '@noctiv/documents';
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
    rateLimits: false,
  });
  A = await seedTenant(owner, 'compose-a', { embeddingAxis: 210 });
  B = await seedTenant(owner, 'compose-b', { embeddingAxis: 211 });
  await owner`update public.tenants
              set documents_enabled = true, seller_legal_name = 'SIA Nordlicht',
                  seller_legal_address = 'Rīga', seller_vat_no = 'LV40003123456',
                  seller_iban = 'LV80BANK0000435195001'
              where id in (${A.tenantId}, ${B.tenantId})`;
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

async function call(method: 'GET' | 'POST', s: SeededTenant, path: string, body?: unknown) {
  const res = await app.inject({
    method,
    url: `/v1/tenants/${s.tenantId}${path}`,
    headers: { authorization: `Bearer ${await auth.token(s.userId)}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : undefined };
}

/** A ready (issued) invoice without a conversation. */
async function readyInvoice(t: SeededTenant) {
  return withTenant(owner, t.tenantId, async (tx) => {
    const id = await createDocument(tx, { tenantId: t.tenantId, type: 'invoice' });
    const d = (await loadDocument(tx, { id }))!;
    await writeDocumentData(tx, d, {
      ...d.data,
      buyer: { name: 'SIA Ozols', address: 'Rīga', regNo: '', vatNo: '', email: '' },
      lines: [{ name: 'Lavender candle', unit: 'pcs', qty: 2, unitPriceCents: 2400 }],
    } as never);
    const r = await issueDocument(tx, (await loadDocument(tx, { id }))!, {});
    if (!r.ok) throw new Error(r.problems.join('; '));
    return id;
  });
}

describe('new e-mail', () => {
  it('lists the sending mailbox and the ready documents', async () => {
    const id = await readyInvoice(A);
    const r = await call('GET', A, '/compose');
    expect(r.status).toBe(200);
    expect(r.json.from.address).toMatch(/@/);
    expect(r.json.documents.map((d: { id: string }) => d.id)).toContain(id);
    expect(r.json.documents.every((d: { status: string }) => d.status === 'issued')).toBe(true);
  });

  it('starts a new conversation and lead, queues the send, links the documents', async () => {
    const docId = await readyInvoice(A);
    const to = `new-${randomUUID()}@example.test`;
    const r = await call('POST', A, '/compose', {
      to: to.toUpperCase(),
      subject: 'Your order',
      body: 'Hello, the invoice is attached.',
      documentIds: [docId],
    });
    expect(r.status).toBe(200);
    const { threadId, draftId } = r.json;
    const [th] = await owner<{ lead_id: string; subject: string }[]>`
      select lead_id, subject from public.threads where id = ${threadId}`;
    expect(th!.subject).toBe('Your order');
    const [lead] = await owner<{ email: string; stage: string }[]>`
      select email, stage from public.leads where id = ${th!.lead_id}`;
    expect(lead).toMatchObject({ email: to, stage: 'received' });
    const [dr] = await owner<
      { kind: string; status: string; to_address: string; decided_by: string }[]
    >`
      select kind, status, to_address, decided_by from public.drafts where id = ${draftId}`;
    expect(dr).toMatchObject({
      kind: 'compose',
      status: 'approved',
      to_address: to,
      decided_by: 'owner',
    });
    const [job] = await owner<{ payload: Record<string, unknown> }[]>`
      select payload from public.jobs where queue = 'mail.send' and payload->>'draftId' = ${draftId}`;
    expect(job!.payload).toEqual({ draftId, sentVia: 'owner_approval' });
    const [doc] = await owner<{ draft_id: string; thread_id: string; lead_id: string }[]>`
      select draft_id, thread_id, lead_id from public.documents where id = ${docId}`;
    expect(doc).toEqual({ draft_id: draftId, thread_id: threadId, lead_id: th!.lead_id });

    // The same address again: a new conversation, the same lead; the document is already on its way.
    const again = await call('POST', A, '/compose', {
      to,
      subject: 'Another',
      body: 'Hi',
      documentIds: [docId],
    });
    expect(again.status).toBe(409);
    const plain = await call('POST', A, '/compose', { to, subject: 'Another', body: 'Hi' });
    expect(plain.status).toBe(200);
    const [th2] = await owner<{ lead_id: string }[]>`
      select lead_id from public.threads where id = ${plain.json.threadId}`;
    expect(th2!.lead_id).toBe(th!.lead_id);
  });

  it('refuses drafts, other tenants’ documents, bad addresses and the own mailbox', async () => {
    const draftDoc = await withTenant(owner, A.tenantId, (tx) =>
      createDocument(tx, { tenantId: A.tenantId, type: 'invoice' }),
    );
    const base = { to: 'x@example.test', subject: 'S', body: 'B' };
    expect((await call('POST', A, '/compose', { ...base, documentIds: [draftDoc] })).status).toBe(
      409,
    );
    const other = await readyInvoice(B);
    expect((await call('POST', A, '/compose', { ...base, documentIds: [other] })).status).toBe(404);
    expect((await call('POST', A, '/compose', { ...base, to: 'not-an-address' })).status).toBe(400);
    const [conn] = await owner<{ email_address: string }[]>`
      select email_address from public.email_connections where tenant_id = ${A.tenantId} limit 1`;
    expect((await call('POST', A, '/compose', { ...base, to: conn!.email_address })).status).toBe(
      400,
    );
    expect((await call('POST', A, '/compose', base)).status).toBe(200);
    expect(
      (await call('GET', B, '/compose')).json.documents.map((d: { id: string }) => d.id),
    ).not.toContain(draftDoc);
  });

  it('Write with AI: waits for the worker and returns its draft or a plain error', async () => {
    // Stand-in for the worker: completes the job with a result.
    const finish = async (result: unknown) => {
      for (let i = 0; i < 100; i++) {
        const done = await owner`
          update public.jobs set status = 'done', result = ${owner.json(result as never)}
          where tenant_id = ${A.tenantId} and queue = 'compose.assist' and status = 'queued'
          returning id`;
        if (done.length) return;
        await new Promise((r) => setTimeout(r, 50));
      }
    };
    const ok = { ok: true, subject: 'Hello', body: 'Text', sources: [], unsupportedNumbers: [] };
    const [r] = await Promise.all([
      call('POST', A, '/compose/assist', { notes: 'Tell them the candles are back' }),
      finish(ok),
    ]);
    expect(r).toEqual({ status: 200, json: ok });
    const [e] = await Promise.all([
      call('POST', A, '/compose/assist', { notes: 'Tell them the candles are back' }),
      finish({ ok: false, error: 'free_tier_refused' }),
    ]);
    expect(e.status).toBe(422);
    expect(e.json.error).toContain('paid AI provider');
  });
});
