/** Documents (beta): invoices, delivery notes and CMR consignment notes. */

import type { VatMode } from './quotes';

export type DocType = 'invoice' | 'delivery_note' | 'cmr';
export type DocStatus = 'draft' | 'issued' | 'sent' | 'paid' | 'delivered' | 'cancelled';

export interface Party {
  name: string;
  address: string;
  regNo: string;
  vatNo: string;
  email?: string;
}

export interface InvoiceLine {
  name: string;
  unit: string;
  qty: number | null;
  unitPriceCents: number | null;
}
export interface InvoiceData {
  buyer: Party & { email: string };
  supplyDate: string | null;
  dueDate: string | null;
  paymentReference: string;
  reverseCharge: boolean;
  lines: InvoiceLine[];
  notes: string;
}

export interface DeliveryLine {
  name: string;
  unit: string;
  qty: number | null;
}
export interface DeliveryNoteData {
  receiver: Party;
  loadingAddress: string;
  deliveryAddress: string;
  deliveryDate: string | null;
  lines: DeliveryLine[];
  vehicle: string;
  driver: string;
  notes: string;
}

export interface CmrPlace {
  name: string;
  address: string;
  country: string;
}
export interface CmrGoods {
  marks: string;
  packages: number | null;
  packing: string;
  nature: string;
  statNo: string;
  grossKg: number | null;
  volumeM3: number | null;
}
export interface CmrData {
  sender: CmrPlace;
  consignee: CmrPlace;
  deliveryPlace: { place: string; country: string };
  takingOver: { place: string; country: string; date: string | null };
  documentsAttached: string;
  goods: CmrGoods[];
  senderInstructions: string;
  carriagePayment: 'paid' | 'forward' | null;
  cashOnDelivery: string;
  carrier: CmrPlace;
  successiveCarriers: string;
  carrierReservations: string;
  specialAgreements: string;
  toBePaidBy: string;
  establishedIn: string;
  establishedOn: string | null;
  vehicleTractor: string;
  vehicleTrailer: string;
}

export interface Seller {
  legalName: string | null;
  legalAddress: string | null;
  regNo: string | null;
  vatNo: string | null;
  bankName: string | null;
  iban: string | null;
  bic: string | null;
  country: string | null;
}

interface DocBase {
  id: string;
  number: string | null;
  status: DocStatus;
  language: string;
  thread_id: string | null;
  lead_id: string | null;
  quote_id: string | null;
  source_document_id: string | null;
  draft_id: string | null;
  /** Fields the AI filled from the e-mail, with the text they were copied from. */
  prefill: Record<string, { source: string }> | null;
  prefill_status: 'pending' | 'done' | 'failed' | null;
  currency: string;
  vat_mode: VatMode;
  vat_rate: number;
  subtotal_cents: number;
  vat_cents: number;
  total_cents: number;
  counterparty_name: string | null;
  issue_date: string | null;
  due_date: string | null;
  created_at: string;
  issued_at: string | null;
  sent_at: string | null;
  paid_at: string | null;
  delivered_at: string | null;
  cancelled_at: string | null;
  /** What is still missing before the document can be issued (empty when ready). */
  problems: string[];
  seller: Seller;
}
export type Doc =
  | (DocBase & { type: 'invoice'; data: InvoiceData })
  | (DocBase & { type: 'delivery_note'; data: DeliveryNoteData })
  | (DocBase & { type: 'cmr'; data: CmrData });

export const DOC_TYPE: Record<DocType, { name: string; short: string }> = {
  invoice: { name: 'Invoice', short: 'Invoice' },
  delivery_note: { name: 'Delivery note', short: 'Delivery note' },
  cmr: { name: 'CMR consignment note', short: 'CMR' },
};

export const DOC_STATUS: Record<
  DocStatus,
  { text: string; tone: 'gray' | 'amber' | 'green' | 'red' | 'blue' }
> = {
  draft: { text: 'Draft', tone: 'amber' },
  issued: { text: 'Ready', tone: 'blue' },
  sent: { text: 'Sent', tone: 'blue' },
  paid: { text: 'Paid', tone: 'green' },
  delivered: { text: 'Delivered', tone: 'green' },
  cancelled: { text: 'Cancelled', tone: 'gray' },
};

export const DOC_LANGUAGES = [
  ['en', 'English'],
  ['de', 'Deutsch'],
  ['lv', 'Latviešu'],
  ['nl', 'Nederlands'],
  ['fr', 'Français'],
  ['es', 'Español'],
] as const;

export const editable = (s: DocStatus) => s === 'draft' || s === 'issued';

/** "24,50" / "24.50" → 2450; null when not a price. */
export function parsePrice(s: string): number | null {
  const t = s.trim().replace(/\s/g, '');
  if (!/^\d+([.,]\d{1,2})?$/.test(t)) return null;
  const [w, f = ''] = t.replace(',', '.').split('.');
  return Number(w) * 100 + Number(f.padEnd(2, '0'));
}
export const priceText = (c: number | null) => (c === null ? '' : (c / 100).toFixed(2));

/** "2,5" → 2.5; null when empty or not a number. */
export function parseNumber(s: string): number | null {
  const t = s.trim().replace(',', '.');
  if (!t || !/^\d+(\.\d{1,3})?$/.test(t)) return null;
  return Number(t);
}
