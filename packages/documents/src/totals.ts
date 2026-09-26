import {
  basisPoints,
  computeTotals,
  lineTotalCents,
  qtyHundredths,
  type VatMode,
} from '@noctiv/quotes';

export interface PricedLine {
  qty: number | null;
  unitPriceCents: number | null;
}

export interface DocumentTotals {
  /** The unit price printed on each line (net under reverse charge); null while incomplete. */
  unitPrices: (number | null)[];
  /** Per line; null while the line is incomplete. */
  lineTotals: (number | null)[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
}
/** The same totals, named for invoice call sites. */
export type InvoiceTotals = DocumentTotals;

const divRound = (n: number, d: number) => Math.floor((2 * n + d) / (2 * d));

/**
 * Totals in integer cents, VAT once per document (as for quotes).
 *
 * Reverse charge: the buyer accounts for the VAT, so the document carries
 * net prices and no VAT. When the business's prices include VAT, each unit
 * price is recalculated to net first (price × 100 / (100 + rate), rounded
 * half-up to the cent), and the line totals follow from those net prices,
 * so every line still reads qty × unit price = line total.
 */
export function documentTotals(
  lines: PricedLine[],
  vat: { mode: VatMode; ratePercent: number; reverseCharge?: boolean },
): DocumentTotals {
  const bp = basisPoints(vat.ratePercent);
  const toNet = vat.reverseCharge && vat.mode === 'inclusive';
  const unitPrices = lines.map((l) =>
    l.unitPriceCents === null
      ? null
      : toNet
        ? divRound(l.unitPriceCents * 10_000, 10_000 + bp)
        : l.unitPriceCents,
  );
  const lineTotals = lines.map((l, i) =>
    l.qty !== null && unitPrices[i] !== null && qtyHundredths(l.qty) !== null
      ? lineTotalCents(l.qty, unitPrices[i]!)
      : null,
  );
  const t = computeTotals(
    lineTotals.filter((x): x is number => x !== null),
    vat.reverseCharge ? { mode: 'none', ratePercent: 0 } : vat,
  );
  return { unitPrices, lineTotals, ...t };
}

/** Invoice totals (the invoice's own reverse-charge flag applies). */
export const invoiceTotals = (
  d: { lines: PricedLine[]; reverseCharge: boolean },
  vat: { mode: VatMode; ratePercent: number },
): DocumentTotals => documentTotals(d.lines, { ...vat, reverseCharge: d.reverseCharge });
