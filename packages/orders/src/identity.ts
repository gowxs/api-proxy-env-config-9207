/**
 * Identity check: an order is used only when the sender's address is the
 * order's contact e-mail (what the customer typed at checkout) or the linked
 * customer's e-mail. Case-insensitive, whitespace trimmed, nothing else:
 * no dot or "+tag" folding, no domain matching.
 */
export const normalizeEmail = (s: string | null | undefined): string =>
  (s ?? '').trim().toLowerCase();

export function emailMatches(
  sender: string,
  order: { email: string | null; customerEmail: string | null },
): boolean {
  const s = normalizeEmail(sender);
  if (!s || !s.includes('@')) return false;
  return [order.email, order.customerEmail].map(normalizeEmail).includes(s);
}
