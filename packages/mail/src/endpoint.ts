import { lookup as dnsLookup } from 'node:dns/promises';
import { isPublicAddress } from '@noctiv/core';
import { MailConnectError } from './errors.ts';
import type { ConnectOptions } from './types.ts';

const IMAP_PORTS = new Set([993, 143]);
const SMTP_PORTS = new Set([465, 587, 25]);

export interface ResolvedEndpoint {
  /** IP address we connect to (checked). */
  address: string;
  /** Original host name: TLS SNI and certificate verification use this. */
  servername: string;
  port: number;
}

/**
 * Resolves a tenant-supplied mail server once and checks every address is
 * public, then connections use that IP (with the name for TLS), so DNS
 * rebinding between check and connect cannot point us at a private network.
 */
export async function resolveMailEndpoint(
  kind: 'imap' | 'smtp',
  host: string,
  port: number,
  opts: ConnectOptions = {},
): Promise<ResolvedEndpoint> {
  const stage = kind;
  if (!opts.allowInsecure && !(kind === 'imap' ? IMAP_PORTS : SMTP_PORTS).has(port)) {
    throw new MailConnectError(
      'WRONG_PORT',
      stage,
      `port ${port} is not a standard ${kind.toUpperCase()} port`,
    );
  }
  const name = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(name) && !isIpLiteral(name))
    throw new MailConnectError('HOST_NOT_FOUND', stage);
  let addresses: { address: string }[];
  try {
    addresses = isIpLiteral(name)
      ? [{ address: name }]
      : ((await (opts.lookup
          ? promisified(opts.lookup)(name)
          : dnsLookup(name, { all: true }))) as { address: string }[]);
  } catch {
    throw new MailConnectError('HOST_NOT_FOUND', stage);
  }
  if (addresses.length === 0) throw new MailConnectError('HOST_NOT_FOUND', stage);
  if (!opts.allowInsecure && addresses.some((a) => !isPublicAddress(a.address))) {
    throw new MailConnectError('BLOCKED_ADDRESS', stage);
  }
  return { address: addresses[0]!.address, servername: name, port };
}

function isIpLiteral(s: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(s) || s.includes(':');
}

function promisified(lookup: NonNullable<ConnectOptions['lookup']>) {
  return (name: string) =>
    new Promise<{ address: string }[]>((resolve, reject) =>
      lookup(name, { all: true }, (err, addrs) =>
        err ? reject(err) : resolve(addrs as unknown as { address: string }[]),
      ),
    );
}
