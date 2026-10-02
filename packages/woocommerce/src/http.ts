import { lookup as dnsLookup } from 'node:dns';
import { request } from 'node:https';
import { isPublicAddress } from './url.ts';

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}
/** One GET. Tests inject their own (a mock server over plain http); production uses safeGet. */
export type HttpGet = (url: string, headers: Record<string, string>) => Promise<HttpResult>;

export class BlockedAddressError extends Error {
  constructor() {
    super('blocked address');
    this.name = 'BlockedAddressError';
  }
}

const MAX_BYTES = 2 * 1024 * 1024;

/**
 * https GET with the protections for a user-supplied host: the address is checked at connect
 * time (no DNS-rebinding gap between "check" and "use"), redirects are never followed (a
 * redirect could carry the key elsewhere), the response is size-limited and the call times out.
 */
export const safeGet: HttpGet = (url, headers) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return reject(new BlockedAddressError());
    const req = request(
      u,
      {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'Noctiv-OrderLookup/1', ...headers },
        timeout: 10_000,
        lookup: (hostname, opts, cb) => {
          dnsLookup(hostname, { ...opts, all: true }, (err, addrs) => {
            if (err) return (cb as (e: Error) => void)(err);
            if (!addrs.length || addrs.some((a) => !isPublicAddress(a.address)))
              return (cb as (e: Error) => void)(new BlockedAddressError());
            if (opts.all) return (cb as (e: null, a: typeof addrs) => void)(null, addrs);
            return (cb as (e: null, a: string, f: number) => void)(
              null,
              addrs[0]!.address,
              addrs[0]!.family,
            );
          });
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            req.destroy(new Error('response too large'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(
              Object.entries(res.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(', ') : (v ?? ''),
              ]),
            ),
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
