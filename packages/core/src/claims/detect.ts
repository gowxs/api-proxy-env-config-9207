import { foldForMatching, wordRegex } from '../text/normalize.ts';
import {
  CONCEPTS,
  CURRENCY_SOURCE,
  DURATION_UNIT_SOURCE,
  MONTHS,
  PERCENT_SOURCE,
  WEEKDAYS,
  type ConceptGroup,
} from './lexicon.ts';
import { findNumbers, NUMBER_SOURCE, numberSet } from './numbers.ts';

export type ClaimKind =
  'money' | 'percentage' | 'duration' | 'time' | 'date' | 'weekday' | 'number' | ConceptGroup;

export interface Claim {
  kind: ClaimKind;
  text: string;
  start: number;
  end: number;
  /** One entry per number in the claim, each with its possible readings. */
  numbers: string[][];
  /** Date keys "M-D" (both readings for ambiguous numeric dates). */
  dateKeys: string[];
  /** Time of day "H:MM". */
  time?: string;
  /** 1 = Monday … 7 = Sunday. */
  weekday?: number;
}

const NUM = `(?:${NUMBER_SOURCE})`;
const alt = (xs: string[]) => xs.join('|');

const MONEY_RE = wordRegex(
  `(?:${CURRENCY_SOURCE})\\s?${NUM}(?:\\s?[-–]\\s?${NUM})?|${NUM}(?:\\s?[-–]\\s?${NUM})?\\s?(?:${CURRENCY_SOURCE})`,
);
const PERCENT_RE = wordRegex(`${NUM}\\s?(?:${PERCENT_SOURCE})`);
const DURATION_RE = wordRegex(
  `${NUM}(?:\\s?(?:-|–|to|bis|tot|à|a|līdz)\\s?${NUM})?\\s?(?:${DURATION_UNIT_SOURCE})`,
);
const ISO_DATE_RE = wordRegex(String.raw`\d{4}-\d{1,2}-\d{1,2}`);
const NUMERIC_DATE_RE = wordRegex(
  String.raw`\d{1,2}[./]\d{1,2}[./](?:\d{4}|\d{2})|\d{1,2}\.\d{1,2}\.(?!\d)`,
);
const MONTH_INDEX = MONTHS.map((names) => new RegExp(`^(?:${alt(names)})$`, 'iu'));
const MONTH_ANY = alt(MONTHS.flat());
const MONTH_DATE_RE = wordRegex(
  `(\\d{1,2})\\.?\\s?(?:of\\s|de\\s)?(${MONTH_ANY})|(${MONTH_ANY})\\s?(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)`,
);
const TIME_RE = wordRegex(String.raw`\d{1,2}:\d{2}(?:\s?(?:am|pm|uhr|h))?|\d{1,2}\s?(?:am|pm|uhr)`);
const MONEY_WINDOW = 12;
const CURRENCY_NEAR_RE = wordRegex(CURRENCY_SOURCE, 'iu');
const LIST_MARKER_RE = /^[ \t]*\d{1,2}[.)][ \t]/gm;
const WEEKDAY_RES = WEEKDAYS.map((names) => wordRegex(alt(names)));
const CONCEPT_RES = (Object.keys(CONCEPTS) as ConceptGroup[]).map(
  (group) => [group, wordRegex(alt(Object.values(CONCEPTS[group]).flat()))] as const,
);

function monthIndex(name: string): number {
  return MONTH_INDEX.findIndex((re) => re.test(name)) + 1;
}

function validDay(m: number, d: number): boolean {
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

function numericDateKeys(raw: string): string[] {
  if (/^\d{4}-/.test(raw)) {
    const [, m, d] = raw.split('-').map(Number);
    return validDay(m!, d!) ? [`${m}-${d}`] : [];
  }
  const [a, b] = raw.split(/[./]/).map(Number);
  const keys = new Set<string>();
  if (validDay(b!, a!)) keys.add(`${b}-${a}`); // day.month (EU)
  if (validDay(a!, b!)) keys.add(`${a}-${b}`); // month/day (US)
  return [...keys];
}

function timeKey(raw: string): string | undefined {
  const m = /(\d{1,2})(?::(\d{2}))?\s?(am|pm|uhr|h)?/i.exec(raw);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ?? '00';
  const suffix = m[3]?.toLowerCase();
  if (suffix === 'pm' && hour < 12) hour += 12;
  if (suffix === 'am' && hour === 12) hour = 0;
  return hour <= 24 ? `${hour}:${minute}` : undefined;
}

/**
 * Finds every statement in a reply that commits the business to something:
 * amounts of money, percentages, durations, times, dates, weekdays, bare
 * numbers, and discount / free / availability / guarantee / relative-time
 * wording in any of the six supported languages. Claim text and positions
 * refer to the case-folded input.
 */
export function detectClaims(input: string): Claim[] {
  const text = foldForMatching(input);
  const claims: Claim[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([ts, te]) => s < te && e > ts);

  const addSpanClaims = (
    re: RegExp,
    kind: ClaimKind,
    extra: (raw: string, m: RegExpMatchArray) => Partial<Claim>,
  ) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      taken.push([start, end]);
      claims.push({
        kind,
        text: text.slice(start, end),
        start,
        end,
        numbers: [],
        dateKeys: [],
        ...extra(m[0], m),
      });
    }
  };
  const withNumbers = (raw: string) => ({ numbers: findNumbers(raw).map((n) => n.readings) });

  addSpanClaims(ISO_DATE_RE, 'date', (raw) => ({ dateKeys: numericDateKeys(raw) }));
  addSpanClaims(NUMERIC_DATE_RE, 'date', (raw) => ({ dateKeys: numericDateKeys(raw) }));
  addSpanClaims(MONEY_RE, 'money', withNumbers);
  addSpanClaims(PERCENT_RE, 'percentage', withNumbers);
  addSpanClaims(DURATION_RE, 'duration', withNumbers);
  addSpanClaims(MONTH_DATE_RE, 'date', (_raw, m) => {
    const day = Number(m[1] ?? m[4]);
    const month = monthIndex(m[2] ?? m[3] ?? '');
    return { dateKeys: validDay(month, day) ? [`${month}-${day}`] : [] };
  });
  addSpanClaims(TIME_RE, 'time', (raw) => {
    const t = timeKey(raw);
    return t ? { time: t } : {};
  });

  // Numbered-list markers ("1. Choose…") are structure, not claims.
  LIST_MARKER_RE.lastIndex = 0;
  for (const m of text.matchAll(LIST_MARKER_RE)) taken.push([m.index, m.index + m[0].length]);

  for (const n of findNumbers(text)) {
    if (overlaps(n.start, n.end)) continue;
    claims.push({
      kind: 'number',
      text: text.slice(n.start, n.end),
      start: n.start,
      end: n.end,
      numbers: [n.readings],
      dateKeys: [],
    });
  }

  WEEKDAY_RES.forEach((re, i) => {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      claims.push({
        kind: 'weekday',
        text: text.slice(m.index, m.index + m[0].length),
        start: m.index,
        end: m.index + m[0].length,
        numbers: [],
        dateKeys: [],
        weekday: i + 1,
      });
    }
  });

  for (const [group, re] of CONCEPT_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      claims.push({
        kind: group,
        text: text.slice(m.index, m.index + m[0].length),
        start: m.index,
        end: m.index + m[0].length,
        numbers: [],
        dateKeys: [],
      });
    }
  }

  return claims.sort((a, b) => a.start - b.start);
}

