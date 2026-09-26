import { z } from 'zod';
import { numbersIn } from './prefill.ts';

/**
 * Incoming payments (PLAN.md §22.9): a credit notification from the
 * business's bank is read (amount, currency, payer, reference) and matched
 * to open invoices. Same rule as everywhere: every value must be written in
 * the bank's e-mail; the model only points at it, code reads it.
 */

// ------------------------------------------------------------ bank senders

export const domainOf = (address: string) => address.split('@')[1]?.trim().toLowerCase() ?? '';

/** The listed domain itself or a subdomain of it (alerts@notify.swedbank.lv for swedbank.lv). */
export function bankDomainFor(fromAddress: string, listed: string[]): string | null {
  const d = domainOf(fromAddress);
  if (!d) return null;
  return listed.find((b) => d === b || d.endsWith(`.${b}`)) ?? null;
}

/** Normalises what the owner typed: "https://www.Swedbank.lv/" → "swedbank.lv". */
export function normalizeBankDomain(input: string): string | null {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^.*@/, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d) &&
    d.length <= 253
    ? d
    : null;
}

/**
 * Is the message really from that domain? Only the receiving provider's own
 * verdict counts: the topmost Authentication-Results header must show DKIM
 * passing for the bank's domain (or a subdomain), or DMARC passing for it.
 * A forged "From: bank" fails here; so does a message with no verdict.
 */
export function senderVerified(
  authResults: string | string[] | undefined,
  domain: string,
): boolean {
  const top = Array.isArray(authResults) ? authResults[0] : authResults;
  if (!top) return false;
  const h = top.toLowerCase();
  const matches = (d: string | undefined) => !!d && (d === domain || d.endsWith(`.${domain}`));
  for (const m of h.matchAll(/\bdkim=pass\b[^;]*?\bheader\.(?:d|i)=@?([a-z0-9.-]+)/g))
    if (matches(m[1])) return true;
  for (const m of h.matchAll(/\bdmarc=pass\b[^;]*?\bheader\.from=([a-z0-9.-]+)/g))
    if (matches(m[1])) return true;
  return false;
}

// --------------------------------------------------------------- extraction

const field = z.strictObject({
  value: z.string().trim().max(200),
  source: z.string().trim().max(300),
});

export const PaymentExtractionSchema = z.strictObject({
  /** Money came in (a credit to the business's account), not a debit, statement or ad. */
  credit: z.boolean(),
  amount: field.nullable(),
  currency: field.nullable(),
  payer_name: field.nullable(),
  reference: field.nullable(),
});
export type PaymentExtraction = z.infer<typeof PaymentExtractionSchema>;

export function buildPaymentPrompt(input: { emailBlock: string; emailRule: string }): {
  system: string;
  parts: { kind: 'untrusted_email'; text: string }[];
} {
  const system = [
    'You read a notification e-mail from a bank to its business customer. You only copy; you never invent or calculate.',
    input.emailRule,
    'credit: true only if it says money was received into the account (an incoming transfer or credit). Debits, card payments, statements, security notices and marketing are false.',
    'For amount, currency, payer_name (who sent the money) and reference (the payment details / purpose / message the payer wrote), give {value, source}: value as written; source = the exact words of the e-mail that contain it (copied character for character, at most 25 words). Use null when the e-mail does not state it.',
    'Output a single JSON object with exactly these keys: credit, amount, currency, payer_name, reference.',
  ].join('\n');
  return { system, parts: [{ kind: 'untrusted_email', text: input.emailBlock }] };
}

const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

const SYMBOLS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP' };
const CODES = ['EUR', 'USD', 'GBP', 'SEK', 'NOK', 'DKK', 'PLN', 'CHF', 'CZK', 'HUF'];

function currencyIn(text: string): string | null {
  const found = new Set<string>();
  for (const [sym, code] of Object.entries(SYMBOLS)) if (text.includes(sym)) found.add(code);
  for (const m of text.toUpperCase().matchAll(/\b([A-Z]{3})\b/g))
    if (CODES.includes(m[1]!)) found.add(m[1]!);
  return found.size === 1 ? [...found][0]! : null;
}

export interface ReadPayment {
  amountCents: number;
  currency: string | null;
  payerName: string | null;
  reference: string | null;
  sources: Record<string, string>;
}

