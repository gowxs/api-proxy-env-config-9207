import { getDomain } from 'tldts';

const ADDRESS_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export function isEmailAddress(value: string): boolean {
  return ADDRESS_RE.test(value.trim());
}

/** Lowercase, trimmed, with plus-addressing removed from the local part. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 1) return trimmed;
  const local = trimmed.slice(0, at).split('+')[0] ?? '';
  return `${local}@${trimmed.slice(at + 1)}`;
}

export function localPart(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? address.toLowerCase() : address.slice(0, at).toLowerCase();
}

export function hostOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at < 0 ? '' : address.slice(at + 1).toLowerCase();
}

/** Registrable domain using the Public Suffix List (mail.shop.co.uk -> shop.co.uk). */
export function organizationDomain(address: string): string {
  const host = hostOf(address);
  return getDomain(host, { allowPrivateDomains: true }) ?? host;
}

export function sameOrganization(a: string, b: string): boolean {
  return organizationDomain(a) === organizationDomain(b);
}
