import { createHmac, timingSafeEqual } from 'node:crypto';
import { MIN_ACTION_SECRET_LENGTH } from './action-token.ts';

/**
 * Integrations waitlist (PLAN.md §23): the confirm and unsubscribe links in
 * the double opt-in e-mail. HMAC of the sign-up id and the action with the
 * action-link secret; no expiry, so an unsubscribe link always works.
 */
export type WaitlistAction = 'confirm' | 'unsubscribe';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function waitlistToken(id: string, action: WaitlistAction, secret: string): string {
  if (secret.length < MIN_ACTION_SECRET_LENGTH) throw new Error('action link secret too short');
  return createHmac('sha256', secret)
    .update(`waitlist.v1.${action}.${id}`)
    .digest('base64url')
    .slice(0, 32);
}

export function verifyWaitlistToken(
  id: string,
  action: WaitlistAction,
  token: string,
  secret: string,
): boolean {
  if (!UUID.test(id) || token.length !== 32) return false;
  const given = Buffer.from(token, 'utf8');
  const expected = Buffer.from(waitlistToken(id, action, secret), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Salted hash of the sender's IP for the waitlist row: spots abuse, identifies no one. */
export function waitlistIpHash(ip: string, secret: string): string {
  return createHmac('sha256', secret).update(`waitlist.ip.${ip}`).digest('hex');
}

/** The integrations on the waitlist, in page order. */
export const WAITLIST_INTEGRATIONS = [
  'xero',
  'quickbooks',
  'zoho_books',
  'shopify',
  'woocommerce',
] as const;
export type WaitlistIntegration = (typeof WAITLIST_INTEGRATIONS)[number];

export const INTEGRATION_NAMES: Record<WaitlistIntegration, string> = {
  xero: 'Xero',
  quickbooks: 'QuickBooks',
  zoho_books: 'Zoho Books',
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
};
