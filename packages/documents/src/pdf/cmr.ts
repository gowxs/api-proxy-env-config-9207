import { formatQty, newPdf, PDF_INK as INK, PDF_MUTED as MUTED } from '@noctiv/quotes';
import { CMR_LABELS as C } from '../labels.ts';
import type { CmrData } from '../schema.ts';

export interface CmrPdfInput {
  number: string;
  issueDate: Date;
  data: CmrData;
  author: string;
}

const LINE = '#8A90A0';
/** CMR numbers and dates are written the neutral European way (the form is bilingual). */
const num = (v: number | null) => (v === null ? '' : formatQty(v, 'fr-FR'));
const date = (iso: string | null) =>
  iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';

/**
 * The standard CMR consignment note (boxes 1–24, English/French) as four
 * copies in one PDF: 1 sender (red), 2 consignee (blue), 3 carrier (green),
 * 4 extra (black).
 */
export function renderCmrPdf(i: CmrPdfInput): Promise<Buffer> {
  const { doc, done } = newPdf({
    title: `CMR ${i.number}`,
    author: i.author,
    createdAt: i.issueDate,
    margins: 22,
  });
  const d = i.data;
  const L = 22;
  const W = doc.page.width - 44;
  const half = W / 2;

  /** A box with its number and bilingual label; the value fills the rest. */
  const box = (
    n: number | null,
    x: number,
    y: number,
    w: number,
    h: number,
    value: string,
    label?: [string, string],
  ) => {
    doc.rect(x, y, w, h).strokeColor(LINE).lineWidth(0.6).stroke();
    const [en, fr] = label ?? C.box[n!]!;
    let ly = y + 3;
    if (n !== null)
      doc
        .font('b')
        .fontSize(7)
        .fillColor(INK)
        .text(String(n), x + 3, ly);
    doc
      .font('r')
      .fontSize(5.5)
      .fillColor(MUTED)
      .text(fr ? `${en} / ${fr}` : en, x + (n !== null ? 14 : 3), ly + 0.5, {
        width: w - (n !== null ? 17 : 6),
        height: 14,
        ellipsis: true,
      });
    ly = Math.min(doc.y, y + 16) + 2;
    if (value)
      doc
        .font('r')
        .fontSize(8.5)
        .fillColor(INK)
        .text(value, x + 4, ly, { width: w - 8, height: y + h - ly - 2, ellipsis: true });
  };
  const lines = (...a: string[]) => a.filter((s) => s && s.trim()).join('\n');

  C.copies.forEach((copy, pageIndex) => {
    if (pageIndex > 0) doc.addPage();
    let y = 22;
    // Copy colour strip.
    doc.rect(0, 0, doc.page.width, 5).fill(copy.color);

    // Row 1: sender | title.
    box(1, L, y, half, 78, lines(d.sender.name, d.sender.address, d.sender.country));
    doc
      .rect(L + half, y, half, 78)
      .strokeColor(LINE)
      .lineWidth(0.6)
      .stroke();
    doc
      .font('b')
      .fontSize(10)
      .fillColor(INK)
      .text(C.title, L + half + 8, y + 6, { width: half - 16 });
    doc
      .font('r')
      .fontSize(8)
      .fillColor(MUTED)
      .text(C.titleFr, L + half + 8, y + 19, { width: half - 16 });
    doc
      .font('b')
      .fontSize(20)
      .fillColor(INK)
      .text('CMR', L + half + 8, y + 32);
    doc
      .font('s')
      .fontSize(11)
      .fillColor(INK)
      .text(i.number, L + half + 70, y + 38, { width: half - 80 });
    doc
      .font('s')
      .fontSize(7.5)
      .fillColor(copy.color)
      .text(`${copy.n}  ${copy.en} / ${copy.fr}`, L + half + 8, y + 62, { width: half - 16 });
    y += 78;

    // Rows 2–5.
    box(2, L, y, half, 70, lines(d.consignee.name, d.consignee.address, d.consignee.country));
    box(16, L + half, y, half, 70, lines(d.carrier.name, d.carrier.address, d.carrier.country));
    y += 70;
    box(3, L, y, half, 44, lines(d.deliveryPlace.place, d.deliveryPlace.country));
    box(17, L + half, y, half, 44, d.successiveCarriers);
    y += 44;
    box(
      4,
      L,
      y,
      half,
      54,
      lines(
        [d.takingOver.place, d.takingOver.country].filter(Boolean).join(', '),
        date(d.takingOver.date),
      ),
    );
    box(18, L + half, y, half, 54, d.carrierReservations);
    y += 54;
    box(5, L, y, half, 40, d.documentsAttached);
    box(
      null,
      L + half,
      y,
      half,
      40,
      lines(
        d.vehicleTractor ? `${C.tractor}: ${d.vehicleTractor}` : '',
        d.vehicleTrailer ? `${C.trailer}: ${d.vehicleTrailer}` : '',
      ),
      [C.vehicle, ''],
    );
    y += 40;

    // Goods table, boxes 6–12.
    const cols: [number, number][] = [
      [6, 0.14],
      [7, 0.1],
      [8, 0.13],
      [9, 0.29],
      [10, 0.1],
      [11, 0.12],
      [12, 0.12],
    ];
    const tableH = 228;
    let x = L;
    const colX: number[] = [];
    for (const [n, f] of cols) {
      const w = W * f;
      colX.push(x);
      doc.rect(x, y, w, tableH).strokeColor(LINE).lineWidth(0.6).stroke();
      doc
        .font('b')
        .fontSize(7)
        .fillColor(INK)
        .text(String(n), x + 3, y + 3);
      const [en, fr] = C.box[n]!;
      doc
        .font('r')
        .fontSize(5.5)
        .fillColor(MUTED)
        .text(`${en} / ${fr}`, x + 3, y + 12, {
          width: w - 6,
          height: 22,
          ellipsis: true,
        });
      x += w;
    }
    let gy = y + 38;
    for (const g of d.goods) {
      const cells = [
        g.marks,
        num(g.packages),
        g.packing,
        g.nature,
        g.statNo,
        num(g.grossKg),
        num(g.volumeM3),
      ];
      cells.forEach((v, k) => {
        const w = W * cols[k]![1];
        doc
          .font('r')
          .fontSize(8.5)
          .fillColor(INK)
          .text(v, colX[k]! + 3, gy, {
            width: w - 6,
            height: 15,
            ellipsis: true,
            align: k === 1 || k >= 5 ? 'right' : 'left',
          });
      });
      gy += 15;
    }
    y += tableH;

    // Rows: 13 | 19, 14 | 20, 15 | 21.
    box(13, L, y, half, 62, d.senderInstructions);
    box(19, L + half, y, half, 62, d.specialAgreements);
    y += 62;
    box(
      14,
      L,
      y,
      half,
      46,
      d.carriagePayment === 'paid' ? C.paid : d.carriagePayment === 'forward' ? C.forward : '',
    );
    box(20, L + half, y, half, 46, d.toBePaidBy);
    y += 46;
    box(15, L, y, half, 34, d.cashOnDelivery);
    box(
      21,
      L + half,
      y,
      half,
      34,
      [d.establishedIn, date(d.establishedOn)].filter(Boolean).join(', '),
    );
    y += 34;

    // Signatures 22–24.
    const third = W / 3;
    box(22, L, y, third, 96, '');
    box(23, L + third, y, third, 96, '');
    box(24, L + 2 * third, y, third, 96, '');
    doc
      .font('r')
      .fontSize(5.5)
      .fillColor(MUTED)
      .text(C.placeDate, L + 2 * third + 4, y + 80, { width: third - 8 });
    y += 96;

    // The convention clause.
    doc
      .font('r')
      .fontSize(6)
      .fillColor(MUTED)
      .text(`${C.clause}\n${C.clauseFr}`, L, y + 6, { width: W });
  });
  doc.end();
  return done;
}
