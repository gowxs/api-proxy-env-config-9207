import { stripInvisible } from '../text/normalize.ts';
import type { Allowlist } from './allowlist.ts';
import { findLinks, hostOfUrl, normalizeUrl, type LinkMatch } from './links.ts';

export interface Removal {
  kind: LinkMatch['kind'] | 'invisible_characters';
  value: string;
}

export interface SanitizedReply {
  text: string;
  removed: Removal[];
}

function isAllowed(link: LinkMatch, allow: Allowlist): boolean {
  switch (link.kind) {
    case 'email':
      return allow.emails.has(link.value.toLowerCase());
    case 'url': {
      const url = normalizeUrl(link.value);
      if (!url) return false;
      if (allow.urls.has(url)) return true;
      // A bare-host link ("https://shop.com/") is fine if the domain is known.
      const host = hostOfUrl(link.value);
      return host !== null && url === host && allow.domains.has(host);
    }
    case 'domain': {
      const url = normalizeUrl(link.value);
      const host = hostOfUrl(link.value);
      if (!url || !host) return false;
      return allow.urls.has(url) || (url === host && allow.domains.has(host));
    }
    case 'obfuscated_email':
      return false;
  }
}

function tidy(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\(\s*\)/g, '$1') // markdown link whose target was removed
    .replace(/<\s*>/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/([,;:])(?:\s*[,;:])+/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

/**
 * Removes links and email addresses that do not appear in the tenant's
 * knowledge base (PLAN.md §3.5 rule 5), plus invisible characters. Anything
 * removed is reported; the policy engine then refuses to auto-send.
 */
/**
 * Citation markers ("[S1]", "[S1, S2]") belong in the "sources" list, but a
 * model sometimes also writes them into the text; they mean nothing to a
 * customer and are removed (formatting only, not a content removal).
 */
export function stripCitationMarkers(s: string): string {
  const out = s
    .replace(/[ \t]*\[\s*S\d{1,3}(?:\s*[,;]\s*S\d{1,3})*\s*\]/gi, '')
    .replace(/[ \t]+([.,;:!?])/g, '$1');
  return out === s ? s : out;
}

export function sanitizeReply(reply: string, allow: Allowlist): SanitizedReply {
  const removed: Removal[] = [];
  const stripped = stripInvisible(reply);
  if (stripped !== reply) removed.push({ kind: 'invisible_characters', value: '' });
  const visible = stripCitationMarkers(stripped);

  let out = '';
  let last = 0;
  for (const link of findLinks(visible)) {
    if (isAllowed(link, allow)) continue;
    removed.push({ kind: link.kind, value: link.value });
    out += visible.slice(last, link.start);
    last = link.end;
  }
  out += visible.slice(last);
  return { text: removed.length ? tidy(out) : visible.trim(), removed };
}
