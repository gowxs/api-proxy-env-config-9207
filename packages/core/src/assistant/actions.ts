import { findNumbers } from '../claims/numbers.ts';
import { foldForMatching } from '../text/normalize.ts';
import { parseAmountToCents, type AssistantEvidence, type AssistantStep } from './proposals.ts';

/**
 * Noctiv Assistant action cards (PLAN.md §27.2): a document, an e-mail, a
 * payment. The worker looks up the business's data (customers, price list,
 * documents); these rules decide what may go on a card. Every number comes
 * from the owner's own words or the price list; the customer is one the
 * owner named; the API applies a card only when the owner confirms it.
 */

export interface AssistantCustomer {
  leadId: string | null;
  name: string;
  email: string;
  /** From the customer's latest document, or as the owner wrote it. */
  address: string;
  regNo: string;
  vatNo: string;
  /** The customer's latest conversation (the document is linked to it). */
  threadId: string | null;
}

export interface PriceListEntry {
  name: string;
  unit: string;
  unitPriceCents: number;
}

export interface DocumentLine {
  name: string;
  unit: string;
  qty: number;
  unitPriceCents: number | null;
}

export interface DocumentDraft {
  docType: 'invoice' | 'delivery_note';
  buyer: AssistantCustomer;
  lines: DocumentLine[];
  /** Delivery notes: prices shown (pavadzīme-rēķins) when every line has one. */
  withPrices: boolean;
  dueDate: string | null;
}

export type DraftResult<T> = { ok: true; value: T } | { ok: false; reason: string };

type Proposal = AssistantStep['proposals'][number];

/** "1", "2,5", "10" → a positive quantity; null when not a plain number. */
function parseQty(raw: string): number | null {
  const s = raw.trim().replace(',', '.');
  if (!/^\d{1,7}(\.\d{1,3})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}

const fold = (s: string) => foldForMatching(s).replace(/\s+/g, ' ').trim();

/** The price-list entry a line names (exact, or one name contains the other). */
export function priceListMatch(name: string, list: PriceListEntry[]): PriceListEntry | null {
  const n = fold(name);
  if (!n) return null;
  return (
    list.find((i) => fold(i.name) === n) ??
    list.find((i) => fold(i.name).includes(n) || n.includes(fold(i.name))) ??
    null
  );
}

/** YYYY-MM-DD plus days (calendar days). */
export function addDaysIso(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** True when the owner named this customer (so text from a customer's e-mail cannot pick one). */
export function ownerNamed(customer: string, ownerText: string): boolean {
  const c = fold(customer);
  return c.length >= 2 && fold(ownerText).includes(c);
}

/**
 * An invoice or delivery note from the owner's words. Prices: the owner's
 * own numbers, or the price list (by line name). Quantity 1 when none is
 * given; any other quantity must be the owner's. Due date: the owner's
 * days or date, else the business's default.
 */
export function draftDocument(
  p: Proposal,
  ctx: {
    evidence: AssistantEvidence;
    customer: AssistantCustomer | null;
    priceList: PriceListEntry[];
    today: string;
    defaultDueDays: number;
  },
): DraftResult<DocumentDraft> {
  const docType = p.doc_type.trim();
  if (docType !== 'invoice' && docType !== 'delivery_note')
    return { ok: false, reason: 'document type' };
  if (!ctx.customer) return { ok: false, reason: 'customer' };
  // A document is issued with the buyer's address: without one it could only be a draft.
  if (!ctx.customer.address.trim()) return { ok: false, reason: 'address' };
  const lines: DocumentLine[] = [];
  for (const i of p.items.slice(0, 30)) {
    const name = i.name.trim().slice(0, 200);
    if (!name) continue;
    const listed = priceListMatch(name, ctx.priceList);
    // Numbers in a line's name are the owner's, or the price list's own name.
    const nameNumbers = findNumbers(foldForMatching(name)).filter(
      (n) => !n.readings.some((r) => ctx.evidence.has(Number(r), true)),
    );
    if (nameNumbers.length && !(listed && fold(listed.name) === fold(name)))
      return { ok: false, reason: `line name ${name}` };
    const qty = i.qty.trim() ? parseQty(i.qty) : 1;
    if (qty === null || (qty !== 1 && !ctx.evidence.has(qty, true)))
      return { ok: false, reason: `quantity ${i.qty}` };
    let cents: number | null = null;
    if (i.price.trim()) {
      cents = parseAmountToCents(i.price);
      if (cents === null) return { ok: false, reason: `price ${i.price}` };
      const fromOwner = ctx.evidence.has(cents / 100, true);
      const fromList = listed?.unitPriceCents === cents;
      if (!fromOwner && !fromList) return { ok: false, reason: `price ${i.price}` };
    } else if (listed) {
      cents = listed.unitPriceCents;
    } else if (docType === 'invoice') {
      return { ok: false, reason: `no price for ${name}` };
    }
    lines.push({
      name,
      unit: (i.unit.trim() || listed?.unit || 'pcs').slice(0, 30),
      qty,
      unitPriceCents: cents,
    });
  }
  if (!lines.length) return { ok: false, reason: 'no lines' };
  const withPrices = lines.every((l) => l.unitPriceCents !== null);

  let dueDate: string | null = null;
  if (docType === 'invoice' || withPrices) {
    const days = p.due_in_days.trim();
    const date = p.due_date.trim();
    if (days) {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 0 || n > 365 || !ctx.evidence.has(n, true))
        return { ok: false, reason: `due in ${days}` };
      dueDate = addDaysIso(ctx.today, n);
    } else if (date) {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
      const valid = m && !Number.isNaN(Date.parse(`${date}T12:00:00Z`));
      // The day of the month is the owner's (a date they wrote), and it is not in the past.
      if (!valid || date < ctx.today || !ctx.evidence.has(Number(m![3]), true))
        return { ok: false, reason: `due date ${date}` };
      dueDate = date;
    } else {
      dueDate = addDaysIso(ctx.today, ctx.defaultDueDays);
    }
  }
  return {
    ok: true,
    value: { docType, buyer: ctx.customer, lines, withPrices, dueDate },
  };
}

/** The e-mail's own text: short, and every number backed by the evidence. */
export function checkEmailText(
  p: Proposal,
  evidence: AssistantEvidence,
): DraftResult<{ subject: string; body: string }> {
  const subject = p.email_subject.trim().replace(/\s+/g, ' ');
  const body = p.email_body.trim();
  if (!subject || subject.length > 200) return { ok: false, reason: 'subject' };
  if (!body || body.length > 5000) return { ok: false, reason: 'body' };
  const unsupported = evidence.unsupportedIn(`${subject}\n${body}`);
  if (unsupported.length) return { ok: false, reason: `numbers ${unsupported.join(', ')}` };
  return { ok: true, value: { subject, body } };
}

/** "INV-2026-0003", "inv 2026 0003", "0003" → a comparable key. */
export const documentNumberKey = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
