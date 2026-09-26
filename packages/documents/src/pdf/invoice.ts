import {
  formatMoney,
  formatQty,
  formatRate,
  newPdf,
  PDF_INK as INK,
  PDF_MUTED as MUTED,
  PDF_RULE as RULE,
  pdfBrandColor,
  quoteLocale,
  type VatMode,
} from '@noctiv/quotes';
import type { Seller } from '../checks.ts';
import { docLabels, type DocLabels } from '../labels.ts';
import type { DeliveryNoteData, InvoiceData } from '../schema.ts';
import type { DocumentTotals, InvoiceTotals } from '../totals.ts';
import { dateText, header, ibanText, parties, sellerLines, type PdfContext } from './common.ts';

/** Subtotal / VAT / total rows, right-aligned under the line totals; returns the next y. */
function drawTotals(
  doc: PDFKit.PDFDocument,
  y: number,
  o: {
    labels: DocLabels;
    money: (c: number) => string;
    rate: string;
    vatMode: VatMode;
    totals: DocumentTotals;
    totalX: number;
  },
): number {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const t = o.labels;
  y += 6;
  const row = (label: string, value: string, strong = false) => {
    doc
      .font(strong ? 'b' : 'r')
      .fontSize(strong ? 12 : 10)
      .fillColor(strong ? INK : MUTED)
      .text(label, L + W * 0.4, y, { width: W * 0.4, align: 'right' });
    doc.fillColor(INK).text(value, o.totalX, y, { width: W * 0.18, align: 'right' });
    y += strong ? 20 : 16;
  };
  const tt = o.totals;
  if (o.vatMode === 'none') row(t.total, o.money(tt.totalCents), true);
  else if (o.vatMode === 'exclusive') {
    row(t.subtotal, o.money(tt.subtotalCents));
    row(t.vat(o.rate), o.money(tt.vatCents));
    row(t.total, o.money(tt.totalCents), true);
  } else {
    row(t.total, o.money(tt.totalCents), true);
    row(t.ofWhichVat(o.rate), o.money(tt.vatCents));
  }
  return y;
}

/** The grey payment-details box (bank, IBAN, BIC, reference, pay-by line); returns the next y. */
function drawPayment(
  doc: PDFKit.PDFDocument,
  y: number,
  o: { labels: DocLabels; seller: Seller; reference: string; payBy: string | null; brand: string },
): number {
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const t = o.labels;
  const pay = (
    [
      [t.bank, o.seller.bankName ?? ''],
      [t.iban, ibanText(o.seller)],
      [t.bic, o.seller.bic ?? ''],
      [t.reference, o.reference],
    ] as [string, string][]
  ).filter(([, v]) => v);
  const boxH = 30 + pay.length * 14 + (o.payBy ? 16 : 0);
  doc.rect(L, y, W, boxH).fill('#F4F5F7');
  doc
    .font('s')
    .fontSize(9)
    .fillColor(MUTED)
    .text(t.paymentDetails, L + 14, y + 12);
  let py = y + 28;
  for (const [k, v] of pay) {
    doc
      .font('r')
      .fontSize(10)
      .fillColor(MUTED)
      .text(k, L + 14, py, { width: 130 });
    doc
      .font('s')
      .fillColor(INK)
      .text(v, L + 150, py, { width: W - 164 });
    py += 14;
  }
  if (o.payBy)
    doc
      .font('s')
      .fontSize(10)
      .fillColor(o.brand)
      .text(o.payBy, L + 14, py + 2, { width: W - 28 });
  return y + boxH + 16;
}

export interface InvoicePdfInput extends PdfContext {
  data: InvoiceData;
  currency: string;
  vatMode: VatMode;
  vatRatePercent: number;
  totals: InvoiceTotals;
  /** Due date as ISO (set when issued). */
  dueDate: string | null;
}

