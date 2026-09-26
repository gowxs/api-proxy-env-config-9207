import { formatMoney, formatQty } from './money.ts';
import { unitFor } from './units.ts';
import { formatRate, quoteLabels, quoteLocale } from './labels.ts';
import {
  newPdf,
  PDF_INK as INK,
  PDF_MUTED as MUTED,
  PDF_RULE as RULE,
  pdfBrandColor,
} from './pdf-base.ts';
import { formatDate } from './texts.ts';

export interface QuotePdfBrand {
  companyName: string;
  color: string | null;
  website: string | null;
  phone: string | null;
  address: string | null;
  /** PNG or JPEG bytes of the tenant's (allowlisted) logo, if it could be fetched. */
  logo: Buffer | null;
}

export interface QuotePdfInput {
  number: string;
  language: string | null;
  createdAt: Date;
  validUntil: Date;
  customer: { name: string | null; email: string };
  currency: string;
  vatMode: 'none' | 'exclusive' | 'inclusive';
  vatRatePercent: number;
  lines: {
    name: string;
    unit: string;
    qty: number;
    unitPriceCents: number;
    lineTotalCents: number;
    vatNote: string | null;
  }[];
  subtotalCents: number;
  vatCents: number;
  totalCents: number;
  notes: string | null;
  acceptUrl: string;
  brand: QuotePdfBrand;
}

