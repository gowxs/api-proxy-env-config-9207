import { describe, expect, it } from 'vitest';
import { createLogger } from '@noctiv/core';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.ts';

const logger = createLogger({ service: 'api-test', level: 'silent' });
const base = {
  logger,
  sql: {} as Sql,
  verifyToken: async () => ({ userId: 'u' }),
  credentialsPublicKey: 'x'.repeat(43),
  connectionTestWaitMs: 1_000,
};

describe('api health endpoints', () => {
  it('reports liveness', async () => {
    const app = buildApp({ ...base, checkDatabase: async () => true });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports not-ready when the database is down', async () => {
    const app = buildApp({
      ...base,
      checkDatabase: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
  });

  it('requires a bearer token on /v1 routes', async () => {
    const app = buildApp({ ...base, checkDatabase: async () => true });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/tenants/00000000-0000-4000-8000-000000000000/connections',
    });
    expect(res.statusCode).toBe(401);
  });
});
