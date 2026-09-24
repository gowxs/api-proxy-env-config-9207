import postgres from 'postgres';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/migrate.ts';

export const SUPABASE_POSTGRES_IMAGE = 'supabase/postgres:17.6.1.175';
const RUNTIME_ROLE_PASSWORD = 'test-runtime-password';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Schema owner (Supabase `postgres` role) — bypasses RLS; use only for fixtures. */
    ownerDatabaseUrl: string;
    apiDatabaseUrl: string;
    workerDatabaseUrl: string;
  }
}

async function waitForDatabase(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  // The Supabase image runs init scripts and restarts once, so a single
  // successful connection is not enough: require the auth schema to exist.
  while (Date.now() < deadline) {
    const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
    try {
      const [row] = await sql<
        { ready: boolean }[]
      >`select to_regprocedure('auth.uid()') is not null as ready`;
      if (row?.ready) return;
    } catch (e) {
      lastError = e;
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`Database not ready: ${String(lastError)}`);
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

export default async function setup(project: TestProject) {
  let container: StartedTestContainer | undefined;
  let ownerUrl = process.env.TEST_DATABASE_URL;

  if (!ownerUrl) {
    container = await new GenericContainer(SUPABASE_POSTGRES_IMAGE)
      .withEnvironment({ POSTGRES_PASSWORD: 'postgres' })
      .withExposedPorts(5432)
      .start();
    ownerUrl = `postgres://postgres:postgres@${container.getHost()}:${container.getMappedPort(5432)}/postgres`;
  }

  await waitForDatabase(ownerUrl);
  const sql = postgres(ownerUrl, { max: 1, onnotice: () => {} });
  try {
    await migrate(sql);
    // Runtime roles are created NOLOGIN by migrations; deployments set real
    // passwords out of band. Tests do the same with a throwaway password.
    for (const role of ['noctiv_api', 'noctiv_worker']) {
      const exists = await sql`select 1 from pg_roles where rolname = ${role}`;
      if (exists.length)
        await sql.unsafe(`alter role ${role} with login password '${RUNTIME_ROLE_PASSWORD}'`);
    }
  } finally {
    await sql.end();
  }

  project.provide('ownerDatabaseUrl', ownerUrl);
  project.provide('apiDatabaseUrl', withCredentials(ownerUrl, 'noctiv_api', RUNTIME_ROLE_PASSWORD));
  project.provide(
    'workerDatabaseUrl',
    withCredentials(ownerUrl, 'noctiv_worker', RUNTIME_ROLE_PASSWORD),
  );

  return async () => {
    await container?.stop();
  };
}
