import { computeTotals, lineTotalCents, qtyHundredths, type VatMode } from '@noctiv/quotes';
import type { InvoiceData } from './schema.ts';

export interface InvoiceTotals {
  /** Per line; null while the line is incomplete. */
  lineTotals: (number | null)[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
}

/**
 * Invoice totals in integer cents, VAT once per invoice (as for quotes).
 * Reverse charge: no VAT at all; the prices are net.
 */
export function invoiceTotals(
  d: InvoiceData,
  vat: { mode: VatMode; ratePercent: number },
): InvoiceTotals {
  const lineTotals = d.lines.map((l) =>
    l.qty !== null && l.unitPriceCents !== null && qtyHundredths(l.qty) !== null
      ? lineTotalCents(l.qty, l.unitPriceCents)
      : null,
  );
  const t = computeTotals(
    lineTotals.filter((x): x is number => x !== null),
    d.reverseCharge ? { mode: 'none', ratePercent: 0 } : vat,
  );
  return { lineTotals, ...t };
}
