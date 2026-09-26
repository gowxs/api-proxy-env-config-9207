import { z } from 'zod';
import type { CmrData, CmrGoods } from './schema.ts';

/**
 * Pre-filling a CMR from a customer's e-mail order. The model returns, for
 * each field it can fill, the value and the exact text of the e-mail it
 * copied it from. Code keeps a field only when that text really is in the
 * e-mail; numbers and dates are parsed by code from the source text, never
 * taken from the model. The sender (the business itself) is never filled
 * by the model. Every kept field is shown to the owner with its source.
 */
export const CmrPrefillSchema = z.strictObject({
  fields: z
    .array(
      z.strictObject({
        field: z.string().trim().max(40),
        value: z.string().trim().max(300),
        source: z.string().trim().max(300),
      }),
    )
    .max(80),
});
export type CmrPrefill = z.infer<typeof CmrPrefillSchema>;

const TEXT_FIELDS = new Set([
  'consignee.name',
  'consignee.address',
  'consignee.country',
  'deliveryPlace.place',
  'deliveryPlace.country',
  'takingOver.place',
  'takingOver.country',
  'documentsAttached',
  'senderInstructions',
  'cashOnDelivery',
  'carrier.name',
  'carrier.address',
  'carrier.country',
  'successiveCarriers',
  'specialAgreements',
  'vehicleTractor',
  'vehicleTrailer',
]);
const GOODS_TEXT = new Set(['marks', 'packing', 'nature', 'statNo']);
const GOODS_NUMBER = new Set(['packages', 'grossKg', 'volumeM3']);

export const CMR_PREFILL_FIELD_HELP = [
  'consignee.name, consignee.address, consignee.country: who receives the goods (box 2)',
  'deliveryPlace.place, deliveryPlace.country: where the goods are delivered (box 3)',
  'takingOver.place, takingOver.country, takingOver.date: where and when the goods are collected (box 4)',
  'documentsAttached: documents that travel with the goods (box 5)',
  'goods.N.marks, goods.N.packages, goods.N.packing, goods.N.nature, goods.N.statNo, goods.N.grossKg, goods.N.volumeM3: goods line N, starting at 0 (boxes 6–12: marks and numbers, number of packages, method of packing, nature of the goods, statistical number, gross weight in kg, volume in m³)',
  'senderInstructions: instructions for the carrier (box 13)',
  'carriagePayment: "paid" or "forward" (box 14)',
  'cashOnDelivery: amount to collect on delivery (box 15)',
  'carrier.name, carrier.address, carrier.country: the transport company (box 16)',
  'successiveCarriers, specialAgreements: boxes 17 and 19',
  'vehicleTractor, vehicleTrailer: registration numbers',
];

export function buildCmrPrefillPrompt(input: { emailBlock: string; emailRule: string }): {
  system: string;
  parts: { kind: 'untrusted_email'; text: string }[];
} {
  const system = [
    "You read a customer's e-mail about a road transport order and copy details for a CMR consignment note. You only copy; you never invent or calculate.",
    input.emailRule,
    'Fields you may fill:',
    ...CMR_PREFILL_FIELD_HELP.map((h) => `- ${h}`),
    'For each field the e-mail states, output {field, value, source}: value as written; source = the exact words of the e-mail that contain the value (copy them character for character, at most 25 words).',
    'Leave out anything the e-mail does not state. Never fill details of the business that receives this e-mail (the sender of the goods). Do not convert units or dates.',
    'Output a single JSON object: {"fields": [...]}.',
  ].join('\n');
  return { system, parts: [{ kind: 'untrusted_email', text: input.emailBlock }] };
}

const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Every unambiguous decimal number written in a text. "1.250,5" and
 * "1,250.5" are 1250.5; "620" is 620; "2,5" is 2.5. "1,250" alone is
 * ambiguous (1250 or 1.25) and skipped, as are digits in units and codes (m3, A4).
 */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  // A digit right after a letter is part of a unit or code (m3, A4), not a quantity.
  for (const m of text.matchAll(/(?<![\p{L}\d])\d+(?:[ \u00a0.,']\d+)*/gu)) {
    let s = m[0].replace(/[ \u00a0']/g, '');
    const dots = (s.match(/\./g) ?? []).length;
    const commas = (s.match(/,/g) ?? []).length;
    if (dots && commas) {
      const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
      const thou = dec === '.' ? ',' : '.';
      s = s.split(thou).join('').replace(dec, '.');
    } else if (dots + commas === 1) {
      const sep = dots ? '.' : ',';
      const [a, b] = s.split(sep) as [string, string];
      if (b.length === 3 && a.length <= 3) continue; // ambiguous thousands separator
      s = `${a}.${b}`;
    } else if (dots + commas > 1) {
      const sep = dots ? '.' : ',';
      const parts = s.split(sep);
      if (parts.slice(1).some((p) => p.length !== 3)) continue;
      s = parts.join('');
    }
    const n = Number(s);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const MONTHS: Record<string, number> = {};
[
  ['january', 'jan', 'januar', 'janvier', 'enero', 'janvāris', 'januari'],
  ['february', 'feb', 'februar', 'février', 'febrero', 'februāris', 'februari'],
  ['march', 'mar', 'märz', 'mars', 'marzo', 'marts', 'maart'],
  ['april', 'apr', 'avril', 'abril', 'aprīlis'],
  ['may', 'mai', 'mayo', 'maijs', 'mei'],
  ['june', 'jun', 'juni', 'juin', 'junio', 'jūnijs'],
  ['july', 'jul', 'juli', 'juillet', 'julio', 'jūlijs'],
  ['august', 'aug', 'août', 'agosto', 'augusts', 'augustus'],
  ['september', 'sep', 'sept', 'septembre', 'septiembre', 'septembris'],
  ['october', 'oct', 'oktober', 'octobre', 'octubre', 'oktobris'],
  ['november', 'nov', 'novembre', 'noviembre', 'novembris'],
  ['december', 'dec', 'dezember', 'décembre', 'diciembre', 'decembris'],
].forEach((names, i) => names.forEach((n) => (MONTHS[n] = i + 1)));

const iso = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? dt.toISOString().slice(0, 10)
    : null;
};

/** Every date written in a text: 2026-10-14, 14.10.2026, 14/10/26 (day first), 14 October 2026, October 14, 2026. */
export function datesIn(text: string): string[] {
  const out = new Set<string>();
  const t = text.toLowerCase();
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    const v = iso(+m[1]!, +m[2]!, +m[3]!);
    if (v) out.add(v);
  }
  for (const m of t.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})\b/g)) {
    const y = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    const v = iso(y, +m[2]!, +m[1]!);
    if (v) out.add(v);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\.?\s+([\p{L}]+)\.?,?\s+(\d{4})\b/gu)) {
    const mo = MONTHS[m[2]!];
    const v = mo ? iso(+m[3]!, mo, +m[1]!) : null;
    if (v) out.add(v);
  }
  for (const m of t.matchAll(/\b([\p{L}]+)\.?\s+(\d{1,2}),?\s+(\d{4})\b/gu)) {
    const mo = MONTHS[m[1]!];
    const v = mo ? iso(+m[3]!, mo, +m[2]!) : null;
    if (v) out.add(v);
  }
  return [...out];
}

