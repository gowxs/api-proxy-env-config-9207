/**
 * Local Noctiv stack in one command (development only):
 *   pnpm dev:stack            demo business with sample conversations
 *   pnpm dev:stack --empty    start from the signup/onboarding wizard
 *   pnpm dev:stack --gemini   real model (GEMINI_API_KEY from .env, free tier;
 *                             only the demo test mailbox is processed)
 *
 * Starts Postgres (Supabase image) and GreenMail with Docker, applies the
 * migrations, creates the demo owner, then runs API (:4000), worker and web
 * (:3000, reachable from a phone on the same network).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { generateSealingKeyPair } from '../packages/core/src/crypto/sealed-box.ts';
import { migrate } from '../packages/db/src/migrate.ts';
import postgres from 'postgres';
import { DEV, seedDemo } from './dev-seed.ts';

const root = join(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const OWNER_URL = 'postgres://postgres:postgres@localhost:54322/postgres';
const RUNTIME_PASSWORD = 'dev-runtime-password';
const runtimeUrl = (role: string) =>
  `postgres://${role}:${RUNTIME_PASSWORD}@localhost:54322/postgres`;

function run(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: root, stdio: 'inherit' });
    p.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)),
    );
  });
}

async function waitForDb() {
  for (let i = 0; i < 120; i++) {
    const sql = postgres(OWNER_URL, { max: 1, connect_timeout: 3, onnotice: () => {} });
    try {
      const [r] = await sql<
        { ok: boolean }[]
      >`select to_regprocedure('auth.uid()') is not null as ok`;
      if (r?.ok) return;
    } catch {
      // not up yet
    } finally {
      await sql.end({ timeout: 1 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('database did not start');
}

function sealingKeys() {
  const dir = join(root, 'secrets');
  const priv = join(dir, 'dev-sealing-private.key');
  const pub = join(dir, 'dev-sealing-public.key');
  if (!existsSync(priv)) {
    mkdirSync(dir, { recursive: true });
    const pair = generateSealingKeyPair();
    writeFileSync(priv, `${pair.privateKey}\n`, { mode: 0o600 });
    writeFileSync(pub, `${pair.publicKey}\n`);
  }
  return { privateFile: priv, publicKey: readFileSync(pub, 'utf8').trim() };
}

function readDotEnv(): Record<string, string> {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
  return out;
}

function lanAddress(): string | undefined {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

const children: ChildProcess[] = [];
function start(
  name: string,
  cwd: string,
  cmd: string,
  argv: string[],
  env: Record<string, string>,
) {
  const p = spawn(cmd, argv, {
    cwd: join(root, cwd),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      // Corporate proxies / custom CAs (needed for --gemini behind a proxy).
      ...Object.fromEntries(
        ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS']
          .filter((k) => process.env[k])
          .map((k) => [k, process.env[k]!]),
      ),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = `[${name}]`.padEnd(9);
  const pipe = (s: NodeJS.ReadableStream) =>
    s.on('data', (d: Buffer) => {
      for (const line of d.toString().split('\n'))
        if (line.trim()) console.log(`${prefix} ${line}`);
    });
  pipe(p.stdout!);
  pipe(p.stderr!);
  p.on('exit', (code) => console.log(`${prefix} exited (${code})`));
  children.push(p);
}

async function main() {
  console.log('Starting Postgres and GreenMail (docker compose)…');
  await run('docker', ['compose', '-f', 'docker/compose.dev.yml', 'up', '-d', 'db', 'greenmail']);
  await waitForDb();
  const keys = sealingKeys();

  const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
  try {
    await migrate(sql);
    for (const role of ['noctiv_api', 'noctiv_worker']) {
      await sql.unsafe(`alter role ${role} with login password '${RUNTIME_PASSWORD}'`);
    }
    await seedDemo(sql, { publicKey: keys.publicKey, withBusiness: !args.has('--empty') });
  } finally {
    await sql.end();
  }

  const dotenv = readDotEnv();
  const common = {
    NODE_ENV: 'development',
    LOG_LEVEL: 'info',
    CREDENTIALS_PUBLIC_KEY: keys.publicKey,
    ACTION_LINK_SECRET: 'dev-only-action-link-secret-not-for-production',
    PUBLIC_API_URL: 'http://localhost:4000',
    PUBLIC_APP_URL: 'http://localhost:3000',
  };
  start('api', 'apps/api', process.execPath, ['src/main.ts'], {
    ...common,
    API_DATABASE_URL: runtimeUrl('noctiv_api'),
    SUPABASE_URL: dotenv.SUPABASE_URL || 'https://example.supabase.co',
    DEV_LOGIN_USER_ID: DEV.userId,
    DEV_LOGIN_EMAIL: DEV.ownerEmail,
    CONNECTION_TEST_WAIT_MS: '25000',
    // Try the invite-code gate locally: SIGNUP_INVITE_CODES=CODE pnpm dev:stack --empty
    ...(process.env.SIGNUP_INVITE_CODES
      ? { SIGNUP_INVITE_CODES: process.env.SIGNUP_INVITE_CODES }
      : {}),
  });
  start('worker', 'apps/worker', process.execPath, ['src/main.ts'], {
    ...common,
    WORKER_DATABASE_URL: runtimeUrl('noctiv_worker'),
    CREDENTIALS_PRIVATE_KEY_FILE: keys.privateFile,
    MAIL_ALLOW_INSECURE: 'true',
    SYSTEM_SMTP_HOST: 'localhost',
    SYSTEM_SMTP_PORT: String(DEV.smtpPort),
    SYSTEM_SMTP_SECURITY: 'none',
    SYSTEM_MAIL_FROM: 'Noctiv <notify@noctiv.local>',
    ADMIN_EMAIL: 'admin@noctiv.local',
    ...(args.has('--gemini') && dotenv.GEMINI_API_KEY
      ? { GEMINI_API_KEY: dotenv.GEMINI_API_KEY }
      : { LLM_PROVIDER: 'fake' }),
    // Model overrides, e.g. when the free tier's daily quota for one model is used up.
    ...Object.fromEntries(
      ['LLM_MODEL_FAST', 'LLM_MODEL_QUALITY', 'EMBED_MODEL']
        .filter((k) => process.env[k])
        .map((k) => [k, process.env[k]!]),
    ),
  });
  start(
    'web',
    'apps/web',
    join(root, 'apps/web/node_modules/.bin/next'),
    ['dev', '--port', '3000', '-H', '0.0.0.0'],
    {
      API_INTERNAL_URL: 'http://localhost:4000',
      NEXT_PUBLIC_DEV_LOGIN: '1',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  );

  const lan = lanAddress();
  console.log(`
Noctiv is starting.
  Computer:  http://localhost:3000
  Phone:     ${lan ? `http://${lan}:3000` : 'http://<this computer’s IP>:3000'} (same Wi-Fi)
  Sign in with “Sign in as the demo owner”.
  Demo mailbox: ${DEV.mailbox} — send it a customer email with: pnpm dev:mail "Subject" "Text"
  Owner notification emails land in GreenMail (IMAP localhost:${DEV.imapPort}, user ${DEV.ownerEmail}, any password).
Press Ctrl+C to stop.`);
}

const stop = () => {
  for (const c of children) c.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  stop();
});
