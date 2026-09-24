import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  redactActionPath,
  signActionToken,
  verifyActionToken,
} from '../src/notify/action-token.ts';

const secret = 'k'.repeat(32);
const ids = { tenantId: randomUUID(), draftId: randomUUID() };

describe('action link tokens', () => {
  it('round-trips and expires after 7 days', () => {
    const now = new Date('2026-09-24T10:00:00Z');
    const t = signActionToken({ ...ids, action: 'approve' }, secret, now);
    const v = verifyActionToken(t, secret, now);
    expect(v).toEqual({
      ok: true,
      claims: { ...ids, action: 'approve', expiresAt: new Date('2026-10-01T10:00:00Z') },
    });
    expect(verifyActionToken(t, secret, new Date('2026-10-01T09:59:59Z')).ok).toBe(true);
    expect(verifyActionToken(t, secret, new Date('2026-10-01T10:00:00Z'))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects another secret, edited payloads and junk', () => {
    const t = signActionToken({ ...ids, action: 'reject' }, secret);
    expect(verifyActionToken(t, 'x'.repeat(32)).ok).toBe(false);
    const [v, payload, sig] = t.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload!, 'base64url').toString()),
        a: 'approve',
      }),
    ).toString('base64url');
    expect(verifyActionToken(`${v}.${forged}.${sig}`, secret)).toEqual({
      ok: false,
      reason: 'invalid',
    });
    // Same bytes, different (non-canonical) text in the last character: rejected.
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const twin = B64[B64.indexOf(sig!.at(-1)!) + 1]!; // differs only in the 2 unused bits
    expect(Buffer.from(`${sig!.slice(0, -1)}${twin}`, 'base64url')).toEqual(
      Buffer.from(sig!, 'base64url'),
    );
    expect(verifyActionToken(`${v}.${payload}.${sig!.slice(0, -1)}${twin}`, secret).ok).toBe(false);
    for (const junk of ['', 'v1', 'v1.a.b', 'v2.a.b', `${t}.x`, 'v1..']) {
      expect(verifyActionToken(junk, secret).ok).toBe(false);
    }
  });

  it('refuses short secrets', () => {
    expect(() => signActionToken({ ...ids, action: 'approve' }, 'short')).toThrow();
    expect(() => verifyActionToken('v1.a.b', 'short')).toThrow();
  });

  it('redacts tokens in URLs', () => {
    expect(redactActionPath('/actions/v1.abc.def?x=1')).toBe('/actions/[REDACTED]?x=1');
    expect(redactActionPath('/healthz')).toBe('/healthz');
  });
});
