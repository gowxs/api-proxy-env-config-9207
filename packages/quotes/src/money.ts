/**
 * Money and totals for quotes. Everything is integer cents; quantities have
 * at most two decimals and are handled as hundredths, so no float ever
 * decides a cent. Rounding is half-up (amounts are never negative).
 */

export type VatMode = 'none' | 'exclusive' | 'inclusive';

export interface VatSetting {
  mode: VatMode;
  /** Percent, e.g. 21 or 5.5 (two decimals at most). */
  ratePercent: number;
}

/** "24", "24.5", "24,50", "1 234,50", "€ 1,234.50", "24.00 EUR" → cents; null if not a price. */
export function parseMoney(input: string | number): number | null {
  if (typeof input === 'number') {
    return Number.isFinite(input) && input >= 0 ? Math.round(input * 100) : null;
  }
  let s = input
    .trim()
    .replace(/[€$£]|\b(?:EUR|USD|GBP|SEK|NOK|DKK|PLN|CHF)\b/gi, '')
    .replace(/[\s\u00a0']/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const decimalAt = Math.max(lastDot, lastComma);
  // A separator followed by exactly 1–2 digits at the end is the decimal mark.
  if (decimalAt >= 0 && /^\d{1,2}$/.test(s.slice(decimalAt + 1))) {
    s = `${s.slice(0, decimalAt).replace(/[.,]/g, '')}.${s.slice(decimalAt + 1)}`;
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const [whole, frac = ''] = s.split('.');
  if (!whole || whole.length > 10) return null;
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Quantity in hundredths; null when not a positive number with at most two decimals. */
export function qtyHundredths(qty: number): number | null {
  if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) return null;
  const h = Math.round(qty * 100);
  return Math.abs(h - qty * 100) < 1e-6 && h > 0 ? h : null;
}

/** Percent → basis points (21 → 2100, 5.5 → 550). */
export const basisPoints = (percent: number) => Math.round(percent * 100);

/** Half-up integer division for non-negative numbers. */
const divRound = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));

export function lineTotalCents(qty: number, unitPriceCents: number): number {
  const h = qtyHundredths(qty);
  if (h === null) throw new Error(`invalid quantity ${qty}`);
  return divRound(h * unitPriceCents, 100);
}

export interface Totals {
  /** Sum of the lines, as priced (net for exclusive VAT, gross for inclusive). */
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
}

/**
 * VAT is computed once on the whole quote, not per line.
 * - exclusive: VAT = subtotal × rate; total = subtotal + VAT.
 * - inclusive: prices include VAT; total = subtotal; VAT = the part of it that is VAT.
 * - none: no VAT line.
 */
export function computeTotals(lineTotals: number[], vat: VatSetting): Totals {
  const subtotal = lineTotals.reduce((a, b) => a + b, 0);
  const bp = basisPoints(vat.ratePercent);
  if (vat.mode === 'exclusive') {
    const v = divRound(subtotal * bp, 10_000);
    return { subtotalCents: subtotal, vatCents: v, totalCents: subtotal + v };
  }
  if (vat.mode === 'inclusive') {
    const net = divRound(subtotal * 10_000, 10_000 + bp);
    return { subtotalCents: subtotal, vatCents: subtotal - net, totalCents: subtotal };
  }
  return { subtotalCents: subtotal, vatCents: 0, totalCents: subtotal };
}

export function formatMoney(cents: number, currency: string, locale = 'en-GB'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export const formatQty = (qty: number) =>
  Number.isInteger(qty) ? String(qty) : qty.toFixed(2).replace(/0$/, '');

/** Q-2026-0007 */
export const formatQuoteNumber = (year: number, n: number) =>
  `Q-${year}-${String(n).padStart(4, '0')}`;