export function renderInvoicePdf(i: InvoicePdfInput): Promise<Buffer> {
  const t = docLabels(i.language);
  const { doc, done } = newPdf({
    title: `${t.invoice} ${i.number}`,
    author: i.seller.legalName ?? i.brand.companyName,
    createdAt: i.issueDate,
  });
  const brand = pdfBrandColor(i.brand.color);
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const locale = quoteLocale(i.language);
  const money = (c: number) => formatMoney(c, i.currency, locale);
  const d = i.data;
  doc.rect(0, 0, doc.page.width, 6).fill(brand);

  let y = header(doc, i, t.invoice, [
    [t.date, dateText(i.issueDate, i.language)],
    ...(d.supplyDate
      ? ([[t.supplyDate, dateText(d.supplyDate, i.language)]] as [string, string][])
      : []),
    [t.dueDate, dateText(i.dueDate, i.language)],
  ]);
  y = parties(
    doc,
    y,
    { label: t.seller, lines: sellerLines(i.seller, t.regNo, t.vatNo) },
    {
      label: t.buyer,
      lines: [
        d.buyer.name,
        d.buyer.address,
        d.buyer.regNo ? `${t.regNo} ${d.buyer.regNo}` : '',
        d.buyer.vatNo ? `${t.vatNo} ${d.buyer.vatNo}` : '',
      ],
    },
  );

  // Lines.
  const col = { item: L, qty: L + W * 0.46, unit: L + W * 0.64, total: L + W * 0.82 };
  const head = () => {
    doc.font('s').fontSize(9).fillColor(MUTED);
    doc.text(t.item, col.item, y);
    doc.text(t.qty, col.qty, y, { width: W * 0.16, align: 'right' });
    doc.text(t.unitPrice, col.unit, y, { width: W * 0.16, align: 'right' });
    doc.text(t.lineTotal, col.total, y, { width: W * 0.18, align: 'right' });
    y += 16;
    doc
      .moveTo(L, y)
      .lineTo(L + W, y)
      .strokeColor(RULE)
      .lineWidth(1)
      .stroke();
    y += 8;
  };
  head();
  d.lines.forEach((l, n) => {
    const h = doc
      .font('r')
      .fontSize(10)
      .heightOfString(l.name, { width: W * 0.44 });
    if (y + h + 12 > doc.page.height - 220) {
      doc.addPage();
      y = 56;
      head();
    }
    doc
      .font('r')
      .fontSize(10)
      .fillColor(INK)
      .text(l.name, col.item, y, { width: W * 0.44 });
    doc.text(`${l.qty === null ? '' : formatQty(l.qty, locale)} ${l.unit}`.trim(), col.qty, y, {
      width: W * 0.16,
      align: 'right',
    });
    const up = i.totals.unitPrices[n];
    doc.text(up === null || up === undefined ? '' : money(up), col.unit, y, {
      width: W * 0.16,
      align: 'right',
    });
    const lt = i.totals.lineTotals[n];
    doc.text(lt === null || lt === undefined ? '' : money(lt), col.total, y, {
      width: W * 0.18,
      align: 'right',
    });
    y += h + 10;
    doc
      .moveTo(L, y - 4)
      .lineTo(L + W, y - 4)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
  });

  y = drawTotals(doc, y, {
    labels: t,
    money,
    rate: formatRate(i.vatRatePercent, i.language),
    vatMode: d.reverseCharge ? 'none' : i.vatMode,
    totals: i.totals,
    totalX: col.total,
  });
  if (d.reverseCharge) {
    y += 4;
    doc.font('s').fontSize(9).fillColor(INK).text(t.reverseCharge, L, y, { width: W });
    y = doc.y + 8;
  }
  y = drawPayment(doc, y + 10, {
    labels: t,
    seller: i.seller,
    reference: d.paymentReference || i.number,
    payBy: t.payBy(dateText(i.dueDate, i.language)),
    brand,
  });

  if (d.notes.trim()) {
    doc.font('s').fontSize(9).fillColor(MUTED).text(t.notes, L, y);
    doc
      .font('r')
      .fontSize(10)
      .fillColor(INK)
      .text(d.notes, L, y + 14, { width: W });
  }
  doc.end();
  return done;
}

export interface DeliveryNotePdfInput extends PdfContext {
  data: DeliveryNoteData;
  /** Pavadzīme-rēķins: prices, totals and payment details. */
  priced?: {
    currency: string;
    vatMode: VatMode;
    vatRatePercent: number;
    totals: DocumentTotals;
    /** When payment is due (ISO date). */
    dueDate: string | null;
  };
}