/**
 * What the bank e-mail proves. null when it is not a credit or no amount can
 * be read from the e-mail's own text.
 */
export function readPayment(x: PaymentExtraction, emailText: string): ReadPayment | null {
  if (!x.credit || !x.amount) return null;
  const email = norm(emailText);
  const inEmail = (f: { source: string } | null) =>
    !!f && norm(f.source).length >= 2 && email.includes(norm(f.source));
  if (!inEmail(x.amount)) return null;
  const nums = numbersIn(x.amount.source);
  const claimed = Number(x.amount.value.replace(/[^\d.,]/g, '').replace(',', '.'));
  const n = nums.includes(claimed) ? claimed : nums.length === 1 ? nums[0]! : null;
  if (n === null || n <= 0) return null;
  const amountCents = Math.round(n * 100);
  if (Math.abs(amountCents - n * 100) > 1e-6) return null; // more than two decimals: not an amount

  const sources: Record<string, string> = { amount: x.amount.source };
  const text = (f: { value: string; source: string } | null, key: string) => {
    if (!f || !inEmail(f) || !f.value || !norm(f.source).includes(norm(f.value))) return null;
    sources[key] = f.source;
    return f.value.slice(0, key === 'reference' ? 300 : 200);
  };
  let currency = currencyIn(x.amount.source);
  if (!currency && x.currency && inEmail(x.currency)) {
    currency = currencyIn(x.currency.source);
    if (currency) sources.currency = x.currency.source;
  }
  return {
    amountCents,
    currency,
    payerName: text(x.payer_name, 'payer_name'),
    reference: text(x.reference, 'reference'),
    sources,
  };
}

// ----------------------------------------------------------------- matching

export interface OpenDocument {
  id: string;
  number: string;
  totalCents: number;
  currency: string;
  counterpartyName: string | null;
  /** A payment reference the owner set on the invoice (else the number is the reference). */
  paymentReference: string | null;
}

export type PaymentMatch =
  { kind: 'exact' | 'amount' | 'payer'; documentId: string } | { kind: null; documentId: null };

const compact = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toUpperCase();
const LEGAL_FORMS =
  /\b(sia|as|ab|oy|gmbh|ug|ag|ltd|llc|inc|bv|nv|sarl|sas|sa|sl|srl|spa|oü|uab)\b/gi;
const nameKey = (s: string) => compact(s.replace(LEGAL_FORMS, ''));

/**
 * - exact: the amount equals an open invoice's total and the reference
 *   names its number (or its own payment reference);
 * - amount: the amount equals exactly one open invoice's total and the
 *   reference names no other open invoice;
 * - payer: the payer's name is exactly one open invoice's buyer;
 * - otherwise no match.
 * Only exact matches may be applied automatically; the rest are proposals.
 */
export function matchPayment(
  p: {
    amountCents: number;
    currency: string | null;
    payerName: string | null;
    reference: string | null;
  },
  open: OpenDocument[],
): PaymentMatch {
  const docs = open.filter((d) => !p.currency || d.currency === p.currency);
  const ref = p.reference ? compact(p.reference) : '';
  const named = (d: OpenDocument) =>
    !!ref &&
    (ref.includes(compact(d.number)) ||
      (!!d.paymentReference &&
        compact(d.paymentReference).length >= 4 &&
        ref.includes(compact(d.paymentReference))));
  if (p.currency) {
    const exact = docs.filter((d) => d.totalCents === p.amountCents && named(d));
    if (exact.length === 1) return { kind: 'exact', documentId: exact[0]!.id };
  }
  const namesAnother = docs.some((d) => named(d));
  const byAmount = docs.filter((d) => d.totalCents === p.amountCents);
  if (byAmount.length === 1 && !namesAnother)
    return { kind: 'amount', documentId: byAmount[0]!.id };
  if (p.payerName) {
    const key = nameKey(p.payerName);
    const byPayer = docs.filter((d) => {
      const b = d.counterpartyName ? nameKey(d.counterpartyName) : '';
      return key.length >= 3 && b.length >= 3 && (b === key || b.includes(key) || key.includes(b));
    });
    if (byPayer.length === 1) return { kind: 'payer', documentId: byPayer[0]!.id };
  }
  return { kind: null, documentId: null };
}
