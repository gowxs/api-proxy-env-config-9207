/** Quotes (beta): types shared by the price list, quote list and quote editor. */

export type VatMode = 'none' | 'exclusive' | 'inclusive';

export interface QuoteSettings {
  quotes_enabled: boolean;
  quotes_currency: string;
  quotes_vat_mode: VatMode;
  quotes_vat_rate: number;
  quotes_validity_days: number;
  quotes_auto_send_limit_cents: number;
}

export interface PriceItem {
  id: string;
  name: string;
  description: string | null;
  unit: string;
  unit_price_cents: number;
  min_qty: number | null;
  max_qty: number | null;
  vat_note: string | null;
  status: 'draft' | 'confirmed' | 'archived';
  source: 'manual' | 'csv' | 'file';
}

export interface PriceImport {
  id: string;
  file_name: string;
  status: 'pending' | 'parsing' | 'ready' | 'failed';
  item_count: number;
  error: string | null;
  created_at: string;
}

export interface QuoteLine {
  id: string;
  price_item_id: string | null;
  name: string;
  unit: string;
  /** The unit as printed after the quantity ("2 boxes"). */
  unit_label?: string;
  qty: number;
  unit_price_cents: number;
  line_total_cents: number;
  customer_text: string | null;
}

export type QuoteStatus =
  'draft' | 'pending_approval' | 'sent' | 'viewed' | 'accepted' | 'expired' | 'rejected';

export interface Quote {
  id: string;
  number: string;
  status: QuoteStatus;
  thread_id: string;
  draft_id: string | null;
  customer_email: string | null;
  customer_name: string | null;
  currency: string;
  vat_mode: VatMode;
  vat_rate: number;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  valid_until: string;
  notes: string | null;
  created_at: string;
  sent_at: string | null;
  viewed_at: string | null;
  accepted_at: string | null;
  lines: QuoteLine[];
}

export const QUOTE_STATUS: Record<
  QuoteStatus,
  { text: string; tone: 'gray' | 'amber' | 'green' | 'red' | 'blue' }
> = {
  draft: { text: 'Draft', tone: 'gray' },
  pending_approval: { text: 'Waiting for approval', tone: 'amber' },
  sent: { text: 'Sent', tone: 'blue' },
  viewed: { text: 'Viewed', tone: 'blue' },
  accepted: { text: 'Accepted', tone: 'green' },
  expired: { text: 'Expired', tone: 'gray' },
  rejected: { text: 'Not sent', tone: 'gray' },
};

export function money(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export const VAT_LABEL: Record<VatMode, string> = {
  none: 'No VAT',
  exclusive: 'Prices exclude VAT (VAT added)',
  inclusive: 'Prices include VAT',
};

export const qtyText = (q: number) => (Number.isInteger(q) ? String(q) : q.toFixed(2));

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
