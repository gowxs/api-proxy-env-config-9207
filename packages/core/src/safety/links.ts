import { parse as parseDomain } from 'tldts';

export type LinkKind = 'url' | 'domain' | 'email' | 'obfuscated_email';

export interface LinkMatch {
  kind: LinkKind;
  value: string;
  start: number;
  end: number;
}

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@(?:[\p{L}\p{N}-]+\.)+\p{L}{2,}/gu;
// "name [at] domain [dot] com", "name (at) domain (dot) com", "name at domain dot com".
const OBFUSCATED_EMAIL_RE =
  /[\p{L}\p{N}._%+-]+\s*(?:[[({]\s*(?:at|ät)\s*[\])}]|\s(?:at)\s)\s*[\p{L}\p{N}-]+(?:\s*(?:[[({]\s*(?:dot|punkt|punt|point|punto)\s*[\])}]|\s(?:dot)\s)\s*[\p{L}\p{N}-]+)+/giu;
const SCHEME_URL_RE = /(?:https?|ftp):\/\/[^\s<>"'`(){}[\]]+/giu;
const WWW_URL_RE = /(?<![\p{L}\p{N}./-])www\.[^\s<>"'`(){}[\]]+/giu;
const BARE_DOMAIN_RE =
  /(?<![\p{L}\p{N}@./-])(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+\p{L}{2,63}(?:\/[^\s<>"'`(){}[\]]*)?/gu;

const TRAILING_PUNCT_RE = /[.,;:!?'"»)\]]+$/u;

function trimTrailing(value: string): string {
  return value.replace(TRAILING_PUNCT_RE, '');
}

function isRealDomain(host: string): boolean {
  const info = parseDomain(host);
  return Boolean(info.domain) && info.isIcann === true;
}

function collect(
  re: RegExp,
  text: string,
  kind: LinkKind,
  validate?: (v: string) => boolean,
): LinkMatch[] {
  const out: LinkMatch[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const value = kind === 'obfuscated_email' ? m[0] : trimTrailing(m[0]);
    if (validate && !validate(value)) continue;
    out.push({ kind, value, start: m.index, end: m.index + value.length });
  }
  return out;
}

/**
 * Finds every URL, bare domain and email address (including obfuscated forms)
 * in text. Overlapping matches are resolved in favour of the earliest, then
 * longest, so "info@shop.com" is one email, not an email plus a domain.
 */
export function findLinks(text: string): LinkMatch[] {
  const candidates = [
    ...collect(OBFUSCATED_EMAIL_RE, text, 'obfuscated_email'),
    ...collect(EMAIL_RE, text, 'email'),
    ...collect(SCHEME_URL_RE, text, 'url'),
    ...collect(WWW_URL_RE, text, 'url'),
    ...collect(BARE_DOMAIN_RE, text, 'domain', (v) => isRealDomain(v.split('/')[0]!)),
  ].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));

  const chosen: LinkMatch[] = [];
  let cursor = -1;
  for (const c of candidates) {
    if (c.start < cursor) continue;
    chosen.push(c);
    cursor = c.end;
  }
  return chosen;
}

/** Canonical form used for allowlist comparison: host without www, no trailing slash, no fragment. */
export function normalizeUrl(value: string): string | null {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const path = u.pathname.replace(/\/+$/, '');
    return `${host}${path}${u.search}`;
  } catch {
    return null;
  }
}

export function hostOfUrl(value: string): string | null {
  const n = normalizeUrl(value);
  return n ? n.split(/[/?]/)[0]! : null;
}
