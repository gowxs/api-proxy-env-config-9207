/**
 * Number parsing that tolerates European and English formats:
 * "1 200,50", "1.200,50", "1,200.50", "1200.5", "24", "2-3".
 * Ambiguous forms ("1.200", "1,200") yield both readings; a claim counts as
 * supported if any reading matches any reading found in the cited sources.
 */

// Digits with optional thousands groups (space, NBSP, narrow NBSP, dot, comma, apostrophe) and decimals.
export const NUMBER_SOURCE =
  "\\d{1,3}(?:[ \\u00A0\\u202F.,']\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d+)?";
// Space, no-break space, narrow no-break space and apostrophe used as thousands separators.
const SPACE_LIKE_RE = new RegExp("[\\u00A0\\u202F' ]", 'g');
const NUMBER_RE = new RegExp(`(?<![\\p{L}\\d])(?:${NUMBER_SOURCE})(?![\\d])`, 'gu');

function canonical(n: number): string {
  return Number.isFinite(n) ? String(Math.round(n * 10_000) / 10_000) : '';
}

export function numberReadings(token: string): string[] {
  const t = token.replace(SPACE_LIKE_RE, ' ').trim();
  const readings = new Set<string>();
  const add = (s: string) => {
    const v = canonical(Number(s));
    if (v) readings.add(v);
  };

  if (/^\d+$/.test(t)) {
    add(t);
  } else if (/ /.test(t)) {
    // Space-grouped thousands, optional decimal part.
    const [intPart, dec] = t.replace(/ /g, '').split(/[.,](?=\d{1,2}$)/);
    add(dec ? `${intPart}.${dec}` : intPart!.replace(/[.,]/g, ''));
  } else {
    const lastDot = t.lastIndexOf('.');
    const lastComma = t.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      const decimalSep = lastDot > lastComma ? '.' : ',';
      const thousandsSep = decimalSep === '.' ? ',' : '.';
      add(t.split(thousandsSep).join('').replace(decimalSep, '.'));
    } else {
      const sep = lastDot >= 0 ? '.' : ',';
      const parts = t.split(sep);
      const groupedThousands = parts.length > 1 && parts.slice(1).every((p) => p.length === 3);
      if (groupedThousands) add(parts.join(''));
      if (parts.length === 2) add(`${parts[0]}.${parts[1]}`);
    }
  }
  return [...readings];
}

export interface NumberToken {
  raw: string;
  readings: string[];
  start: number;
  end: number;
}

export function findNumbers(text: string): NumberToken[] {
  NUMBER_RE.lastIndex = 0;
  return [...text.matchAll(NUMBER_RE)].map((m) => ({
    raw: m[0],
    readings: numberReadings(m[0]),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

/** Every numeric reading present anywhere in the text. */
export function numberSet(text: string): Set<string> {
  return new Set(findNumbers(text).flatMap((n) => n.readings));
}
