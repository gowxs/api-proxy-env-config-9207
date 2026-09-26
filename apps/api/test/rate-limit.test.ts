import { describe, expect, it } from 'vitest';
import { createLogger } from '@noctiv/core';
import type { Sql } from 'postgres';
import { buildApp } from '../src/app.ts';
import { RateLimiter } from '../src/rate-limit.ts';

describe('RateLimiter', () => {
  it('allows max hits per window, then asks to wait', () => {
    let t = 0;
    const r = new RateLimiter({ max: 2, windowMs: 10_000, now: () => t });
    expect([r.hit('a'), r.hit('a'), r.hit('a')]).toEqual([0, 0, 10]);
    expect(r.hit('b')).toBe(0);
    t = 10_000;
    expect(r.hit('a')).toBe(0);
  });
});

describe('API rate limits', () => {
  it('action links: 30 attempts per 10 minutes per address, then 429', async () => {
    const app = buildApp({
      logger: createLogger({ service: 'api-test', level: 'silent' }),
      sql: {} as Sql,
      checkDatabase: async () => true,
      verifyToken: async () => ({ userId: 'u' }),
      credentialsPublicKey: 'x'.repeat(43),
      connectionTestWaitMs: 1_000,
      actionSecret: 's'.repeat(40),
    });
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) {
      codes.push((await app.inject({ method: 'GET', url: `/actions/v1.guess${i}.x` })).statusCode);
    }
    expect(codes.slice(0, 30).every((c) => c === 404)).toBe(true);
    const last = await app.inject({ method: 'GET', url: '/actions/v1.more.x' });
    expect(last.statusCode).toBe(429);
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    // Other routes are unaffected.
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('waitlist sign-ups: 5 per hour per address, then 429', async () => {
    const app = buildApp({
      logger: createLogger({ service: 'api-test', level: 'silent' }),
      sql: {} as Sql,
      checkDatabase: async () => true,
      verifyToken: async () => ({ userId: 'u' }),
      credentialsPublicKey: 'x'.repeat(43),
      connectionTestWaitMs: 1_000,
      actionSecret: 's'.repeat(40),
    });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/waitlist',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'email=bad',
      });
      codes.push(r.statusCode);
    }
    expect(codes).toEqual([400, 400, 400, 400, 400, 429]);
  });
});
