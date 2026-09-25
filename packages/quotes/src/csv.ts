import { parseMoney } from './money.ts';

export interface PriceItemInput {
  name: string;
  description: string | null;
  unit: string;
  unitPriceCents: number;
  minQty: number | null;
  maxQty: number | null;
  vatNote: string | null;
}

export interface CsvRow {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  item?: PriceItemInput;
  error?: string;
}

export const MAX_CSV_ROWS = 2000;

const HEADER_ALIASES: Record<string, keyof PriceItemInput> = {
  name: 'name',
  item: 'name',
  product: 'name',
  description: 'description',
  unit: 'unit',
  unit_price: 'unitPriceCents',
  price: 'unitPriceCents',
  min_qty: 'minQty',
  min: 'minQty',
  max_qty: 'maxQty',
  max: 'maxQty',
  vat_note: 'vatNote',
  vat: 'vatNote',
};

/** Splits CSV text into records (quotes, doubled quotes and newlines inside quotes). */
function records(text: string, sep: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    out.push(row);
  }
  return out;
}

function qty(v: string | undefined): number | null | 'bad' {
  const s = (v ?? '').trim();
  if (!s) return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) && n > 0 && Math.round(n * 100) === n * 100 ? n : 'bad';
}

/**
 * Price list CSV: a header row with name and unit_price (plus optional
 * description, unit, min_qty, max_qty, vat_note), separated by ; , or tab.
 * Each row is checked on its own; bad rows are reported, not imported.
 */
export function parsePriceCsv(text: string): { rows: CsvRow[]; headerError?: string } {
  const clean = text.replace(/^\ufeff/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const sep = [';', '\t', ','].reduce((best, s) =>
    firstLine.split(s).length > firstLine.split(best).length ? s : best,
  );
  const all = records(clean, sep).filter((r) => r.some((c) => c.trim() !== ''));
  const header = (all[0] ?? []).map(
    (h) => HEADER_ALIASES[h.trim().toLowerCase().replace(/\s+/g, '_')],
  );
  if (!header.includes('name') || !header.includes('unitPriceCents')) {
    return {
      rows: [],
      headerError: 'The first row must name the columns, including name and unit_price.',
    };
  }
  const rows: CsvRow[] = [];
  for (const [i, rec] of all.slice(1, MAX_CSV_ROWS + 1).entries()) {
    const line = i + 2;
    const get = (k: keyof PriceItemInput) => {
      const idx = header.indexOf(k);
      return idx >= 0 ? (rec[idx] ?? '').trim() : '';
    };
    const name = get('name');
    if (!name) {
      rows.push({ line, error: 'name is empty' });
      continue;
    }
    if (name.length > 200) {
      rows.push({ line, error: 'name is longer than 200 characters' });
      continue;
    }
    const price = parseMoney(get('unitPriceCents'));
    if (price === null) {
      rows.push({ line, error: `“${get('unitPriceCents')}” is not a price` });
      continue;
    }
    const minQty = qty(get('minQty'));
    const maxQty = qty(get('maxQty'));
    if (minQty === 'bad' || maxQty === 'bad') {
      rows.push({ line, error: 'min_qty and max_qty must be positive numbers' });
      continue;
    }
    if (minQty !== null && maxQty !== null && minQty > maxQty) {
      rows.push({ line, error: 'min_qty is larger than max_qty' });
      continue;
    }
    rows.push({
      line,
      item: {
        name,
        description: get('description').slice(0, 500) || null,
        unit: get('unit').slice(0, 30) || 'pcs',
        unitPriceCents: price,
        minQty,
        maxQty,
        vatNote: get('vatNote').slice(0, 100) || null,
      },
    });
  }
  return { rows };
}
