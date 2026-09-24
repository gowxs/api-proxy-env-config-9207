import { describe, expect, it } from 'vitest';
import { createLogger } from '@noctiv/core';
import { buildApp } from '../src/app.ts';

const logger = createLogger({ service: 'api-test', level: 'silent' });

describe('api health endpoints', () => {
  it('reports liveness', async () => {
    const app = buildApp({ logger, checkDatabase: async () => true });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('reports not-ready when the database is down', async () => {
    const app = buildApp({
      logger,
      checkDatabase: async () => {
        throw new Error('connection refused');
      },
    });
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(503);
  });
});
