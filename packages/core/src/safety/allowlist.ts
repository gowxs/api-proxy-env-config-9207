import { findLinks, hostOfUrl, normalizeUrl } from './links.ts';

export interface Allowlist {
  /** Normalized URLs (see normalizeUrl). */
  urls: Set<string>;
  /** Hosts without www. */
  domains: Set<string>;
  /** Lower-cased addresses. */
  emails: Set<string>;
}

export interface AllowlistEntry {
  kind: 'url' | 'domain' | 'email';
  value: string;
}

export function emptyAllowlist(): Allowlist {
  return { urls: new Set(), domains: new Set(), emails: new Set() };
}

/**
 * Everything linkable that the tenant's knowledge base mentions. Stored in
 * kb_allowlist at ingest time (step 5); the reply sanitizer only lets these
 * through.
 */
export function extractAllowlistEntries(text: string): AllowlistEntry[] {
  const entries = new Map<string, AllowlistEntry>();
  const add = (e: AllowlistEntry) => entries.set(`${e.kind}:${e.value}`, e);
  for (const link of findLinks(text)) {
    if (link.kind === 'email') {
      add({ kind: 'email', value: link.value.toLowerCase() });
    } else if (link.kind === 'url' || link.kind === 'domain') {
      const url = normalizeUrl(link.value);
      const host = hostOfUrl(link.value);
      if (url) add({ kind: 'url', value: url });
      if (host) add({ kind: 'domain', value: host });
    }
    // Obfuscated addresses are never allowlisted.
  }
  return [...entries.values()];
}

export function buildAllowlist(entries: AllowlistEntry[]): Allowlist {
  const list = emptyAllowlist();
  for (const e of entries) {
    if (e.kind === 'url') list.urls.add(e.value);
    else if (e.kind === 'domain') list.domains.add(e.value);
    else list.emails.add(e.value);
  }
  return list;
}
