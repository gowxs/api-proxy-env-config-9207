import { qtyHundredths, type VatMode } from '@noctiv/quotes';
import type { CmrData, DeliveryNoteData, DocData, DocType, InvoiceData } from './schema.ts';

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

const blank = (s: string | null | undefined) => !s || !s.trim();
const compact = (s: string) => s.replace(/[\s.-]/g, '').toUpperCase();

/** IBAN: country, check digits, then the ISO 13616 mod-97 check. */
export function ibanValid(raw: string): boolean {
  const s = compact(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s)) return false;
  const r = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of r) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
}

/** EU VAT number shape: two-letter country prefix and 2–13 characters (e.g. LV40003123456). */
export const vatNoValid = (raw: string) => /^[A-Z]{2}[0-9A-Z+*]{2,13}$/.test(compact(raw));

export const formatIban = (raw: string) =>
  compact(raw)
    .replace(/(.{4})/g, '$1 ')
    .trim();

function sellerProblems(s: Seller, o: { needVat: boolean; needBank: boolean }): string[] {
  const p: string[] = [];
  const where = ' (Settings → Documents)';
  if (blank(s.legalName)) p.push(`Your legal name is missing${where}`);
  if (blank(s.legalAddress)) p.push(`Your legal address is missing${where}`);
  if (o.needVat && blank(s.vatNo)) p.push(`Your VAT number is missing${where}`);
  if (!blank(s.vatNo) && !vatNoValid(s.vatNo!)) p.push(`Your VAT number looks wrong${where}`);
  if (o.needBank) {
    if (blank(s.iban)) p.push(`Your IBAN is missing${where}`);
    else if (!ibanValid(s.iban!)) p.push(`Your IBAN is not valid${where}`);
  }
  return p;
}

function invoiceProblems(
  d: InvoiceData,
  s: Seller,
  o: { vatMode: VatMode; today: string },
): string[] {
  const p = sellerProblems(s, { needVat: o.vatMode !== 'none' || d.reverseCharge, needBank: true });
  if (blank(d.buyer.name)) p.push('Buyer: name is missing');
  if (blank(d.buyer.address)) p.push('Buyer: address is missing');
  if (!blank(d.buyer.vatNo) && !vatNoValid(d.buyer.vatNo))
    p.push('Buyer: the VAT number looks wrong');
  if (d.reverseCharge) {
    if (blank(d.buyer.vatNo)) p.push('Reverse charge needs the buyer’s VAT number');
    if (o.vatMode === 'inclusive')
      p.push('Reverse charge is not available while your prices include VAT');
  }
  if (!d.lines.length) p.push('Add at least one line');
  d.lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (blank(l.name)) p.push(`${n}: item is missing`);
    if (l.qty === null || qtyHundredths(l.qty) === null)
      p.push(`${n}: quantity must be a number with at most two decimals`);
    if (l.unitPriceCents === null) p.push(`${n}: price is missing`);
  });
  if (d.dueDate && d.dueDate < o.today) p.push('The due date is in the past');
  return p;
}

function deliveryNoteProblems(d: DeliveryNoteData, s: Seller): string[] {
  const p = sellerProblems(s, { needVat: false, needBank: false });
  if (blank(d.receiver.name)) p.push('Receiver: name is missing');
  if (blank(d.receiver.address)) p.push('Receiver: address is missing');
  if (blank(d.deliveryAddress)) p.push('Delivery address is missing');
  if (!d.lines.length) p.push('Add at least one line');
  d.lines.forEach((l, i) => {
    const n = `Line ${i + 1}`;
    if (blank(l.name)) p.push(`${n}: item is missing`);
    if (l.qty === null) p.push(`${n}: quantity is missing`);
    if (blank(l.unit)) p.push(`${n}: unit is missing`);
  });
  return p;
}

/** CMR Convention art. 6(1): the particulars every consignment note must contain. */
function cmrProblems(d: CmrData): string[] {
  const p: string[] = [];
  const need = (v: string | null, what: string) => {
    if (blank(v)) p.push(what);
  };
  need(d.sender.name, 'Box 1: sender name is missing');
  need(d.sender.address, 'Box 1: sender address is missing');
  need(d.sender.country, 'Box 1: sender country is missing');
  need(d.consignee.name, 'Box 2: consignee name is missing');
  need(d.consignee.address, 'Box 2: consignee address is missing');
  need(d.consignee.country, 'Box 2: consignee country is missing');
  need(d.deliveryPlace.place, 'Box 3: place of delivery is missing');
  need(d.deliveryPlace.country, 'Box 3: country of delivery is missing');
  need(d.takingOver.place, 'Box 4: place of taking over is missing');
  need(d.takingOver.country, 'Box 4: country of taking over is missing');
  need(d.takingOver.date, 'Box 4: date of taking over is missing');
  if (!d.goods.length) p.push('Boxes 6–12: add at least one goods line');
  d.goods.forEach((g, i) => {
    const n = d.goods.length > 1 ? ` (goods line ${i + 1})` : '';
    need(g.nature, `Box 9: nature of the goods is missing${n}`);
    if (g.packages === null) p.push(`Box 7: number of packages is missing${n}`);
    if (g.grossKg === null) p.push(`Box 11: gross weight is missing${n}`);
  });
  need(d.carrier.name, 'Box 16: carrier name is missing');
  need(d.carrier.address, 'Box 16: carrier address is missing');
  need(d.establishedIn, 'Box 21: place where the note is made out is missing');
  need(d.establishedOn, 'Box 21: date the note is made out is missing');
  return p;
}

/**
 * What is still missing before a document can be issued (empty = ready).
 * Plain sentences for the owner; the PDF is only created when this is empty.
 */
export function documentProblems(
  type: DocType,
  data: DocData,
  seller: Seller,
  o: { vatMode: VatMode; today: string },
): string[] {
  if (type === 'invoice') return invoiceProblems(data as InvoiceData, seller, o);
  if (type === 'delivery_note') return deliveryNoteProblems(data as DeliveryNoteData, seller);
  return cmrProblems(data as CmrData);
}