/** A one- or multi-page A4 quote. Deterministic for the same input (fixed creation date). */
export function renderQuotePdf(q: QuotePdfInput): Promise<Buffer> {
  const { doc, done } = newPdf({
    title: `${quoteLabels(q.language).quote} ${q.number}`,
    author: q.brand.companyName,
    createdAt: q.createdAt,
  });

  const brand = pdfBrandColor(q.brand.color);
  const L = doc.page.margins.left;
  const W = doc.page.width - L - doc.page.margins.right;
  const t = quoteLabels(q.language);
  const locale = quoteLocale(q.language);
  const money = (c: number) => formatMoney(c, q.currency, locale);
  const date = (d: Date) => formatDate(d, q.language ?? 'en');
  const rate = formatRate(q.vatRatePercent, q.language);

  // Brand bar.
  doc.rect(0, 0, doc.page.width, 6).fill(brand);

  // Logo or company name, top left; the quote's facts, top right.
  let y = 48;
  if (q.brand.logo) {
    try {
      doc.image(q.brand.logo, L, y, { fit: [150, 48] });
    } catch {
      doc
        .font('b')
        .fontSize(18)
        .fillColor(INK)
        .text(q.brand.companyName, L, y + 12, { width: W / 2 });
    }
  } else {
    doc
      .font('b')
      .fontSize(18)
      .fillColor(INK)
      .text(q.brand.companyName, L, y + 12, { width: W / 2 });
  }
  doc.font('b').fontSize(22).fillColor(INK).text(t.quote, L, y, { width: W, align: 'right' });
  doc
    .font('r')
    .fontSize(10)
    .fillColor(MUTED)
    .text(
      `${q.number}\n${t.date}: ${date(q.createdAt)}\n${t.validUntil}: ${date(q.validUntil)}`,
      L,
      y + 30,
      {
        width: W,
        align: 'right',
      },
    );

  // From / to.
  y = 140;
  const from = [q.brand.companyName, q.brand.address, q.brand.phone, q.brand.website]
    .filter(Boolean)
    .join('\n');
  const to = [q.customer.name, q.customer.email].filter(Boolean).join('\n');
  doc
    .font('s')
    .fontSize(9)
    .fillColor(MUTED)
    .text(t.from, L, y)
    .text(t.for, L + W / 2, y);
  doc
    .font('r')
    .fontSize(10)
    .fillColor(INK)
    .text(from, L, y + 14, { width: W / 2 - 16 });
  doc.text(to, L + W / 2, y + 14, { width: W / 2 });
  y = Math.max(doc.y, y + 60) + 24;

  // Lines.
  const col = { item: L, qty: L + W * 0.52, unit: L + W * 0.64, total: L + W * 0.82 };
  const header = () => {
    doc.font('s').fontSize(9).fillColor(MUTED);
    doc.text(t.item, col.item, y);
    doc.text(t.qty, col.qty - W * 0.06, y, { width: W * 0.16, align: 'right' });
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
  header();
  for (const l of q.lines) {
    const nameH = doc
      .font('r')
      .fontSize(10)
      .heightOfString(l.name, { width: W * 0.5 });
    const noteH = l.vatNote ? doc.fontSize(8).heightOfString(l.vatNote, { width: W * 0.5 }) + 2 : 0;
    if (y + nameH + noteH + 12 > doc.page.height - 200) {
      doc.addPage();
      y = 56;
      header();
    }
    doc
      .font('r')
      .fontSize(10)
      .fillColor(INK)
      .text(l.name, col.item, y, { width: W * 0.5 });
    if (l.vatNote)
      doc
        .fontSize(8)
        .fillColor(MUTED)
        .text(l.vatNote, col.item, y + nameH + 2, { width: W * 0.5 });
    doc.fontSize(10).fillColor(INK);
    doc.text(
      `${formatQty(l.qty, locale)} ${unitFor(l.unit, l.qty, q.language)}`,
      col.qty - W * 0.06,
      y,
      {
        width: W * 0.16,
        align: 'right',
      },
    );
    doc.text(money(l.unitPriceCents), col.unit, y, { width: W * 0.16, align: 'right' });
    doc.text(money(l.lineTotalCents), col.total, y, { width: W * 0.18, align: 'right' });
    y += nameH + noteH + 10;
    doc
      .moveTo(L, y - 4)
      .lineTo(L + W, y - 4)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
  }

  // Totals.
  y += 6;
  const row = (label: string, value: string, strong = false) => {
    doc
      .font(strong ? 'b' : 'r')
      .fontSize(strong ? 12 : 10)
      .fillColor(strong ? INK : MUTED)
      .text(label, L + W * 0.5, y, { width: W * 0.3, align: 'right' });
    doc.fillColor(INK).text(value, col.total, y, { width: W * 0.18, align: 'right' });
    y += strong ? 20 : 16;
  };
  if (q.vatMode === 'exclusive') {
    row(t.subtotal, money(q.subtotalCents));
    row(t.vat(rate), money(q.vatCents));
    row(t.total, money(q.totalCents), true);
  } else if (q.vatMode === 'inclusive') {
    row(t.total, money(q.totalCents), true);
    row(t.ofWhichVat(rate), money(q.vatCents));
  } else {
    row(t.total, money(q.totalCents), true);
  }

  // Notes, then how to accept.
  y += 12;
  if (q.notes) {
    doc.font('s').fontSize(9).fillColor(MUTED).text(t.notes, L, y);
    doc
      .font('r')
      .fontSize(10)
      .fillColor(INK)
      .text(q.notes, L, y + 14, { width: W });
    y = doc.y + 16;
  }
  // The box grows with the (translated) heading and the link.
  const heading = t.acceptOnline(date(q.validUntil));
  const headingH = doc
    .font('s')
    .fontSize(10)
    .heightOfString(heading, { width: W - 28 });
  const urlH = doc
    .font('r')
    .fontSize(9)
    .heightOfString(q.acceptUrl, { width: W - 28 });
  doc.rect(L, y, W, 12 + headingH + 4 + urlH + 12).fill('#F4F5F7');
  doc
    .font('s')
    .fontSize(10)
    .fillColor(INK)
    .text(heading, L + 14, y + 12, { width: W - 28 });
  doc
    .font('r')
    .fontSize(9)
    .fillColor(brand)
    .text(q.acceptUrl, L + 14, y + 12 + headingH + 4, {
      width: W - 28,
      link: q.acceptUrl,
      underline: true,
    });

  doc.end();
  return done;
}