export function renderDeliveryNotePdf(i: DeliveryNotePdfInput): Promise<Buffer> {
  const t = docLabels(i.language);
  const title = i.priced ? t.deliveryNoteInvoice : t.deliveryNote;
  const { doc, done } = newPdf({
    title: `${title} ${i.number}`,
    author: i.seller.legalName ?? i.brand.companyName,
    createdAt: i.issueDate,
  });
  const brand = pdfBrandColor(i.brand.color);
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const locale = quoteLocale(i.language);
  const d = i.data;
  doc.rect(0, 0, doc.page.width, 6).fill(brand);

  let y = header(doc, i, title, [
    [t.date, dateText(i.issueDate, i.language)],
    ...(d.deliveryDate
      ? ([[t.deliveryDate, dateText(d.deliveryDate, i.language)]] as [string, string][])
      : []),
    ...(i.priced?.dueDate
      ? ([[t.dueDate, dateText(i.priced.dueDate, i.language)]] as [string, string][])
      : []),
  ]);
  y = parties(
    doc,
    y,
    { label: t.supplier, lines: sellerLines(i.seller, t.regNo, t.vatNo) },
    {
      label: t.receiver,
      lines: [
        d.receiver.name,
        d.receiver.address,
        d.receiver.regNo ? `${t.regNo} ${d.receiver.regNo}` : '',
        d.receiver.vatNo ? `${t.vatNo} ${d.receiver.vatNo}` : '',
      ],
    },
  );
  y = parties(
    doc,
    y,
    {
      label: t.loadingAddress.toUpperCase(),
      lines: [d.loadingAddress || (i.seller.legalAddress ?? '')],
    },
    { label: t.deliveryAddress.toUpperCase(), lines: [d.deliveryAddress] },
  );
  if (d.vehicle || d.driver) {
    doc
      .font('r')
      .fontSize(10)
      .fillColor(INK)
      .text(
        [d.vehicle ? `${t.vehicle}: ${d.vehicle}` : '', d.driver ? `${t.driver}: ${d.driver}` : '']
          .filter(Boolean)
          .join('    '),
        L,
        y,
        { width: W },
      );
    y = doc.y + 16;
  }

  // Lines: No., item, qty, unit (and with prices: unit price, total).
  const p = i.priced;
  const money = (c: number) => formatMoney(c, p?.currency ?? 'EUR', locale);
  const col = p
    ? {
        n: L,
        item: L + 26,
        qty: L + W * 0.46,
        unit: L + W * 0.6,
        price: L + W * 0.66,
        total: L + W * 0.82,
      }
    : { n: L, item: L + 26, qty: L + W * 0.66, unit: L + W * 0.84, price: 0, total: 0 };
  const itemW = p ? W * 0.4 : W * 0.6;
  const head = () => {
    doc.font('s').fontSize(9).fillColor(MUTED);
    doc.text('#', col.n, y);
    doc.text(t.item, col.item, y);
    doc.text(t.qty, col.qty, y, { width: W * 0.12, align: 'right' });
    doc.text(t.unit, col.unit + 6, y, { width: W * 0.1 });
    if (p) {
      doc.text(t.unitPrice, col.price, y, { width: W * 0.16, align: 'right' });
      doc.text(t.lineTotal, col.total, y, { width: W * 0.18, align: 'right' });
    }
    y += 16;
    doc
      .moveTo(L, y)
      .lineTo(L + W, y)
      .strokeColor(RULE)
      .lineWidth(1)
      .stroke();
    y += 8;
  };
  head();
  d.lines.forEach((l, n) => {
    const h = doc.font('r').fontSize(10).heightOfString(l.name, { width: itemW });
    if (y + h + 12 > doc.page.height - 200) {
      doc.addPage();
      y = 56;
      head();
    }
    doc
      .font('r')
      .fontSize(10)
      .fillColor(MUTED)
      .text(String(n + 1), col.n, y);
    doc.fillColor(INK).text(l.name, col.item, y, { width: itemW });
    doc.text(l.qty === null ? '' : formatQty(l.qty, locale), col.qty, y, {
      width: W * 0.12,
      align: 'right',
    });
    doc.text(l.unit, col.unit + 6, y, { width: W * 0.1 });
    if (p) {
      const up = p.totals.unitPrices[n];
      const lt = p.totals.lineTotals[n];
      doc.text(up === null || up === undefined ? '' : money(up), col.price, y, {
        width: W * 0.16,
        align: 'right',
      });
      doc.text(lt === null || lt === undefined ? '' : money(lt), col.total, y, {
        width: W * 0.18,
        align: 'right',
      });
    }
    y += h + 10;
    doc
      .moveTo(L, y - 4)
      .lineTo(L + W, y - 4)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
  });
  if (p) {
    y = drawTotals(doc, y, {
      labels: t,
      money,
      rate: formatRate(p.vatRatePercent, i.language),
      vatMode: p.vatMode,
      totals: p.totals,
      totalX: col.total,
    });
    if (i.seller.iban)
      y = drawPayment(doc, y + 10, {
        labels: t,
        seller: i.seller,
        reference: i.number,
        payBy: p.dueDate ? t.payBy(dateText(p.dueDate, i.language)) : null,
        brand,
      });
  }

  if (d.notes.trim()) {
    y += 10;
    doc.font('s').fontSize(9).fillColor(MUTED).text(t.notes, L, y);
    doc
      .font('r')
      .fontSize(10)
      .fillColor(INK)
      .text(d.notes, L, y + 14, { width: W });
    y = doc.y;
  }

  // Signature boxes: issued by / received by.
  y += 28;
  if (y + 110 > doc.page.height - doc.page.margins.bottom) {
    doc.addPage();
    y = 56;
  }
  const bw = W / 2 - 8;
  for (const [k, label] of [t.issuedBy, t.receivedBy].entries()) {
    const x = L + k * (bw + 16);
    doc.rect(x, y, bw, 104).strokeColor(RULE).lineWidth(1).stroke();
    doc
      .font('s')
      .fontSize(9)
      .fillColor(MUTED)
      .text(label, x + 10, y + 10);
    let ly = y + 36;
    for (const f of [t.name, t.signature, t.date]) {
      doc
        .font('r')
        .fontSize(9)
        .fillColor(MUTED)
        .text(f, x + 10, ly);
      doc
        .moveTo(x + 90, ly + 10)
        .lineTo(x + bw - 10, ly + 10)
        .strokeColor(RULE)
        .stroke();
      ly += 22;
    }
  }
  doc.end();
  return done;
}
