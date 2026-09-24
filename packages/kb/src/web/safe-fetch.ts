import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch, type Dispatcher } from 'undici';

/**
 * Outbound HTTP for tenant-supplied URLs (website crawling). Tenants choose
 * the URL, so this must not become a way into our own network (SSRF):
 *  - http/https only, default ports only, no credentials in the URL;
 *  - every connection's resolved IP must be public unicast — checked at
 *    connect time, so DNS rebinding between check and use does not help;
 *  - redirects are followed manually (max 5) and re-validated;
 *  - response size and time are capped.
 */

export class BlockedUrlError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`blocked url: ${reason}`);
    this.reason = reason;
    this.name = 'BlockedUrlError';
  }
}

export interface SafeFetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  userAgent?: string;
  /** Tests only: allow loopback/private targets and non-default ports. */
  allowPrivateNetworks?: boolean;
  /** Tests only: replace DNS resolution. */
  lookup?: typeof dnsLookup;
}

export interface SafeResponse {
  url: string;
  status: number;
  contentType: string;
  body: Uint8Array;
}

export const USER_AGENT = 'NoctivBot/1.0 (+https://noctiv.io/bot)';

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress())
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === 'unicast';
}

export function assertFetchableUrl(raw: string, allowPrivate = false): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedUrlError('malformed');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError('scheme');
  if (url.username || url.password) throw new BlockedUrlError('credentials');
  if (!allowPrivate && url.port && url.port !== '80' && url.port !== '443')
    throw new BlockedUrlError('port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate) {
    if (ipaddr.isValid(host) && !isPublicAddress(host))
      throw new BlockedUrlError('private_address');
    if (
      /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata(\.google\.internal)?)$/i.test(host)
    ) {
      throw new BlockedUrlError('private_hostname');
    }
  }
  return url;
}

function guardedLookup(base: typeof dnsLookup, allowPrivate: boolean): LookupFunction {
  return (hostname, options, callback) => {
    base(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = (addresses as unknown as LookupAddress[]) ?? [];
      const bad = list.find((a) => !allowPrivate && !isPublicAddress(a.address));
      if (bad || list.length === 0) {
        return callback(new BlockedUrlError('resolves_to_private_address'), '', 0);
      }
      if ((options as { all?: boolean }).all)
        return (callback as unknown as (e: null, a: LookupAddress[]) => void)(null, list);
      return callback(null, list[0]!.address, list[0]!.family);
    });
  };
}

export function createSafeFetcher(opts: SafeFetchOptions = {}) {
  const allowPrivate = opts.allowPrivateNetworks ?? false;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.maxRedirects ?? 5;
  const dispatcher: Dispatcher = new Agent({
    connect: { lookup: guardedLookup(opts.lookup ?? dnsLookup, allowPrivate), timeout: timeoutMs },
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
  });

  return async function safeFetch(
    raw: string,
    accept = 'text/html,text/plain;q=0.9',
  ): Promise<SafeResponse> {
    let url = assertFetchableUrl(raw, allowPrivate);
    for (let hop = 0; ; hop++) {
      let res;
      try {
        res = await fetch(url, {
          dispatcher,
          redirect: 'manual',
          headers: { 'user-agent': opts.userAgent ?? USER_AGENT, accept },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const cause = (e as { cause?: unknown }).cause;
        if (cause instanceof BlockedUrlError) throw cause;
        throw e;
      }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        await res.body?.cancel();
        if (hop >= maxRedirects) throw new BlockedUrlError('too_many_redirects');
        url = assertFetchableUrl(
          new URL(res.headers.get('location')!, url).toString(),
          allowPrivate,
        );
        continue;
      }
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) {
        await res.body?.cancel();
        throw new BlockedUrlError('too_large');
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      for await (const chunk of res.body ?? []) {
        total += chunk.byteLength;
        if (total > maxBytes) throw new BlockedUrlError('too_large');
        chunks.push(chunk);
      }
      return {
        url: url.toString(),
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: Buffer.concat(chunks),
      };
    }
  };
}

export type SafeFetch = ReturnType<typeof createSafeFetcher>;
