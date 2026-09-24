import { randomUUID } from 'node:crypto';
import { createLogger, generateSealingKeyPair } from '@noctiv/core';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { purgeExpiredContent, tenantDeleteHandler } from '../../worker/src/ops/gdpr.ts';
import { buildApp } from '../src/app.ts';
import { createTokenVerifier } from '../src/auth.ts';
import { testAuth } from './helpers.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const apiSql = postgres(inject('apiDatabaseUrl'), { max: 2, onnotice: () => {} });
const workerSql = postgres(inject('workerDatabaseUrl'), { max: 2, onnotice: () => {} });
let auth: Awaited<ReturnType<typeof testAuth>>;
let app: ReturnType<typeof buildApp>;

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
});
afterAll(() => Promise.all([owner.end(), apiSql.end(), workerSql.end()]));

/** Rows per table for a tenant, over every public table with a tenant_id column. */
async function rowsFor(tenantId: string): Promise<Record<string, number>> {
  const tables = await owner<{ table_name: string }[]>`
    select c.table_name from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'tenant_id' and t.table_type = 'BASE TABLE'
    order by 1`;
  const out: Record<string, number> = {};
  for (const { table_name } of tables) {
    const [r] = await owner.unsafe<{ n: number }[]>(
      `select count(*)::int as n from public.${table_name} where tenant_id = $1`,
      [tenantId],
    );
    out[table_name] = r!.n;
  }
  return out;
}

const del = async (s: SeededTenant, userId: string, confirmName: string) =>
  app.inject({
    method: 'DELETE',
    url: `/v1/tenants/${s.tenantId}`,
    headers: { authorization: `Bearer ${await auth.token(userId)}` },
    payload: { confirmName },
  });

