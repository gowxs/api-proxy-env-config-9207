import { createLogger } from '@noctiv/core';
import { createDb } from '@noctiv/db';
import { buildApp } from './app.ts';
import { createTokenVerifier } from './auth.ts';
import { loadApiConfig } from './config.ts';
import { createDevAuth } from './routes/dev.ts';

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL });
const db = createDb(config.API_DATABASE_URL, { applicationName: 'noctiv-api' });
const authBase = `${config.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;

const supabaseVerifier = createTokenVerifier(
  config.AUTH_JWKS_JSON
    ? { jwks: JSON.parse(config.AUTH_JWKS_JSON) }
    : { jwksUrl: `${authBase}/.well-known/jwks.json`, issuer: authBase },
);
const devAuth = config.DEV_LOGIN_USER_ID
  ? await createDevAuth({ id: config.DEV_LOGIN_USER_ID, email: config.DEV_LOGIN_EMAIL })
  : undefined;
const devVerifier = devAuth ? createTokenVerifier({ jwks: devAuth.jwks }) : undefined;
if (devAuth) logger.warn('DEV LOGIN ENABLED (local development only)');

const app = buildApp({
  logger,
  sql: db.sql,
  checkDatabase: () => db.ping(),
  verifyToken: devVerifier
    ? (token) => devVerifier(token).catch(() => supabaseVerifier(token))
    : supabaseVerifier,
  credentialsPublicKey: config.CREDENTIALS_PUBLIC_KEY,
  connectionTestWaitMs: config.CONNECTION_TEST_WAIT_MS,
  actionSecret: config.ACTION_LINK_SECRET,
  appUrl: config.PUBLIC_APP_URL,
  inviteCodes: config.SIGNUP_INVITE_CODES,
  trustProxy: config.API_TRUST_PROXY,
  ...(devAuth ? { devRoutes: devAuth.routes } : {}),
});

const shutdown = async (signal: string) => {
  logger.info({ signal }, 'shutting down');
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.API_HOST, port: config.API_PORT });
