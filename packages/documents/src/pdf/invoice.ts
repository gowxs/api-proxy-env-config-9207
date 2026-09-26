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
import { docLabels } from '../labels.ts';
import type { DeliveryNoteData, InvoiceData } from '../schema.ts';
import type { InvoiceTotals } from '../totals.ts';
import { dateText, header, ibanText, parties, sellerLines, type PdfContext } from './common.ts';

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
    doc.text(l.unitPriceCents === null ? '' : money(l.unitPriceCents), col.unit, y, {
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

  // Totals.
  y += 6;
  const row = (label: string, value: string, strong = false) => {
    doc
      .font(strong ? 'b' : 'r')
      .fontSize(strong ? 12 : 10)
      .fillColor(strong ? INK : MUTED)
      .text(label, L + W * 0.4, y, { width: W * 0.4, align: 'right' });
    doc.fillColor(INK).text(value, col.total, y, { width: W * 0.18, align: 'right' });
    y += strong ? 20 : 16;
  };
  const rate = formatRate(i.vatRatePercent, i.language);
  const tt = i.totals;
  if (d.reverseCharge || i.vatMode === 'none') row(t.total, money(tt.totalCents), true);
  else if (i.vatMode === 'exclusive') {
    row(t.subtotal, money(tt.subtotalCents));
    row(t.vat(rate), money(tt.vatCents));
    row(t.total, money(tt.totalCents), true);
  } else {
    row(t.total, money(tt.totalCents), true);
    row(t.ofWhichVat(rate), money(tt.vatCents));
  }
  if (d.reverseCharge) {
    y += 4;
    doc.font('s').fontSize(9).fillColor(INK).text(t.reverseCharge, L, y, { width: W });
    y = doc.y + 8;
  }

  // Payment details.
  y += 10;
  const pay: [string, string][] = [
    [t.bank, i.seller.bankName ?? ''],
    [t.iban, ibanText(i.seller)],
    [t.bic, i.seller.bic ?? ''],
    [t.reference, d.paymentReference || i.number],
  ].filter(([, v]) => v) as [string, string][];
  const boxH = 30 + pay.length * 14 + 16;
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
  doc
    .font('s')
    .fontSize(10)
    .fillColor(brand)
    .text(t.payBy(dateText(i.dueDate, i.language)), L + 14, py + 2, { width: W - 28 });
  y += boxH + 16;

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
}

export function renderDeliveryNotePdf(i: DeliveryNotePdfInput): Promise<Buffer> {
  const t = docLabels(i.language);
  const { doc, done } = newPdf({
    title: `${t.deliveryNote} ${i.number}`,
    author: i.seller.legalName ?? i.brand.companyName,
    createdAt: i.issueDate,
  });
  const brand = pdfBrandColor(i.brand.color);
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const locale = quoteLocale(i.language);
  const d = i.data;
  doc.rect(0, 0, doc.page.width, 6).fill(brand);

  let y = header(doc, i, t.deliveryNote, [
    [t.date, dateText(i.issueDate, i.language)],
    ...(d.deliveryDate
      ? ([[t.deliveryDate, dateText(d.deliveryDate, i.language)]] as [string, string][])
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

  // Lines: No., item, qty, unit.
  const col = { n: L, item: L + 26, qty: L + W * 0.66, unit: L + W * 0.84 };
  doc.font('s').fontSize(9).fillColor(MUTED);
  doc.text('#', col.n, y);
  doc.text(t.item, col.item, y);
  doc.text(t.qty, col.qty, y, { width: W * 0.16, align: 'right' });
  doc.text(t.unit, col.unit, y, { width: W * 0.16 });
  y += 16;
  doc
    .moveTo(L, y)
    .lineTo(L + W, y)
    .strokeColor(RULE)
    .lineWidth(1)
    .stroke();
  y += 8;
  d.lines.forEach((l, n) => {
    const h = doc
      .font('r')
      .fontSize(10)
      .heightOfString(l.name, { width: W * 0.6 });
    if (y + h + 12 > doc.page.height - 200) {
      doc.addPage();
      y = 56;
    }
    doc
      .font('r')
      .fontSize(10)
      .fillColor(MUTED)
      .text(String(n + 1), col.n, y);
    doc.fillColor(INK).text(l.name, col.item, y, { width: W * 0.6 });
    doc.text(l.qty === null ? '' : formatQty(l.qty, locale), col.qty, y, {
      width: W * 0.16,
      align: 'right',
    });
    doc.text(l.unit, col.unit, y, { width: W * 0.16 });
    y += h + 10;
    doc
      .moveTo(L, y - 4)
      .lineTo(L + W, y - 4)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
  });

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
