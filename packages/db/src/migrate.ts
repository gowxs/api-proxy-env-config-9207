import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from 'postgres';

export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../supabase/migrations');

/**
 * Applies supabase/migrations/*.sql in filename order, recording them in the
 * same table the Supabase CLI uses, so `supabase db push` and this runner agree
 * on what has been applied. Each file runs in its own transaction.
 */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  await sql.unsafe(`
    create schema if not exists supabase_migrations;
    create table if not exists supabase_migrations.schema_migrations (
      version text primary key,
      statements text[],
      name text
    );
  `);
  const applied = new Set(
    (
      await sql<{ version: string }[]>`select version from supabase_migrations.schema_migrations`
    ).map((r) => r.version),
  );
  const files = (await readdir(dir)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    const [version, ...rest] = file.replace(/\.sql$/, '').split('_');
    if (!version || applied.has(version)) continue;
    const body = await readFile(path.join(dir, file), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(body);
      await tx`insert into supabase_migrations.schema_migrations (version, name) values (${version}, ${rest.join('_')})`;
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}
