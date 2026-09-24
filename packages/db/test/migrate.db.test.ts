import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { migrate } from '../src/migrate.ts';

const sql = postgres(inject('ownerDatabaseUrl'), { max: 1, onnotice: () => {} });
afterAll(() => sql.end());

describe('migrations', () => {
  it('are idempotent: a second run applies nothing', async () => {
    expect(await migrate(sql)).toEqual([]);
  });

  it('run against a Supabase-compatible database (auth schema, pgvector available)', async () => {
    const [row] = await sql<{ uid: boolean; vector: boolean }[]>`
      select to_regprocedure('auth.uid()') is not null as uid,
             exists (select 1 from pg_available_extensions where name = 'vector') as vector`;
    expect(row).toEqual({ uid: true, vector: true });
  });
});
