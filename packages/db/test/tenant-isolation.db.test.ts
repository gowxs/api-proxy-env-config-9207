/**
 * Proves tenant A cannot read or modify tenant B's data through any access
 * path used at runtime: dashboard users (Supabase Auth + RLS), the API role,
 * the worker role, and the knowledge-base search functions.
 *
 * The table list is read from the catalog, so a table added later without
 * tenant_id / RLS / policies fails these tests automatically.
 */
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { withTenant } from '../src/index.ts';
import {
  asDashboardUser,
  axisVector,
  seedTenant,
  TEST_EMBEDDING_MODEL,
  type SeededTenant,
} from '../src/testing.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
// max: 1 so tests can prove settings do not leak between transactions on a pooled connection.
const api = postgres(inject('apiDatabaseUrl'), { max: 1, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 1, onnotice: () => {} });

let A: SeededTenant;
let B: SeededTenant;
let tables: string[];

beforeAll(async () => {
  A = await seedTenant(owner, 'a', { embeddingAxis: 0 });
  B = await seedTenant(owner, 'b', { embeddingAxis: 1 });
  tables = (
    await owner<{ relname: string }[]>`
      select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') order by 1`
  ).map((r) => r.relname);
});

afterAll(async () => {
  await Promise.all([owner.end(), api.end(), worker.end()]);
});

// postgres.js escapes 'public.leads' as "public"."leads".
const ident = (sql: Sql | TransactionSql, table: string) => sql(`public.${table}`);

async function canSelectTenantId(role: string, table: string): Promise<boolean> {
  const [row] = await owner<{ ok: boolean }[]>`
    select has_column_privilege(${role}, ${`public.${table}`}, 'tenant_id', 'select') as ok`;
  return row?.ok ?? false;
}

describe('schema invariants', () => {
  it('covers all 22 Phase 1 tables', () => {
    expect(tables).toHaveLength(22);
  });

  it('every table has tenant_id, forced RLS and both isolation policies', async () => {
    const rows = await owner<
      { table: string; has_tenant_id: boolean; rls: boolean; forced: boolean; policies: string[] }[]
    >`
      select c.relname as table,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id'
                     and a.atttypid = 'uuid'::regtype and a.attnotnull and not a.attisdropped) as has_tenant_id,
             c.relrowsecurity as rls,
             c.relforcerowsecurity as forced,
             coalesce((select array_agg(p.polname::text order by p.polname) from pg_policy p where p.polrelid = c.oid), '{}') as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')`;
    const bad = rows.filter(
      (r) =>
        !r.has_tenant_id ||
        !r.rls ||
        !r.forced ||
        r.policies.join(',') !== 'member_tenant_access,runtime_tenant_isolation',
    );
    expect(bad).toEqual([]);
  });

  it('fixtures put rows for both tenants in every table (so the checks below are meaningful)', async () => {
    const empty: string[] = [];
    for (const t of tables) {
      for (const tenant of [A, B]) {
        const [row] = await owner<{ n: number }[]>`
          select count(*)::int as n from ${ident(owner, t)} where tenant_id = ${tenant.tenantId}`;
        if (!row?.n) empty.push(`${t}:${tenant.label}`);
      }
    }
    expect(empty).toEqual([]);
  });

  it('no role used at runtime can bypass RLS', async () => {
    const rows = await owner<{ rolname: string; rolbypassrls: boolean }[]>`
      select rolname, rolbypassrls from pg_roles
      where rolname in ('noctiv_api', 'noctiv_worker', 'authenticated', 'anon') order by 1`;
    expect(rows).toEqual([
      { rolname: 'anon', rolbypassrls: false },
      { rolname: 'authenticated', rolbypassrls: false },
      { rolname: 'noctiv_api', rolbypassrls: false },
      { rolname: 'noctiv_worker', rolbypassrls: false },
    ]);
  });
});

