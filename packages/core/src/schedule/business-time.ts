/**
 * Follow-up timing (PLAN.md §11 Q7): business days are Mon–Fri, and
 * follow-ups go out 09:00–17:00 in the tenant's time zone. A due time outside
 * that window moves to the next window start. No public-holiday calendar.
 */
export const BUSINESS_START_HOUR = 9;
export const BUSINESS_END_HOUR = 17;

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function localParts(date: Date, timeZone: string): LocalParts {
  const p = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(date)
      .filter((x) => x.type !== 'literal')
      .map((x) => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return {
    year: p.year!,
    month: p.month!,
    day: p.day!,
    hour: p.hour!,
    minute: p.minute!,
    second: p.second!,
  };
}

/** Offset (ms) of the zone from UTC at the given instant. */
function offsetAt(instant: number, timeZone: string): number {
  const p = localParts(new Date(instant), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The instant at which the wall clock in `timeZone` shows the given local time. */
export function zonedTimeToUtc(p: LocalParts, timeZone: string): Date {
  const guess = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  let result = guess - offsetAt(guess, timeZone);
  // Second pass settles instants next to a DST change.
  result = guess - offsetAt(result, timeZone);
  return new Date(result);
}

/** 0 = Sunday … 6 = Saturday, for a calendar date. */
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const isBusinessDay = (y: number, m: number, d: number) => {
  const w = weekday(y, m, d);
  return w !== 0 && w !== 6;
};
function addCalendarDays(p: LocalParts, n: number): LocalParts {
  const t = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return { ...p, year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** Moves a local time into the business window (unchanged if already inside). */
function clampToWindow(p: LocalParts): LocalParts {
  let q = p;
  const minutes = q.hour * 60 + q.minute;
  if (isBusinessDay(q.year, q.month, q.day) && minutes < BUSINESS_START_HOUR * 60) {
    return { ...q, hour: BUSINESS_START_HOUR, minute: 0, second: 0 };
  }
  if (isBusinessDay(q.year, q.month, q.day) && minutes < BUSINESS_END_HOUR * 60) return q;
  do q = addCalendarDays(q, 1);
  while (!isBusinessDay(q.year, q.month, q.day));
  return { ...q, hour: BUSINESS_START_HOUR, minute: 0, second: 0 };
}

/**
 * When the next follow-up is due: `businessDays` Mon–Fri days after
 * `from` (same local time of day), moved into 09:00–17:00 local time.
 */
export function nextFollowupAt(from: Date, businessDays: number, timeZone: string): Date {
  if (!Number.isInteger(businessDays) || businessDays < 0) throw new Error('invalid businessDays');
  let p = localParts(from, timeZone);
  let left = businessDays;
  while (left > 0) {
    p = addCalendarDays(p, 1);
    if (isBusinessDay(p.year, p.month, p.day)) left--;
  }
  return zonedTimeToUtc(clampToWindow(p), timeZone);
}

/** True when `at` falls inside the tenant's business window. */
export function isWithinBusinessWindow(at: Date, timeZone: string): boolean {
  const p = localParts(at, timeZone);
  const c = clampToWindow(p);
  return c === p;
}
