import { nextBusinessWindowStart } from '../schedule/business-time.ts';

/**
 * Value report (PLAN.md §26): what Noctiv did for a business in a period —
 * the dashboard's "This month" card and the Monday e-mail. Everything is
 * counted from what was actually sent, received or paid; the only estimate
 * is "hours saved", from the owner's own minutes per reply and follow-up.
 */

export interface MoneyTotal {
  currency: string;
  count: number;
  totalCents: number;
}

/** Raw facts for a period (packages/db loadValueRows). */
export interface ValueRows {
  /** Customer e-mails answered in the period: when each arrived and its first reply went out. */
  replies: { receivedAt: Date; sentAt: Date }[];
  followupsSent: number;
  /** Conversations where the customer wrote back after a follow-up. */
  wonBack: number;
  quotesSent: MoneyTotal[];
  quotesAccepted: MoneyTotal[];
  invoicesPaid: MoneyTotal[];
}

export interface ValueAssumptions {
  /** Minutes the owner would spend on one reply (default 4). */
  minutesPerReply: number;
  /** Minutes the owner would spend on one follow-up (default 3). */
  minutesPerFollowup: number;
}

export const DEFAULT_VALUE_ASSUMPTIONS: ValueAssumptions = {
  minutesPerReply: 4,
  minutesPerFollowup: 3,
};

export interface ValueReport {
  answered: number;
  /** Average time from the customer's e-mail to the reply (seconds), or null. */
  avgReplySeconds: number | null;
  /**
   * The same e-mails answered only in business hours (Mon–Fri 09:00–17:00
   * local): a reply can't start before the window opens and is never faster
   * than the actual one. Seconds, or null.
   */
  avgBusinessHoursSeconds: number | null;
  /** Share of answered e-mails that arrived outside business hours (0–1), or null. */
  outsideHoursShare: number | null;
  followupsSent: number;
  wonBack: number;
  quotesSent: MoneyTotal[];
  quotesAccepted: MoneyTotal[];
  invoicesPaid: MoneyTotal[];
  minutesSaved: number;
  assumptions: ValueAssumptions;
  /** The fastest reply of the period. */
  fastest: { seconds: number; sentAt: string } | null;
}

export function computeValue(
  rows: ValueRows,
  opts: { timeZone: string; assumptions: ValueAssumptions },
): ValueReport {
  const actual: number[] = [];
  const baseline: number[] = [];
  let outside = 0;
  let fastest: ValueReport['fastest'] = null;
  for (const r of rows.replies) {
    const took = Math.max(0, (r.sentAt.getTime() - r.receivedAt.getTime()) / 1000);
    const opens = nextBusinessWindowStart(r.receivedAt, opts.timeZone);
    const wait = Math.max(0, (opens.getTime() - r.receivedAt.getTime()) / 1000);
    if (wait > 0) outside++;
    actual.push(took);
    baseline.push(Math.max(took, wait));
    if (!fastest || took < fastest.seconds)
      fastest = { seconds: Math.round(took), sentAt: r.sentAt.toISOString() };
  }
  const avg = (xs: number[]) =>
    xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  const answered = rows.replies.length;
  return {
    answered,
    avgReplySeconds: avg(actual),
    avgBusinessHoursSeconds: avg(baseline),
    outsideHoursShare: answered ? outside / answered : null,
    followupsSent: rows.followupsSent,
    wonBack: rows.wonBack,
    quotesSent: rows.quotesSent,
    quotesAccepted: rows.quotesAccepted,
    invoicesPaid: rows.invoicesPaid,
    minutesSaved:
      answered * opts.assumptions.minutesPerReply +
      rows.followupsSent * opts.assumptions.minutesPerFollowup,
    assumptions: opts.assumptions,
    fastest,
  };
}

/** True when nothing happened in the period (no weekly e-mail then). */
export const isEmptyValue = (v: ValueReport) =>
  v.answered === 0 &&
  v.followupsSent === 0 &&
  v.wonBack === 0 &&
  v.quotesSent.length === 0 &&
  v.quotesAccepted.length === 0 &&
  v.invoicesPaid.length === 0;

/** "41 seconds", "3 min", "2 h 5 min", "1 day 3 h". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} ${s === 1 ? 'second' : 'seconds'}`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24
    ? `${d} ${d === 1 ? 'day' : 'days'} ${h % 24} h`
    : `${d} ${d === 1 ? 'day' : 'days'}`;
}

/** "13 h" or "45 min" for minutes saved. */
export function formatSaved(minutes: number): string {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = minutes / 60;
  return `${h < 10 ? Math.round(h * 10) / 10 : Math.round(h)} h`;
}

/** "Fastest reply: 41 seconds at 23:12 on Tuesday" in the business's time zone. */
export function fastestLine(f: NonNullable<ValueReport['fastest']>, timeZone: string): string {
  const at = new Date(f.sentAt);
  const time = at.toLocaleTimeString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const day = at.toLocaleDateString('en-GB', { timeZone, weekday: 'long' });
  return `Fastest reply: ${formatDuration(f.seconds)} at ${time} on ${day}`;
}
