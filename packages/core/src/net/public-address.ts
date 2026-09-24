import ipaddr from 'ipaddr.js';

/**
 * True only for public unicast addresses. Used wherever a tenant chooses a
 * host we connect to (website crawling, IMAP/SMTP servers), so that a tenant
 * cannot make our servers reach private networks or cloud metadata (SSRF).
 */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && (ip as ipaddr.IPv6).isIPv4MappedAddress())
    ip = (ip as ipaddr.IPv6).toIPv4Address();
  return ip.range() === 'unicast';
}
