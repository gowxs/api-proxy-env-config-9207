import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The only permission Noctiv asks for. No write scope, ever. */
export const SHOPIFY_SCOPES = ['read_orders'] as const;

const eq = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Shopify signs every request it sends us (the install redirect and the OAuth
 * callback) with an HMAC-SHA256 of the sorted query string, hex, keyed with the
 * app's client secret. Pass the query as parsed key/value pairs.
 */
export function verifyQueryHmac(
  query: Record<string, string | string[] | undefined>,
  clientSecret: string,
): boolean {
  return explainQueryHmac(query, clientSecret).ok;
}

/**
 * Shopify's documentation and its libraries differ on how values enter the signed message
 * (decoded as they are, with "%" and "&" escaped, or URL-encoded), so a request is accepted
 * if the signature matches any of the three. Each is an HMAC keyed with the client secret, so
 * accepting all of them does not weaken the check. `variant` says which one matched; `names` is
 * the sorted list of parameter names that were signed (never values) for diagnosing failures.
 */
export function explainQueryHmac(
  query: Record<string, string | string[] | undefined>,
  clientSecret: string,
): {
  ok: boolean;
  reason: 'ok' | 'hmac_missing' | 'hmac_invalid';
  variant: string | null;
  names: string[];
} {
  const { hmac, signature: _signature, ...rest } = query;
  const names = Object.keys(rest).sort();
  if (typeof hmac !== 'string' || !hmac)
    return { ok: false, reason: 'hmac_missing', variant: null, names };
  const val = (k: string) => {
    const v = rest[k];
    return Array.isArray(v) ? v.join(',') : (v ?? '');
  };
  const variants: Record<string, string> = {
    decoded: names.map((k) => `${k}=${val(k)}`).join('&'),
    escaped: names
      .map(
        (k) =>
          `${k.replace(/%/g, '%25').replace(/=/g, '%3D')}=${val(k).replace(/%/g, '%25').replace(/&/g, '%26')}`,
      )
      .join('&'),
    urlencoded: new URLSearchParams(names.map((k) => [k, val(k)] as [string, string])).toString(),
  };
  for (const [variant, message] of Object.entries(variants))
    if (eq(createHmac('sha256', clientSecret).update(message).digest('hex'), hmac.toLowerCase()))
      return { ok: true, reason: 'ok', variant, names };
  return { ok: false, reason: 'hmac_invalid', variant: null, names };
}

/** Webhooks are signed with the base64 HMAC-SHA256 of the raw body (X-Shopify-Hmac-Sha256). */
export function verifyWebhookHmac(
  rawBody: Buffer | string,
  headerValue: string | undefined,
  clientSecret: string,
): boolean {
  if (!headerValue) return false;
  return eq(createHmac('sha256', clientSecret).update(rawBody).digest('base64'), headerValue);
}

export function authorizeUrl(a: {
  shop: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: readonly string[];
}): string {
  const q = new URLSearchParams({
    client_id: a.clientId,
    scope: (a.scopes ?? SHOPIFY_SCOPES).join(','),
    redirect_uri: a.redirectUri,
    state: a.state,
  });
  return `https://${a.shop}/admin/oauth/authorize?${q.toString()}`;
}

/** Short-lived signed values: the OAuth `state` and the claim that links a finished install to a Noctiv business. */
export function signToken(
  payload: Record<string, unknown>,
  secret: string,
  ttlSeconds: number,
  now = Date.now(),
): string {
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: Math.floor(now / 1000) + ttlSeconds }),
  ).toString('base64url');
  const mac = createHmac('sha256', secret).update(`shopify:${body}`).digest('base64url');
  return `${body}.${mac}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  token: string,
  secret: string,
  now = Date.now(),
): T | null {
  const [body, mac, extra] = token.split('.');
  if (!body || !mac || extra !== undefined) return null;
  if (!eq(createHmac('sha256', secret).update(`shopify:${body}`).digest('base64url'), mac))
    return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T & { exp?: number };
    return typeof p.exp === 'number' && p.exp * 1000 > now ? p : null;
  } catch {
    return null;
  }
}

export const newNonce = (): string => randomBytes(16).toString('hex');
