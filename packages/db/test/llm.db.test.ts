import { EMBEDDING_DIMENSIONS } from '@noctiv/core';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { currentBudget, recordUsage, withTenant } from '../src/index.ts';
import {
  asDashboardUser,
  axisVector,
  seedTenant,
  TEST_EMBEDDING_MODEL,
  type SeededTenant,
} from '../src/testing.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const api = postgres(inject('apiDatabaseUrl'), { max: 1, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 1, onnotice: () => {} });
let A: SeededTenant;

beforeAll(async () => {
  A = await seedTenant(owner, 'llm', { embeddingAxis: 5 });
});
afterAll(() => Promise.all([owner.end(), api.end(), worker.end()]));

describe('is_test_mailbox (free-tier guard flag)', () => {
  it('defaults to false', async () => {
    const [row] = await owner<
      { is_test_mailbox: boolean }[]
    >`select is_test_mailbox from public.email_connections where id = ${A.connectionId}`;
    expect(row?.is_test_mailbox).toBe(false);
  });

  it.each([
    ['noctiv_worker', () => worker],
    ['noctiv_api', () => api],
  ] as const)('%s cannot set it', async (_role, conn) => {
    await expect(
      withTenant(
        conn(),
        A.tenantId,
        (tx) =>
          tx`update public.email_connections set is_test_mailbox = true where id = ${A.connectionId}`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the API cannot create a mailbox that is already flagged', async () => {
    await expect(
      withTenant(
        api,
        A.tenantId,
        (tx) =>
          tx`insert into public.email_connections
             (tenant_id, provider, email_address, imap_host, imap_port, smtp_host, smtp_port, smtp_security,
              username, credentials_ciphertext, credentials_key_id, is_test_mailbox)
           values (${A.tenantId}, 'generic', 'sneaky@example.test', 'i', 993, 's', 465, 'tls', 'u', '\\x00', 'k', true)`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the worker can still update other columns', async () => {
    const r = await withTenant(
      worker,
      A.tenantId,
      (tx) =>
        tx`update public.email_connections set last_checked_at = now() where id = ${A.connectionId}`,
    );
    expect(r.count).toBe(1);
  });

  it('the operator (schema owner) can set it, and the scheduler listing reports it', async () => {
    await owner`update public.email_connections set is_test_mailbox = true where id = ${A.connectionId}`;
    const rows = await worker<{ connection_id: string; is_test_mailbox: boolean }[]>`
      select connection_id, is_test_mailbox from app.list_mail_connections() where connection_id = ${A.connectionId}`;
    expect(rows).toEqual([{ connection_id: A.connectionId, is_test_mailbox: true }]);
    await owner`update public.email_connections set is_test_mailbox = false where id = ${A.connectionId}`;
  });

  it('is visible to the dashboard (read-only badge)', async () => {
    const rows = await asDashboardUser(
      owner,
      A.userId,
      (tx) => tx`select is_test_mailbox from public.email_connections`,
    );
    expect(rows).toEqual([{ is_test_mailbox: false }]);
  });
});

describe('embeddings', () => {
  it(`kb_chunks.embedding is vector(${EMBEDDING_DIMENSIONS}), matching the providers`, async () => {
    const [row] = await owner<{ t: string }[]>`
      select format_type(atttypid, atttypmod) as t from pg_attribute
      where attrelid = 'public.kb_chunks'::regclass and attname = 'embedding'`;
    expect(row?.t).toBe(`vector(${EMBEDDING_DIMENSIONS})`);
  });

  it('search only matches chunks embedded with the same model', async () => {
    const search = (model: string) =>
      withTenant(worker, A.tenantId, (tx) =>
        tx.unsafe<{ chunk_id: string }[]>(
          'select chunk_id from app.search_kb_chunks($1, $2, $3::extensions.vector, 5)',
          [A.tenantId, model, axisVector(5)],
        ),
      );
    expect((await search(TEST_EMBEDDING_MODEL)).map((r) => r.chunk_id)).toEqual([A.chunkId]);
    expect(await search('gemini-embedding-001')).toEqual([]);
  });
});

describe('usage metering and budget states (Q3)', () => {
  const now = new Date('2026-09-24T10:00:00Z');
  let T: SeededTenant;

  beforeAll(async () => {
    T = await seedTenant(owner, 'budget', { embeddingAxis: 6 });
    await owner`update public.tenants set daily_token_budget = 1000 where id = ${T.tenantId}`;
    await owner`delete from public.usage_daily where tenant_id = ${T.tenantId}`;
    await owner`delete from public.notifications where tenant_id = ${T.tenantId}`;
  });

  const record = (input: number, output: number, embed = 0, at = now) =>
    withTenant(worker, T.tenantId, (tx) =>
      recordUsage(tx, {
        tenantId: T.tenantId,
        usage: { inputTokens: input, outputTokens: output, thinkingTokens: 0 },
        llmCalls: 1,
        embedTokens: embed,
        now: at,
      }),
    );

  const notifications = () =>
    owner<{ channel: string; kind: string; dedupe_key: string }[]>`
      select channel, kind, dedupe_key from public.notifications where tenant_id = ${T.tenantId} order by dedupe_key`;

  it('accumulates today and stays ok below the budget', async () => {
    expect(await record(400, 100, 100)).toMatchObject({
      state: 'ok',
      usedTokens: 600,
      dailyBudget: 1000,
    });
  });

  it('switches to draft_forced at 100 % and alerts the admin once', async () => {
    expect(await record(300, 100)).toMatchObject({
      state: 'draft_forced',
      previous: 'ok',
      usedTokens: 1000,
    });
    expect(await record(10, 0)).toMatchObject({ state: 'draft_forced', previous: 'draft_forced' });
    expect(await notifications()).toEqual([
      {
        channel: 'email_admin',
        kind: 'budget_state',
        dedupe_key: 'budget:2026-09-24:draft_forced:admin',
      },
    ]);
  });

  it('halts at 150 % and notifies the owner too', async () => {
    expect(await record(500, 0)).toMatchObject({ state: 'halted', previous: 'draft_forced' });
    expect((await notifications()).map((n) => n.dedupe_key)).toEqual([
      'budget:2026-09-24:draft_forced:admin',
      'budget:2026-09-24:halted:admin',
      'budget:2026-09-24:halted:owner',
    ]);
    const [t] = await owner<
      { budget_state: string }[]
    >`select budget_state from public.tenants where id = ${T.tenantId}`;
    expect(t?.budget_state).toBe('halted');
  });

  it('a new UTC day starts at ok without any reset job', async () => {
    const tomorrow = new Date('2026-09-25T00:00:01Z');
    const status = await withTenant(worker, T.tenantId, (tx) =>
      currentBudget(tx, T.tenantId, tomorrow),
    );
    expect(status).toMatchObject({ state: 'ok', previous: 'halted', usedTokens: 0 });
  });

  it('cannot record usage for another tenant', async () => {
    await expect(
      withTenant(worker, A.tenantId, (tx) =>
        recordUsage(tx, { tenantId: T.tenantId, llmCalls: 1, now }),
      ),
    ).rejects.toBeTruthy();
  });
});
