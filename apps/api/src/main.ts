import { createLogger } from '@noctiv/core';
import { createDb } from '@noctiv/db';
import { buildApp } from './app.ts';
import { createTokenVerifier } from './auth.ts';
import { loadApiConfig } from './config.ts';

const config = loadApiConfig();
const logger = createLogger({ service: 'api', level: config.LOG_LEVEL });
const db = createDb(config.API_DATABASE_URL, { applicationName: 'noctiv-api' });
const authBase = `${config.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1`;

const app = buildApp({
  logger,
  sql: db.sql,
  checkDatabase: () => db.ping(),
  verifyToken: createTokenVerifier(
    config.AUTH_JWKS_JSON
      ? { jwks: JSON.parse(config.AUTH_JWKS_JSON) }
      : { jwksUrl: `${authBase}/.well-known/jwks.json`, issuer: authBase },
  ),
  credentialsPublicKey: config.CREDENTIALS_PUBLIC_KEY,
  connectionTestWaitMs: config.CONNECTION_TEST_WAIT_MS,
  actionSecret: config.ACTION_LINK_SECRET,
  appUrl: config.PUBLIC_APP_URL,
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
