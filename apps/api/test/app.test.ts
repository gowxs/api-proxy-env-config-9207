import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, signActionToken } from '@noctiv/core';
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

describe('action links (no database needed for invalid tokens)', () => {
  const secret = 's'.repeat(40);

  it('never writes the link token to the logs', async () => {
    const lines: string[] = [];
    const logged = createLogger({
      service: 'api-test',
      level: 'info',
      destination: new Writable({
        write(chunk: Buffer, _enc, cb) {
          lines.push(chunk.toString());
          cb();
        },
      }),
    });
    const app = buildApp({
      ...base,
      logger: logged,
      checkDatabase: async () => true,
      actionSecret: secret,
    });
    const token = 'v1.c2VjcmV0LXBheWxvYWQ.c2lnbmF0dXJl';
    const res = await app.inject({ method: 'GET', url: `/actions/${token}` });
    expect(res.statusCode).toBe(404);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain('c2VjcmV0LXBheWxvYWQ');
    expect(lines.join('\n')).toContain('/actions/[REDACTED]');
  });

  it('rejects a tampered token and reports an expired one', async () => {
    const app = buildApp({ ...base, checkDatabase: async () => true, actionSecret: secret });
    const ids = { tenantId: randomUUID(), draftId: randomUUID() };
    const good = signActionToken({ ...ids, action: 'approve' }, secret);
    const [v, payload, sig] = good.split('.');
    const flipped = payload!.slice(0, 5) + (payload![5] === 'A' ? 'B' : 'A') + payload!.slice(6);
    const tampered = `${v}.${flipped}.${sig}`;
    const bad = await app.inject({ method: 'POST', url: `/actions/${tampered}` });
    expect(bad.statusCode).toBe(404);
    expect(bad.headers['content-security-policy']).toContain("default-src 'none'");
    const old = signActionToken(
      { ...ids, action: 'approve' },
      secret,
      new Date(Date.now() - 8 * 86_400_000),
    );
    const expired = await app.inject({ method: 'GET', url: `/actions/${old}` });
    expect(expired.statusCode).toBe(410);
    expect(expired.body).toContain('expired');
  });

  it('is switched off without a secret', async () => {
    const app = buildApp({ ...base, checkDatabase: async () => true });
    const res = await app.inject({ method: 'GET', url: '/actions/v1.x.y' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