describe.each([
  ['noctiv_api', () => api],
  ['noctiv_worker', () => worker],
] as const)('runtime role %s', (role, conn) => {
  it('inside tenant A sees only tenant A rows, in every readable table', async () => {
    const report: Record<string, string> = {};
    for (const t of tables) {
      if (!(await canSelectTenantId(role, t))) continue;
      const seen = await withTenant(
        conn(),
        A.tenantId,
        (tx) => tx<{ tenant_id: string }[]>`select tenant_id from ${ident(tx, t)}`,
      );
      const foreign = seen.filter((r) => r.tenant_id !== A.tenantId).length;
      if (foreign > 0 || seen.length === 0)
        report[t] = `own=${seen.length - foreign} foreign=${foreign}`;
    }
    expect(report).toEqual({});
  });

  it('without tenant context sees zero rows everywhere', async () => {
    const leaks: string[] = [];
    for (const t of tables) {
      if (!(await canSelectTenantId(role, t))) continue;
      const [row] = await conn()<
        { n: number }[]
      >`select count(*)::int as n from ${ident(conn(), t)}`;
      if (row?.n) leaks.push(`${t}=${row.n}`);
    }
    expect(leaks).toEqual([]);
  });

  it('tenant context does not survive the transaction on a pooled connection', async () => {
    await withTenant(conn(), A.tenantId, async () => undefined);
    const [row] = await conn()<{ tid: string | null; n: number }[]>`
      select current_setting('app.tenant_id', true) as tid,
             (select count(*)::int from public.leads) as n`;
    expect(row?.n).toBe(0);
    expect(row?.tid ?? '').toBe('');
  });

  it('cannot insert a row carrying tenant B id while in tenant A', async () => {
    await expect(
      withTenant(
        conn(),
        A.tenantId,
        (tx) =>
          tx`insert into public.audit_log (tenant_id, actor, action) values (${B.tenantId}, 'system', 'attack')`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot read sealed mailbox credentials of any tenant', async () => {
    if (role === 'noctiv_worker') {
      // The worker legitimately reads its own tenant's ciphertext (it holds the key)...
      const rows = await withTenant(
        worker,
        A.tenantId,
        (tx) =>
          tx<
            { tenant_id: string }[]
          >`select tenant_id, credentials_ciphertext from public.email_connections`,
      );
      expect(rows.map((r) => r.tenant_id)).toEqual([A.tenantId]);
      return;
    }
    // ...the API never can, not even its own.
    await expect(
      withTenant(
        api,
        A.tenantId,
        (tx) => tx`select credentials_ciphertext from public.email_connections`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('worker writes stay inside the tenant', () => {
  it('updates and deletes aimed at tenant B affect nothing', async () => {
    const counts = await withTenant(worker, A.tenantId, async (tx) => {
      const upd = await tx`update public.leads set notes = 'pwned' where tenant_id = ${B.tenantId}`;
      const del = await tx`delete from public.messages where tenant_id = ${B.tenantId}`;
      const delAll = await tx`delete from public.kb_chunks where source_id = ${B.sourceId}`;
      return [upd.count, del.count, delAll.count];
    });
    expect(counts).toEqual([0, 0, 0]);
    const [row] = await owner<{ notes: string | null; msgs: number }[]>`
      select (select notes from public.leads where id = ${B.leadId}) as notes,
             (select count(*)::int from public.messages where tenant_id = ${B.tenantId}) as msgs`;
    expect(row).toEqual({ notes: null, msgs: 2 });
  });

  it('cannot move its own rows to tenant B', async () => {
    const failures: string[] = [];
    for (const t of tables) {
      if (t === 'tenants') continue; // tenant_id is generated from id there
      try {
        await withTenant(
          worker,
          A.tenantId,
          (tx) =>
            tx`update ${ident(tx, t)} set tenant_id = ${B.tenantId} where tenant_id = ${A.tenantId}`,
        );
        failures.push(t);
      } catch (e) {
        // 42501 RLS WITH CHECK, or 23503 composite FK — either way rejected.
        if (!['42501', '23503'].includes((e as { code?: string }).code ?? '')) throw e;
      }
    }
    expect(failures).toEqual([]);
  });

  it('cannot link its rows to tenant B parents (composite foreign keys)', async () => {
    await expect(
      withTenant(
        worker,
        A.tenantId,
        (tx) =>
          tx`insert into public.kb_chunks (tenant_id, source_id, chunk_index, content, embedding_model)
           values (${A.tenantId}, ${B.sourceId}, 99, 'smuggled', ${TEST_EMBEDDING_MODEL})`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      withTenant(
        worker,
        A.tenantId,
        (tx) =>
          tx`insert into public.drafts (tenant_id, thread_id, kind, to_address, subject, body)
           values (${A.tenantId}, ${B.threadId}, 'reply', 'x@example.test', 's', 'b')`,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('dashboard users (Supabase Auth + RLS)', () => {
  it('see only their own tenant in every table they may read', async () => {
    const report: Record<string, string> = {};
    for (const t of tables) {
      if (!(await canSelectTenantId('authenticated', t))) continue;
      const seen = await asDashboardUser(
        owner,
        A.userId,
        (tx) => tx<{ tenant_id: string }[]>`select tenant_id from ${ident(tx, t)}`,
      );
      const foreign = seen.filter((r) => r.tenant_id !== A.tenantId).length;
      if (foreign > 0 || seen.length === 0)
        report[t] = `own=${seen.length - foreign} foreign=${foreign}`;
    }
    expect(report).toEqual({});
  });

  it('have no access at all to internal tables', async () => {
    for (const t of [
      'telegram_link_tokens',
      'kb_chunks',
      'kb_allowlist',
      'kb_uploads',
      'jobs',
      'notifications',
      'tenant_deletions',
    ]) {
      await expect(
        asDashboardUser(owner, A.userId, (tx) => tx`select 1 from ${ident(tx, t)}`),
      ).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('cannot read sealed credentials, but can read connection status', async () => {
    await expect(
      asDashboardUser(
        owner,
        A.userId,
        (tx) => tx`select credentials_ciphertext from public.email_connections`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const rows = await asDashboardUser(
      owner,
      A.userId,
      (tx) => tx<{ id: string; status: string }[]>`select id, status from public.email_connections`,
    );
    expect(rows).toEqual([{ id: A.connectionId, status: 'connected' }]);
  });

  it("can edit own lead notes but not tenant B's, and cannot change stage directly", async () => {
    const [own, foreign] = await asDashboardUser(owner, A.userId, async (tx) => [
      (await tx`update public.leads set notes = 'called' where id = ${A.leadId}`).count,
      (await tx`update public.leads set notes = 'pwned' where id = ${B.leadId}`).count,
    ]);
    expect([own, foreign]).toEqual([1, 0]);
    await expect(
      asDashboardUser(
        owner,
        A.userId,
        (tx) => tx`update public.leads set stage = 'converted' where id = ${A.leadId}`,
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('a signed-in user without membership sees nothing', async () => {
    const stranger = '00000000-0000-4000-8000-000000000001';
    const [row] = await asDashboardUser(
      owner,
      stranger,
      (tx) =>
        tx<
          { n: number }[]
        >`select (select count(*) from public.tenants) + (select count(*) from public.messages)
                          + (select count(*) from public.leads) as n`,
    );
    expect(Number(row?.n)).toBe(0);
  });

  it('anonymous requests are denied on every table', async () => {
    const allowed: string[] = [];
    for (const t of tables) {
      try {
        await asDashboardUser(
          owner,
          null,
          (tx) => tx`select 1 from ${ident(tx, t)} limit 1`,
          'anon',
        );
        allowed.push(t);
      } catch (e) {
        if ((e as { code?: string }).code !== '42501') throw e;
      }
    }
    expect(allowed).toEqual([]);
  });
});

describe('knowledge-base search', () => {
  it("never returns tenant B's chunk to tenant A, even when it is the exact nearest neighbour", async () => {
    // Query equals B's embedding (axis 1); A's chunk (axis 0) is further away.
    const rows = await withTenant(worker, A.tenantId, (tx) =>
      tx.unsafe<{ chunk_id: string }[]>(
        'select chunk_id from app.search_kb_chunks($1, $2, $3::extensions.vector, 10)',
        [A.tenantId, TEST_EMBEDDING_MODEL, axisVector(1)],
      ),
    );
    expect(rows.map((r) => r.chunk_id)).toEqual([A.chunkId]);
  });

  it("asking for tenant B's chunks from tenant A's context returns nothing", async () => {
    const vector = await withTenant(worker, A.tenantId, (tx) =>
      tx.unsafe('select chunk_id from app.search_kb_chunks($1, $2, $3::extensions.vector, 10)', [
        B.tenantId,
        TEST_EMBEDDING_MODEL,
        axisVector(1),
      ]),
    );
    const fts = await withTenant(
      worker,
      A.tenantId,
      (tx) => tx`select chunk_id from app.search_kb_chunks_fts(${B.tenantId}, 'secret price', 10)`,
    );
    expect([vector.length, fts.length]).toEqual([0, 0]);
  });

  it('full-text search is tenant-scoped', async () => {
    const rows = await withTenant(
      worker,
      A.tenantId,
      (tx) =>
        tx<
          { chunk_id: string }[]
        >`select chunk_id from app.search_kb_chunks_fts(${A.tenantId}, 'secret price', 10)`,
    );
    expect(rows.map((r) => r.chunk_id)).toEqual([A.chunkId]);
  });

  it('search and cross-tenant listing functions are not callable by the API or dashboard users', async () => {
    const calls = [
      'select * from app.search_kb_chunks_fts(gen_random_uuid(), $$x$$, 1)',
      'select * from app.list_active_tenants()',
      'select * from app.list_mail_connections()',
      "select * from app.claim_jobs(array['test.seed'], 1, 30)",
    ];
    for (const q of calls) {
      await expect(withTenant(api, A.tenantId, (tx) => tx.unsafe(q))).rejects.toMatchObject({
        code: '42501',
      });
      await expect(asDashboardUser(owner, A.userId, (tx) => tx.unsafe(q))).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('the worker scheduler listing returns identifiers only', async () => {
    const rows = await worker<{ tenant_id: string; connection_id: string }[]>`
      select * from app.list_mail_connections()`;
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'connection_id',
      'is_test_mailbox',
      'tenant_id',
    ]);
    expect(rows.map((r) => r.connection_id)).toEqual(
      expect.arrayContaining([A.connectionId, B.connectionId]),
    );
  });
});

describe('duplicate guards', () => {
  it('the same Message-ID cannot be stored twice for one mailbox', async () => {
    const header = `<dup-${A.messageId}@example.test>`;
    const insert = () =>
      withTenant(
        worker,
        A.tenantId,
        (tx) =>
          tx`insert into public.messages (tenant_id, connection_id, direction, message_id_header, from_address, received_at)
           values (${A.tenantId}, ${A.connectionId}, 'inbound', ${header}, 'c@example.test', now())`,
      );
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });

  it('a draft can produce at most one outbound email', async () => {
    await expect(
      withTenant(
        worker,
        A.tenantId,
        (tx) =>
          tx`insert into public.outbound_emails (tenant_id, draft_id, thread_id, message_id_header, to_address, subject, sent_via)
           values (${A.tenantId}, ${A.draftId}, ${A.threadId}, '<second@noctiv.test>', 'c@example.test', 'Re: Question', 'auto')`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('a message can only get one processing record', async () => {
    await expect(
      withTenant(
        worker,
        A.tenantId,
        (tx) =>
          tx`insert into public.message_processing (tenant_id, message_id) values (${A.tenantId}, ${A.messageId})`,
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