const PAID = /carriage paid|freight paid|prepaid|pre-paid|franco|frei haus|frachtfrei|apmaksāt/i;
const FORWARD = /carriage forward|freight collect|\bcollect\b|non franco|unfrei/i;

export interface PrefillResult {
  data: CmrData;
  /** Field path → the e-mail text it was copied from. */
  prefill: Record<string, { source: string }>;
  dropped: { field: string; reason: string }[];
}

const emptyGoods = (): CmrGoods => ({
  marks: '',
  packages: null,
  packing: '',
  nature: '',
  statNo: '',
  grossKg: null,
  volumeM3: null,
});

/** Applies the model's fields to a CMR draft, keeping only what the e-mail proves. */
export function applyCmrPrefill(
  extraction: CmrPrefill,
  emailText: string,
  base: CmrData,
): PrefillResult {
  const email = norm(emailText);
  const data: CmrData = structuredClone(base);
  const prefill: Record<string, { source: string }> = {};
  const dropped: { field: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const f of extraction.fields) {
    const drop = (reason: string) => dropped.push({ field: f.field, reason });
    if (seen.has(f.field)) {
      drop('duplicate');
      continue;
    }
    const src = norm(f.source);
    if (src.length < 2 || !email.includes(src)) {
      drop('source not in the e-mail');
      continue;
    }
    const value = f.value.trim();
    const goods = /^goods\.(\d)\.(\w+)$/.exec(f.field);

    if (TEXT_FIELDS.has(f.field) || (goods && GOODS_TEXT.has(goods[2]!))) {
      if (!value || !src.includes(norm(value))) {
        drop('value not in its source');
        continue;
      }
      if (goods) {
        const n = +goods[1]!;
        while (data.goods.length <= n) data.goods.push(emptyGoods());
        (data.goods[n] as unknown as Record<string, unknown>)[goods[2]!] = value.slice(0, 200);
      } else {
        const [a, b] = f.field.split('.') as [string, string | undefined];
        if (b)
          (data as unknown as Record<string, Record<string, unknown>>)[a]![b] = value.slice(0, 500);
        else (data as unknown as Record<string, unknown>)[a] = value.slice(0, 600);
      }
    } else if (goods && GOODS_NUMBER.has(goods[2]!)) {
      const found = numbersIn(f.source);
      const claimed = Number(value.replace(',', '.').replace(/[^\d.]/g, ''));
      const n = found.includes(claimed) ? claimed : found.length === 1 ? found[0]! : null;
      if (n === null || n <= 0) {
        drop('no single number in its source');
        continue;
      }
      if (goods[2] === 'packages' && !Number.isInteger(n)) {
        drop('packages must be a whole number');
        continue;
      }
      const i = +goods[1]!;
      while (data.goods.length <= i) data.goods.push(emptyGoods());
      (data.goods[i] as unknown as Record<string, unknown>)[goods[2]!] = n;
    } else if (f.field === 'takingOver.date') {
      const found = datesIn(f.source);
      const d = found.includes(value) ? value : found.length === 1 ? found[0]! : null;
      if (!d) {
        drop('no single date in its source');
        continue;
      }
      data.takingOver.date = d;
    } else if (f.field === 'carriagePayment') {
      if (value === 'paid' && PAID.test(f.source)) data.carriagePayment = 'paid';
      else if (value === 'forward' && FORWARD.test(f.source)) data.carriagePayment = 'forward';
      else {
        drop('payment terms not stated in its source');
        continue;
      }
    } else {
      drop('not a field the e-mail may fill');
      continue;
    }
    seen.add(f.field);
    prefill[f.field] = { source: f.source.slice(0, 300) };
  }
  return { data, prefill, dropped };
}
