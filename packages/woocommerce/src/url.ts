import { isIP } from 'node:net';

/**
 * The merchant types the address of their own store and Noctiv then calls it with
 * their key. That is a server-side request to a user-supplied host, so the address
 * is held to strict rules (https only, a public host name, no ports, no credentials in
 * the URL) and every connection is checked again at connect time (see http.ts).
 */
export type StoreUrlProblem = 'INVALID_URL' | 'HTTPS_REQUIRED';

const BLOCKED_SUFFIXES = [
  '.local',
  '.localhost',
  '.internal',
  '.lan',
  '.home',
  '.corp',
  '.intranet',
];

export function normalizeStoreUrl(input: string): { url: string } | { problem: StoreUrlProblem } {
  const raw = input.trim();
  if (!raw || raw.length > 300) return { problem: 'INVALID_URL' };
  if (/^http:\/\//i.test(raw)) return { problem: 'HTTPS_REQUIRED' };
  let u: URL;
  try {
    u = new URL(/^https:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { problem: 'INVALID_URL' };
  }
  if (u.protocol !== 'https:' || u.username || u.password) return { problem: 'INVALID_URL' };
  if (u.port && u.port !== '443') return { problem: 'INVALID_URL' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.includes('.') || host === 'localhost' || isIP(host) !== 0 || host.startsWith('['))
    return { problem: 'INVALID_URL' };
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return { problem: 'INVALID_URL' };
  if (!/^[a-z0-9.-]+$/.test(host)) return { problem: 'INVALID_URL' };
  // A pasted admin or REST address means the store's root; WordPress may live in a subdirectory.
  let path = u.pathname;
  const cut = path.search(/\/(wp-json|wp-admin|wp-login\.php)(\/|$)/);
  if (cut !== -1) path = path.slice(0, cut);
  path = path.replace(/\/+$/, '');
  if (path && !/^(\/[A-Za-z0-9._~-]+)+$/.test(path)) return { problem: 'INVALID_URL' };
  return { url: `https://${host}${path}` };
}

/** True only for addresses on the public internet. Private, loopback, link-local, metadata and reserved ranges are refused. */
export function isPublicAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4)
    return isPublicV4(address.split('.').map(Number) as [number, number, number, number]);
  if (v === 6) {
    const a = address.toLowerCase();
    const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (a === '::' || a === '::1') return false;
    const first = parseInt(a.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return false; // multicast
    if (a.startsWith('2001:db8:') || a.startsWith('2001:0db8:')) return false; // documentation
    if (first === 0x2002) return false; // 6to4 can embed a private v4 address
    if (a.startsWith('::ffff:')) return false; // v4-mapped in a form we did not parse
    return true;
  }
  return false;
}

function isPublicV4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
