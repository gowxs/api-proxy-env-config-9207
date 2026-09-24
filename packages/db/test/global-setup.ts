import postgres from 'postgres';
import { createHmac } from 'node:crypto';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { migrate } from '../src/migrate.ts';

export const SUPABASE_POSTGRES_IMAGE = 'supabase/postgres:17.6.1.175';
export const SUPABASE_STORAGE_IMAGE = 'supabase/storage-api:v1.79.17';
/** Local-only signing secret for the throwaway Storage container. */
const STORAGE_JWT_SECRET = 'local-test-jwt-secret-at-least-32-characters';
const RUNTIME_ROLE_PASSWORD = 'test-runtime-password';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Schema owner (Supabase `postgres` role) — bypasses RLS; use only for fixtures. */
    ownerDatabaseUrl: string;
    apiDatabaseUrl: string;
    workerDatabaseUrl: string;
    /** Supabase Storage REST base URL, or '' when Storage is not available. */
    storageUrl: string;
    /** Server-side (service_role) token for that Storage instance. */
    storageToken: string;
  }
}

/** HS256 JWT like the ones Supabase issues; used only against the local Storage container. */
export function signLocalJwt(secret: string, role: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ role, iss: 'noctiv-test', iat: now, exp: now + 86_400 })}`;
  return `${head}.${createHmac('sha256', secret).update(head).digest('base64url')}`;
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
  let storage: StartedTestContainer | undefined;
  let network: StartedNetwork | undefined;
  let ownerUrl = process.env.TEST_DATABASE_URL;
  let storageUrl = process.env.TEST_STORAGE_URL ?? '';
  let storageToken = process.env.TEST_STORAGE_TOKEN ?? '';

  if (!ownerUrl) {
    network = await new Network().start();
    container = await new GenericContainer(SUPABASE_POSTGRES_IMAGE)
      .withNetwork(network)
      .withNetworkAliases('db')
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

  if (container && network) {
    // Supabase Storage runs its own migrations as supabase_storage_admin.
    const admin = postgres(ownerUrl.replace('postgres:postgres@', 'supabase_admin:postgres@'), {
      max: 1,
      onnotice: () => {},
    });
    await admin.unsafe("alter role supabase_storage_admin with password 'postgres'");
    await admin.end();
    storage = await new GenericContainer(SUPABASE_STORAGE_IMAGE)
      .withNetwork(network)
      .withEnvironment({
        AUTH_JWT_SECRET: STORAGE_JWT_SECRET,
        AUTH_JWT_ALGORITHM: 'HS256',
        PGRST_JWT_SECRET: STORAGE_JWT_SECRET,
        DATABASE_URL: 'postgres://supabase_storage_admin:postgres@db:5432/postgres',
        STORAGE_BACKEND: 'file',
        STORAGE_FILE_BACKEND_PATH: '/var/lib/storage',
        FILE_STORAGE_BACKEND_PATH: '/var/lib/storage',
        GLOBAL_S3_BUCKET: 'local',
        TENANT_ID: 'local',
        REGION: 'local',
        FILE_SIZE_LIMIT: '10485760',
        UPLOAD_FILE_SIZE_LIMIT: '10485760',
        DB_INSTALL_ROLES: 'false',
        ANON_KEY: 'unused',
        SERVICE_KEY: 'unused',
      })
      .withExposedPorts(5000)
      .withWaitStrategy(Wait.forLogMessage(/Started Successfully/))
      .start();
    storageUrl = `http://${storage.getHost()}:${storage.getMappedPort(5000)}`;
    storageToken = signLocalJwt(STORAGE_JWT_SECRET, 'service_role');
  }

  project.provide('ownerDatabaseUrl', ownerUrl);
  project.provide('storageUrl', storageUrl);
  project.provide('storageToken', storageToken);
  project.provide('apiDatabaseUrl', withCredentials(ownerUrl, 'noctiv_api', RUNTIME_ROLE_PASSWORD));
  project.provide(
    'workerDatabaseUrl',
    withCredentials(ownerUrl, 'noctiv_worker', RUNTIME_ROLE_PASSWORD),
  );

  return async () => {
    await storage?.stop();
    await container?.stop();
    await network?.stop();
  };
}
