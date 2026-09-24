import postgres from 'postgres';
import { migrate } from '../src/migrate.ts';

// Runs as the schema owner (Supabase `postgres` role), never as the runtime roles.
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is required');
  process.exit(1);
}
const sql = postgres(url, { max: 1, onnotice: () => {} });
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `Applied:\n  ${applied.join('\n  ')}` : 'Database is up to date.');
} finally {
  await sql.end();
}