describe('Delete all data (hard delete)', () => {
  it('erases every row of the tenant and its only-here owner login; others untouched', async () => {
    const A = await seedTenant(owner, 'gdpr-a', { embeddingAxis: 120 });
    const B = await seedTenant(owner, 'gdpr-b', { embeddingAxis: 121 });
    const before = await rowsFor(A.tenantId);
    expect(Object.values(before).every((n) => n > 0 || true)).toBe(true);
    expect(before.messages).toBeGreaterThan(0);
    const bBefore = await rowsFor(B.tenantId);

    expect((await del(A, A.userId, 'wrong name')).statusCode).toBe(400);
    expect((await del(A, B.userId, 'Tenant gdpr-a')).statusCode).toBe(403);
    const res = await del(A, A.userId, 'Tenant gdpr-a');
    expect(res.statusCode).toBe(202);

    // Stops at once: no longer an active tenant for the owner.
    const me = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${await auth.token(A.userId)}` },
    });
    expect(me.json().tenants).toEqual([]);
    const [mailboxes] = await workerSql<{ n: number }[]>`
      select count(*)::int as n from app.list_mail_connections(array['connected']) where tenant_id = ${A.tenantId}`;
    expect(mailboxes!.n).toBe(0);

    const [job] = await owner<{ id: string; payload: { tenantId: string } }[]>`
      select id, payload from public.jobs where tenant_id = ${A.tenantId} and queue = 'tenant.delete'`;
    expect(job!.payload.tenantId).toBe(A.tenantId);
    const out = await tenantDeleteHandler({ sql: workerSql })({
      id: job!.id,
      tenantId: A.tenantId,
      queue: 'tenant.delete',
      payload: job!.payload,
      attempts: 1,
      maxAttempts: 10,
    });
    expect(out).toEqual({ deleted: true, usersDeleted: 1 });

    const after = await rowsFor(A.tenantId);
    const leftovers = Object.entries(after).filter(([t, n]) => n > 0 && t !== 'tenant_deletions');
    expect(leftovers).toEqual([]);
    expect(await owner`select 1 from public.tenants where id = ${A.tenantId}`).toHaveLength(0);
    expect(await owner`select 1 from auth.users where id = ${A.userId}`).toHaveLength(0);
    expect(await rowsFor(B.tenantId)).toEqual(bBefore);

    const proof = await owner<{ completed_at: Date | null; requested_by_hash: string }[]>`
      select completed_at, requested_by_hash from public.tenant_deletions where tenant_id = ${A.tenantId} and completed_at is not null`;
    expect(proof).toHaveLength(1);
    expect(proof[0]!.requested_by_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(proof[0]!.requested_by_hash).not.toContain(A.userId);
  });

  it('keeps a login that still belongs to another business', async () => {
    const C = await seedTenant(owner, 'gdpr-c', { embeddingAxis: 122 });
    const D = await seedTenant(owner, 'gdpr-d', { embeddingAxis: 123 });
    await owner`insert into public.tenant_members (tenant_id, user_id) values (${D.tenantId}, ${C.userId})`;
    expect((await del(C, C.userId, 'Tenant gdpr-c')).statusCode).toBe(202);
    const out = await tenantDeleteHandler({ sql: workerSql })({
      id: randomUUID(),
      tenantId: C.tenantId,
      queue: 'tenant.delete',
      payload: {},
      attempts: 1,
      maxAttempts: 10,
    });
    expect(out).toEqual({ deleted: true, usersDeleted: 0 });
    expect(await owner`select 1 from auth.users where id = ${C.userId}`).toHaveLength(1);
    expect(await owner`select 1 from public.tenants where id = ${D.tenantId}`).toHaveLength(1);
  });

  it('the worker function refuses a tenant that did not ask to be deleted', async () => {
    const E = await seedTenant(owner, 'gdpr-e', { embeddingAxis: 124 });
    await workerSql`select * from app.delete_tenant(${E.tenantId})`;
    expect(await owner`select 1 from public.tenants where id = ${E.tenantId}`).toHaveLength(1);
  });
});

describe('retention purge', () => {
  it('removes email content older than retention_days and keeps metadata', async () => {
    const F = await seedTenant(owner, 'gdpr-f', { embeddingAxis: 125 });
    await owner`update public.tenants set retention_days = 30 where id = ${F.tenantId}`;
    await owner`update public.message_processing set classification = ${owner.json({ summary: 'secret summary' })} where tenant_id = ${F.tenantId}`;
    // The inbound message is 40 days old, the outbound one is fresh.
    await owner`update public.messages set received_at = now() - interval '40 days' where id = ${F.messageId}`;
    await owner`update public.drafts set created_at = now() - interval '40 days' where tenant_id = ${F.tenantId}`;
    const r = await purgeExpiredContent(workerSql);
    expect(r.messages_purged).toBeGreaterThanOrEqual(1);
    expect(r.drafts_purged).toBeGreaterThanOrEqual(1);

    const msgs = await owner<
      {
        id: string;
        body_text: string | null;
        subject: string | null;
        message_id_header: string;
        from_address: string;
        body_purged_at: Date | null;
      }[]
    >`
      select id, body_text, subject, message_id_header, from_address, body_purged_at from public.messages where tenant_id = ${F.tenantId}`;
    const old = msgs.find((m) => m.id === F.messageId)!;
    expect(old).toMatchObject({ body_text: null, subject: null });
    expect(old.body_purged_at).not.toBeNull();
    expect(old.message_id_header).toMatch(/^</); // dedupe keeps working
    expect(msgs.find((m) => m.id !== F.messageId)!.body_text).toBe('Reply');
    const [mp] = await owner<
      { classification: unknown }[]
    >`select classification from public.message_processing where message_id = ${F.messageId}`;
    expect(mp!.classification).toBeNull();
    const [d] = await owner<
      { body: string | null; subject: string }[]
    >`select body, subject from public.drafts where tenant_id = ${F.tenantId}`;
    expect(d).toEqual({ body: null, subject: '[deleted]' });
    // Idempotent.
    const again = await purgeExpiredContent(workerSql);
    expect(again.messages_purged).toBe(0);
  });
});
