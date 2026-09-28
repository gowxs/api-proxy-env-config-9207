import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Signed links for Bookings (PLAN.md §29), HMAC-SHA256 with the action-link
 * secret. Each kind has its own version prefix, so one can never be used as
 * another (or as a quote or approval link):
 *
 *   c1  calendar OAuth state: tenant, owner, 10 minutes
 *   b1  a customer's manage link: tenant, booking, until the meeting ends
 *   r1  the booking link in a reply: tenant, lead, thread, language, 30 days
 *   f1  an intake form link: tenant, form, and optionally lead and thread
 */
export type LinkKind = 'c1' | 'b1' | 'r1' | 'f1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TOKEN = 500;

export interface CalendarStateClaims {
  tenantId: string;
  userId: string;
  expiresAt: Date;
}
export interface ManageClaims {
  tenantId: string;
  bookingId: string;
  expiresAt: Date;
}
export interface ReplyLinkClaims {
  tenantId: string;
  leadId: string | null;
  threadId: string | null;
  language: string | null;
  expiresAt: Date;
}
export interface FormLinkClaims {
  tenantId: string;
  formId: string;
  leadId: string | null;
  threadId: string | null;
  expiresAt: Date | null;
}

export type LinkResult<T> = { ok: true; claims: T } | { ok: false; reason: 'invalid' | 'expired' };

const mac = (secret: string, data: string) =>
  createHmac('sha256', secret).update(data).digest('base64url');

function sign(kind: LinkKind, payload: Record<string, unknown>, secret: string): string {
  if (secret.length < 32) throw new Error('link secret too short');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const data = `${kind}.${body}`;
  return `${data}.${mac(secret, data)}`;
}

function read(kind: LinkKind, token: string, secret: string): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length > MAX_TOKEN) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== kind) return null;
  const expected = Buffer.from(mac(secret, `${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]!);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    return p && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const uuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const optUuid = (v: unknown): v is string | undefined => v === undefined || uuid(v);
const seconds = (d: Date) => Math.floor(d.getTime() / 1000);

function expiry(e: unknown, now: Date): Date | 'expired' | null {
  if (typeof e !== 'number' || !Number.isFinite(e)) return null;
  const at = new Date(e * 1000);
  return at <= now ? 'expired' : at;
}

export function signCalendarState(
  c: { tenantId: string; userId: string },
  secret: string,
  now = new Date(),
): string {
  return sign('c1', { t: c.tenantId, u: c.userId, e: seconds(now) + 600 }, secret);
}
export function verifyCalendarState(
  token: string,
  secret: string,
  now = new Date(),
): LinkResult<CalendarStateClaims> {
  const p = read('c1', token, secret);
  if (!p || !uuid(p.t) || !uuid(p.u)) return { ok: false, reason: 'invalid' };
  const e = expiry(p.e, now);
  if (!e) return { ok: false, reason: 'invalid' };
  if (e === 'expired') return { ok: false, reason: 'expired' };
  return { ok: true, claims: { tenantId: p.t, userId: p.u, expiresAt: e } };
}

/** Valid until the meeting ends: a past meeting can't be changed. */
export function signManageToken(
  c: { tenantId: string; bookingId: string; endsAt: Date },
  secret: string,
): string {
  return sign('b1', { t: c.tenantId, b: c.bookingId, e: seconds(c.endsAt) }, secret);
}
export function verifyManageToken(
  token: string,
  secret: string,
  now = new Date(),
): LinkResult<ManageClaims> {
  const p = read('b1', token, secret);
  if (!p || !uuid(p.t) || !uuid(p.b)) return { ok: false, reason: 'invalid' };
  const e = expiry(p.e, now);
  if (!e) return { ok: false, reason: 'invalid' };
  if (e === 'expired') return { ok: false, reason: 'expired' };
  return { ok: true, claims: { tenantId: p.t, bookingId: p.b, expiresAt: e } };
}

export const REPLY_LINK_DAYS = 30;
export function signReplyLink(
  c: {
    tenantId: string;
    leadId?: string | null;
    threadId?: string | null;
    language?: string | null;
  },
  secret: string,
  now = new Date(),
): string {
  return sign(
    'r1',
    {
      t: c.tenantId,
      ...(c.leadId ? { l: c.leadId } : {}),
      ...(c.threadId ? { h: c.threadId } : {}),
      ...(c.language ? { g: c.language.slice(0, 5) } : {}),
      e: seconds(now) + REPLY_LINK_DAYS * 86_400,
    },
    secret,
  );
}
export function verifyReplyLink(
  token: string,
  secret: string,
  now = new Date(),
): LinkResult<ReplyLinkClaims> {
  const p = read('r1', token, secret);
  if (!p || !uuid(p.t) || !optUuid(p.l) || !optUuid(p.h)) return { ok: false, reason: 'invalid' };
  if (p.g !== undefined && (typeof p.g !== 'string' || !/^[a-z]{2}$/.test(p.g)))
    return { ok: false, reason: 'invalid' };
  const e = expiry(p.e, now);
  if (!e) return { ok: false, reason: 'invalid' };
  if (e === 'expired') return { ok: false, reason: 'expired' };
  return {
    ok: true,
    claims: {
      tenantId: p.t,
      leadId: p.l ?? null,
      threadId: p.h ?? null,
      language: (p.g as string | undefined) ?? null,
      expiresAt: e,
    },
  };
}

/** A general form link (for the website) has no lead and no expiry. */
export function signFormLink(
  c: {
    tenantId: string;
    formId: string;
    leadId?: string | null;
    threadId?: string | null;
    expiresAt?: Date | null;
  },
  secret: string,
): string {
  return sign(
    'f1',
    {
      t: c.tenantId,
      f: c.formId,
      ...(c.leadId ? { l: c.leadId } : {}),
      ...(c.threadId ? { h: c.threadId } : {}),
      ...(c.expiresAt ? { e: seconds(c.expiresAt) } : {}),
    },
    secret,
  );
}
export function verifyFormLink(
  token: string,
  secret: string,
  now = new Date(),
): LinkResult<FormLinkClaims> {
  const p = read('f1', token, secret);
  if (!p || !uuid(p.t) || !uuid(p.f) || !optUuid(p.l) || !optUuid(p.h))
    return { ok: false, reason: 'invalid' };
  let expiresAt: Date | null = null;
  if (p.e !== undefined) {
    const e = expiry(p.e, now);
    if (!e) return { ok: false, reason: 'invalid' };
    if (e === 'expired') return { ok: false, reason: 'expired' };
    expiresAt = e;
  }
  return {
    ok: true,
    claims: {
      tenantId: p.t,
      formId: p.f,
      leadId: p.l ?? null,
      threadId: p.h ?? null,
      expiresAt,
    },
  };
}