export interface Evidence {
  /** Every number anywhere in the sources (for bare-number claims). */
  numbers: Set<string>;
  /** Numbers the sources state as money, durations or percentages. */
  money: Set<string>;
  durations: Set<string>;
  percentages: Set<string>;
  times: Set<string>;
  dateKeys: Set<string>;
  weekdays: Set<number>;
  concepts: Set<ConceptGroup>;
}

export function collectEvidence(texts: string[]): Evidence {
  const joined = texts.join('\n\n');
  const claims = detectClaims(joined);
  const concepts = new Set<ConceptGroup>();
  for (const c of claims) {
    if (c.kind in CONCEPTS) concepts.add(c.kind as ConceptGroup);
  }
  const folded = foldForMatching(joined);
  const ofKind = (kind: ClaimKind) =>
    new Set(claims.filter((c) => c.kind === kind).flatMap((c) => c.numbers.flat()));
  const money = ofKind('money');
  // Tables often separate amount and currency ("Price (EUR): 24"): accept a
  // number with a currency token within a few characters of it.
  for (const n of findNumbers(folded)) {
    const around = folded.slice(Math.max(0, n.start - MONEY_WINDOW), n.end + MONEY_WINDOW);
    if (CURRENCY_NEAR_RE.test(around)) n.readings.forEach((r) => money.add(r));
  }
  return {
    numbers: numberSet(folded),
    money,
    durations: ofKind('duration'),
    percentages: ofKind('percentage'),
    times: new Set(claims.flatMap((c) => (c.time ? [c.time] : []))),
    dateKeys: new Set(claims.flatMap((c) => c.dateKeys)),
    weekdays: new Set(claims.flatMap((c) => (c.weekday ? [c.weekday] : []))),
    concepts,
  };
}

export interface ClaimVerification {
  claims: Claim[];
  unsupported: Claim[];
}

/**
 * A claim is supported only if the cited knowledge-base chunks back it
 * literally (numbers normalised across formats), as the same kind of
 * statement: "24 hours" is not backed by "24 EUR". Bare numbers may also be
 * echoes of the customer's own email (order numbers, quantities); money,
 * percentages, durations, dates and commitments may not.
 */
export function verifyClaims(
  reply: string,
  { citedSources, inboundText }: { citedSources: string[]; inboundText: string },
): ClaimVerification {
  const claims = detectClaims(reply);
  const evidence = collectEvidence(citedSources);
  const inboundNumbers = numberSet(foldForMatching(inboundText));
  const backedBy = (numbers: string[][], ...pools: Set<string>[]) =>
    numbers.every((readings) => readings.some((r) => pools.some((p) => p.has(r))));

  const unsupported = claims.filter((c) => {
    switch (c.kind) {
      case 'money':
        return !backedBy(c.numbers, evidence.money);
      case 'percentage':
        return !backedBy(c.numbers, evidence.percentages);
      case 'duration':
        return !backedBy(c.numbers, evidence.durations);
      case 'number':
        return !backedBy(c.numbers, evidence.numbers, inboundNumbers);
      case 'time': {
        if (!c.time) return true;
        const [h, m] = c.time.split(':');
        return !(
          evidence.times.has(c.time) ||
          (m === '00' && evidence.numbers.has(String(Number(h))))
        );
      }
      case 'date':
        return !c.dateKeys.some((k) => evidence.dateKeys.has(k));
      case 'weekday':
        return !evidence.weekdays.has(c.weekday ?? 0);
      default:
        return !evidence.concepts.has(c.kind);
    }
  });
  return { claims, unsupported };
}
