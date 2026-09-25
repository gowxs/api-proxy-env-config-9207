import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * The customer's "Approve quote" link: HMAC-SHA256 over tenant, quote and
 * expiry (the quote's validity plus 30 days, so an expired quote can still
 * say so). Uses the same secret as the owner's action links, with its own
 * version prefix so the two can never be swapped.
 */
const VERSION = 'q1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const QUOTE_LINK_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export interface QuoteClaims {
  tenantId: string;
  quoteId: string;
  expiresAt: Date;
}

const mac = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('base64url');

export function signQuoteToken(
  c: { tenantId: string; quoteId: string; validUntil: Date },
  secret: string,
): string {
  if (secret.length < 32) throw new Error('quote link secret too short');
  const payload = Buffer.from(
    JSON.stringify({
      t: c.tenantId,
      q: c.quoteId,
      e: Math.floor((c.validUntil.getTime() + QUOTE_LINK_GRACE_MS) / 1000),
    }),
  ).toString('base64url');
  const data = `${VERSION}.${payload}`;
  return `${data}.${mac(secret, data)}`;
}

export type QuoteTokenResult =
  { ok: true; claims: QuoteClaims } | { ok: false; reason: 'invalid' | 'expired' };

export function verifyQuoteToken(
  token: string,
  secret: string,
  now = new Date(),
): QuoteTokenResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION || token.length > 400)
    return { ok: false, reason: 'invalid' };
  const expected = Buffer.from(mac(secret, `${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected))
    return { ok: false, reason: 'invalid' };
  let p: { t?: unknown; q?: unknown; e?: unknown };
  try {
    p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (
    typeof p.t !== 'string' ||
    !UUID.test(p.t) ||
    typeof p.q !== 'string' ||
    !UUID.test(p.q) ||
    typeof p.e !== 'number'
  )
    return { ok: false, reason: 'invalid' };
  const expiresAt = new Date(p.e * 1000);
  if (expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true, claims: { tenantId: p.t, quoteId: p.q, expiresAt } };
}
