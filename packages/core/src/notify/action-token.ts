import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed Approve / Reject links for owner emails (founder decision after
 * step 8): HMAC-SHA256, 7-day expiry. The token names tenant, draft and
 * action; single use comes from the draft's state (only a pending draft can
 * be decided), so repeating a link is harmless.
 */
export type DraftAction = 'approve' | 'reject';
export const ACTION_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_ACTION_SECRET_LENGTH = 32;

export interface ActionClaims {
  tenantId: string;
  draftId: string;
  action: DraftAction;
  expiresAt: Date;
}

const VERSION = 'v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function mac(secret: string, data: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

function checkSecret(secret: string) {
  if (secret.length < MIN_ACTION_SECRET_LENGTH) throw new Error('action link secret too short');
}

export function signActionToken(
  c: { tenantId: string; draftId: string; action: DraftAction },
  secret: string,
  now = new Date(),
): string {
  checkSecret(secret);
  const payload = Buffer.from(
    JSON.stringify({
      t: c.tenantId,
      d: c.draftId,
      a: c.action,
      e: Math.floor((now.getTime() + ACTION_LINK_TTL_MS) / 1000),
    }),
  ).toString('base64url');
  const data = `${VERSION}.${payload}`;
  return `${data}.${mac(secret, data).toString('base64url')}`;
}

export type VerifyResult =
  { ok: true; claims: ActionClaims } | { ok: false; reason: 'invalid' | 'expired' };

export function verifyActionToken(token: string, secret: string, now = new Date()): VerifyResult {
  checkSecret(secret);
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION || token.length > 512) {
    return { ok: false, reason: 'invalid' };
  }
  const data = `${parts[0]}.${parts[1]}`;
  const given = Buffer.from(parts[2]!, 'base64url');
  const expected = mac(secret, data);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'invalid' };
  }
  let p: { t?: unknown; d?: unknown; a?: unknown; e?: unknown };
  try {
    p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as typeof p;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    typeof p.t !== 'string' ||
    !UUID.test(p.t) ||
    typeof p.d !== 'string' ||
    !UUID.test(p.d) ||
    (p.a !== 'approve' && p.a !== 'reject') ||
    typeof p.e !== 'number'
  ) {
    return { ok: false, reason: 'invalid' };
  }
  const expiresAt = new Date(p.e * 1000);
  if (expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { tenantId: p.t, draftId: p.d, action: p.a, expiresAt } };
}

/** For logs: action URLs carry a bearer-like token. */
export function redactActionPath(url: string): string {
  return url.replace(/\/actions\/[^/?#]+/g, '/actions/[REDACTED]');
}
