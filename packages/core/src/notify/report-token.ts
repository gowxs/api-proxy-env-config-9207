import { createHmac, timingSafeEqual } from 'node:crypto';
import { MIN_ACTION_SECRET_LENGTH } from './action-token.ts';

/**
 * The unsubscribe link in the Monday summary e-mail (PLAN.md §26): HMAC of
 * the tenant id with the action-link secret. No expiry, so an old e-mail's
 * link still works; it can only switch the summary off.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function weeklyReportToken(tenantId: string, secret: string): string {
  if (secret.length < MIN_ACTION_SECRET_LENGTH) throw new Error('action link secret too short');
  return createHmac('sha256', secret)
    .update(`weekly-report.v1.unsubscribe.${tenantId}`)
    .digest('base64url')
    .slice(0, 32);
}

export function verifyWeeklyReportToken(tenantId: string, token: string, secret: string): boolean {
  if (!UUID.test(tenantId) || token.length !== 32) return false;
  const given = Buffer.from(token, 'utf8');
  const expected = Buffer.from(weeklyReportToken(tenantId, secret), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
