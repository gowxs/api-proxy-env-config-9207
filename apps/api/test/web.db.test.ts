import { randomUUID } from 'node:crypto';
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
    inviteCodes: ['EARLY-2026'],
  });
  A = await seedTenant(owner, 'web-a', { embeddingAxis: 100 });
  B = await seedTenant(owner, 'web-b', { embeddingAxis: 101 });
});
afterAll(() => Promise.all([owner.end(), apiSql.end()]));

async function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  userId: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${await auth.token(userId)}` },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  return { status: res.statusCode, json: res.body ? res.json() : undefined };
}
const t = (s: SeededTenant, path = '') => `/v1/tenants/${s.tenantId}${path}`;

describe('account and onboarding', () => {
  it('a new user creates their business with an invite code; it starts in draft-only mode', async () => {
    const userId = randomUUID();
    await owner`insert into auth.users (id, email, aud, role) values (${userId}, ${`new-${userId.slice(0, 8)}@example.test`}, 'authenticated', 'authenticated')`;
    expect((await call('GET', '/v1/me', userId)).json).toMatchObject({
      tenants: [],
      inviteRequired: true,
    });

    const body = {
      name: 'Lumen Studio',
      timezone: 'Europe/Riga',
      websiteUrl: 'https://lumen.example',
    };
    expect((await call('POST', '/v1/tenants', userId, body)).status).toBe(403);
    expect(
      (
        await call('POST', '/v1/tenants', userId, {
          ...body,
          inviteCode: 'EARLY-2026',
          timezone: 'Mars/Base',
        })
      ).status,
    ).toBe(400);
    const created = await call('POST', '/v1/tenants', userId, {
      ...body,
      inviteCode: 'EARLY-2026',
    });
    expect(created).toMatchObject({ status: 201, json: { mode: 'draft_only' } });
    expect(
      (await call('POST', '/v1/tenants', userId, { ...body, inviteCode: 'EARLY-2026' })).status,
    ).toBe(409);

    const me = (await call('GET', '/v1/me', userId)).json;
    expect(me.tenants).toEqual([
      {
        id: created.json.id,
        name: 'Lumen Studio',
        onboarding_completed_at: null,
        mailboxes: 0,
        kb_sources: 0,
      },
    ]);
    await call('PATCH', `/v1/tenants/${created.json.id}`, userId, { onboardingCompleted: true });
    expect(
      (await call('GET', '/v1/me', userId)).json.tenants[0].onboarding_completed_at,
    ).not.toBeNull();
  });

  it("members only: another tenant's data is forbidden", async () => {
    for (const path of [
      '',
      '/dashboard',
      '/conversations',
      '/leads',
      '/kb/sources',
      `/conversations/${A.threadId}`,
    ]) {
      expect((await call('GET', t(A, path), B.userId)).status).toBe(403);
    }
    expect((await call('POST', t(A, `/drafts/${A.draftId}/approve`), B.userId, {})).status).toBe(
      403,
    );
  });

  it('a thread id from another tenant is simply not found (RLS)', async () => {
    expect((await call('GET', t(A, `/conversations/${B.threadId}`), A.userId)).status).toBe(404);
    expect((await call('POST', t(A, `/drafts/${B.draftId}/reject`), A.userId, {})).status).toBe(
      404,
    );
  });
});

describe('settings', () => {
  it('auto-send needs an explicit confirmation and a connected mailbox', async () => {
    expect((await call('PATCH', t(A), A.userId, { mode: 'auto_send' })).status).toBe(400);
    const ok = await call('PATCH', t(A), A.userId, { mode: 'auto_send', confirmAutoSend: true });
    expect(ok.status).toBe(200);
    expect((await call('GET', t(A), A.userId)).json.mode).toBe('auto_send');
    const [audit] = await owner<{ metadata: { mode?: string } }[]>`
      select metadata from public.audit_log where tenant_id = ${A.tenantId} and action = 'settings.updated' order by created_at desc limit 1`;
    expect(audit!.metadata.mode).toBe('auto_send');
    // Back to draft-only needs no confirmation.
    expect((await call('PATCH', t(A), A.userId, { mode: 'draft_only' })).status).toBe(200);

    await owner`update public.email_connections set status = 'disconnected' where tenant_id = ${B.tenantId}`;
    expect(
      (await call('PATCH', t(B), B.userId, { mode: 'auto_send', confirmAutoSend: true })).status,
    ).toBe(409);
  });

  it('validates limits and ignores unknown fields', async () => {
    expect((await call('PATCH', t(A), A.userId, { followupMax: 5 })).status).toBe(400);
    expect((await call('PATCH', t(A), A.userId, { budgetState: 'ok' })).status).toBe(400);
    expect(
      (await call('PATCH', t(A), A.userId, { followupAfterDays: 4, replySignature: 'Liga' }))
        .status,
    ).toBe(200);
    expect((await call('GET', t(A), A.userId)).json).toMatchObject({
      followup_after_days: 4,
      reply_signature: 'Liga',
    });
  });
});

describe('dashboard and conversations', () => {
  it('dashboard: mailbox health, today, budget, open items', async () => {
    const d = (await call('GET', t(A, '/dashboard'), A.userId)).json;
    expect(d.connections[0]).toMatchObject({
      status: 'connected',
      email_address: 'inbox-web-a@example.test',
    });
    expect(d.today.received).toBeGreaterThanOrEqual(1);
    expect(d.open).toMatchObject({ awaiting_approval: 1, open_escalations: 1 });
    expect(d.budget).toMatchObject({ state: 'ok', dailyTokens: 200000 });
    expect(JSON.stringify(d)).not.toMatch(/ciphertext/);
  });

  it('lists threads that need action and shows one with its messages and drafts', async () => {
    const list = (await call('GET', t(A, '/conversations?filter=needs_action'), A.userId)).json;
    expect(list.map((x: { id: string }) => x.id)).toContain(A.threadId);
    const detail = (await call('GET', t(A, `/conversations/${A.threadId}`), A.userId)).json;
    expect(detail.messages.map((m: { direction: string }) => m.direction)).toEqual([
      'inbound',
      'outbound',
    ]);
    expect(detail.drafts[0]).toMatchObject({ id: A.draftId, status: 'pending_approval' });
    expect((await call('GET', t(A, `/drafts/${A.draftId}`), A.userId)).json.thread_id).toBe(
      A.threadId,
    );
  });

  it('edit + approve queues the send; a second decision is refused', async () => {
    const d = await seedDraft(A, 'pending_approval');
    expect(
      (await call('PATCH', t(A, `/drafts/${d}`), A.userId, { body: '  Edited text  ' })).status,
    ).toBe(200);
    const res = await call('POST', t(A, `/drafts/${d}/approve`), A.userId, { body: 'Final text' });
    expect(res).toMatchObject({ status: 200, json: { status: 'approved' } });
    const [row] = await owner<{ status: string; body: string; edited: boolean }[]>`
      select status, body, edited from public.drafts where id = ${d}`;
    expect(row).toEqual({ status: 'approved', body: 'Final text', edited: true });
    const jobs =
      await owner`select payload from public.jobs where queue = 'mail.send' and payload->>'draftId' = ${d}`;
    expect(jobs).toHaveLength(1);
    expect((await call('POST', t(A, `/drafts/${d}/approve`), A.userId, {})).status).toBe(409);
    expect((await call('POST', t(A, `/drafts/${d}/reject`), A.userId, {})).status).toBe(409);
  });

  it('approving an unverified suggestion also closes its escalation', async () => {
    const d = await seedDraft(A, 'suggestion');
    const [esc] = await owner<{ id: string }[]>`
      insert into public.escalations (tenant_id, message_id, thread_id, category, reason, suggestion_draft_id)
      values (${A.tenantId}, ${A.messageId}, ${A.threadId}, 'uncertain', 'low_confidence', ${d}) returning id`;
    expect((await call('POST', t(A, `/drafts/${d}/approve`), A.userId, {})).status).toBe(200);
    const [e] = await owner<
      { resolved_at: Date | null }[]
    >`select resolved_at from public.escalations where id = ${esc!.id}`;
    expect(e!.resolved_at).not.toBeNull();
  });

  it('rejects and resolves', async () => {
    const d = await seedDraft(A, 'pending_approval');
    expect((await call('POST', t(A, `/drafts/${d}/reject`), A.userId, {})).json.status).toBe(
      'rejected',
    );
    const [esc] = await owner<{ id: string }[]>`
      select id from public.escalations where tenant_id = ${A.tenantId} and resolved_at is null limit 1`;
    expect((await call('POST', t(A, `/escalations/${esc!.id}/resolve`), A.userId, {})).status).toBe(
      200,
    );
    expect((await call('POST', t(A, `/escalations/${esc!.id}/resolve`), A.userId, {})).status).toBe(
      409,
    );
  });
});

describe('leads', () => {
  it('filters by stage and records owner stage changes', async () => {
    const all = (await call('GET', t(A, '/leads'), A.userId)).json;
    expect(all.leads.length).toBeGreaterThanOrEqual(1);
    const res = await call('PATCH', t(A, `/leads/${A.leadId}`), A.userId, {
      stage: 'converted',
      notes: 'Bought 3',
    });
    expect(res.status).toBe(200);
    const converted = (await call('GET', t(A, '/leads?stage=converted'), A.userId)).json;
    expect(converted.leads).toEqual([
      expect.objectContaining({ id: A.leadId, notes: 'Bought 3', thread_id: A.threadId }),
    ]);
    const [ev] = await owner<{ actor: string; to_stage: string }[]>`
      select actor, to_stage from public.lead_events where lead_id = ${A.leadId} order by created_at desc limit 1`;
    expect(ev).toEqual({ actor: 'owner', to_stage: 'converted' });
    expect(
      (await call('PATCH', t(A, `/leads/${A.leadId}`), A.userId, { stage: 'vip' })).status,
    ).toBe(400);
  });
});

describe('knowledge base', () => {
  it('adds notes, websites and files; rejects unsafe or unsupported input', async () => {
    const note = await call('POST', t(A, '/kb/notes'), A.userId, {
      title: 'Shipping',
      text: 'We ship in 2 days.',
    });
    expect(note).toMatchObject({ status: 200, json: { status: 'pending' } });
    expect(
      (await call('POST', t(A, '/kb/website'), A.userId, { url: 'lumen.example' })).status,
    ).toBe(200);
    expect(
      (await call('POST', t(A, '/kb/website'), A.userId, { url: 'http://127.0.0.1/admin' })).status,
    ).toBe(400);
    const file = await call('POST', t(A, '/kb/files'), A.userId, {
      fileName: 'faq.txt',
      contentBase64: Buffer.from('Opening hours: 10-18').toString('base64'),
    });
    expect(file.status).toBe(200);
    const bad = await call('POST', t(A, '/kb/files'), A.userId, {
      fileName: 'x.exe',
      contentBase64: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]).toString('base64'),
    });
    expect(bad).toMatchObject({ status: 400, json: { error: expect.stringContaining('PDF') } });
    const sources = (await call('GET', t(A, '/kb/sources'), A.userId)).json;
    expect(sources.map((s: { type: string }) => s.type)).toEqual(
      expect.arrayContaining(['note', 'website', 'file']),
    );
    const jobs =
      await owner`select 1 from public.jobs where tenant_id = ${A.tenantId} and queue = 'kb.ingest'`;
    expect(jobs.length).toBeGreaterThanOrEqual(3);

    expect(
      (await call('POST', t(A, `/kb/sources/${note.json.id}/refresh`), A.userId, {})).status,
    ).toBe(200);
    expect(
      (await call('POST', t(A, `/kb/sources/${file.json.id}/refresh`), A.userId, {})).status,
    ).toBe(409);
    expect((await call('DELETE', t(A, `/kb/sources/${note.json.id}`), A.userId)).status).toBe(200);
    expect((await call('DELETE', t(A, `/kb/sources/${B.sourceId}`), A.userId)).status).toBe(404);
  });
});

async function seedDraft(s: SeededTenant, status: string): Promise<string> {
  const [d] = await owner<{ id: string }[]>`
    insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, status)
    values (${s.tenantId}, ${s.threadId}, ${s.messageId}, 'reply', 'customer@example.test', 'Re: Question', 'Draft', ${status})
    returning id`;
  return d!.id;
}
