import { describe, expect, it } from 'vitest';
import {
  computeValue,
  DEFAULT_VALUE_ASSUMPTIONS,
  fastestLine,
  formatDuration,
  formatSaved,
  isEmptyValue,
  localDate,
  localMonthStart,
  localWeekStart,
  nextBusinessWindowStart,
  verifyWeeklyReportToken,
  weeklyReportToken,
  type ValueRows,
} from '../src/index.ts';

const TZ = 'Europe/Riga';
const empty: ValueRows = {
  replies: [],
  followupsSent: 0,
  wonBack: 0,
  quotesSent: [],
  quotesAccepted: [],
  invoicesPaid: [],
};

describe('value report (PLAN.md §26)', () => {
  it('reply times: Noctiv vs. answering only in business hours', () => {
    const v = computeValue(
      {
        ...empty,
        replies: [
          // Tuesday 10:00 Riga (inside hours), answered in 2 min: same in both.
          {
            receivedAt: new Date('2026-09-29T07:00:00Z'),
            sentAt: new Date('2026-09-29T07:02:00Z'),
          },
          // Tuesday 23:11:19 Riga, answered in 41 s; business hours: Wednesday 09:00.
          {
            receivedAt: new Date('2026-09-29T20:11:19Z'),
            sentAt: new Date('2026-09-29T20:12:00Z'),
          },
        ],
        followupsSent: 5,
      },
      { timeZone: TZ, assumptions: DEFAULT_VALUE_ASSUMPTIONS },
    );
    expect(v.answered).toBe(2);
    expect(v.avgReplySeconds).toBe(Math.round((120 + 41) / 2));
    // 23:11:19 → 09:00 next day = 9 h 48 min 41 s = 35321 s.
    expect(v.avgBusinessHoursSeconds).toBe(Math.round((120 + 35321) / 2));
    expect(v.outsideHoursShare).toBe(0.5);
    expect(v.minutesSaved).toBe(2 * 4 + 5 * 3);
    expect(fastestLine(v.fastest!, TZ)).toBe('Fastest reply: 41 seconds at 23:12 on Tuesday');
  });

  it('a Friday-evening e-mail waits for Monday 09:00 in business hours', () => {
    const fri = new Date('2026-10-02T16:00:00Z'); // Friday 19:00 Riga
    expect(nextBusinessWindowStart(fri, TZ).toISOString()).toBe('2026-10-05T06:00:00.000Z');
  });

  it('nothing happened → empty; assumptions are the owner’s', () => {
    const v = computeValue(empty, {
      timeZone: TZ,
      assumptions: { minutesPerReply: 6, minutesPerFollowup: 0 },
    });
    expect(isEmptyValue(v)).toBe(true);
    expect(v.avgReplySeconds).toBeNull();
    expect(
      computeValue(
        { ...empty, followupsSent: 2 },
        { timeZone: TZ, assumptions: { minutesPerReply: 6, minutesPerFollowup: 0 } },
      ).minutesSaved,
    ).toBe(0);
  });

  it('local week and month starts, also across the DST change', () => {
    // Sunday 25 Oct 2026, 12:00 Riga (EET after the change at 04:00).
    const sun = new Date('2026-10-25T10:00:00Z');
    expect(localWeekStart(sun, TZ).toISOString()).toBe('2026-10-18T21:00:00.000Z'); // Mon 19 Oct 00:00 EEST
    expect(localMonthStart(sun, TZ).toISOString()).toBe('2026-09-30T21:00:00.000Z');
    expect(localDate(localWeekStart(sun, TZ), TZ)).toBe('2026-10-19');
    // Monday 26 Oct 08:30 Riga.
    expect(localDate(localWeekStart(new Date('2026-10-26T06:30:00Z'), TZ), TZ)).toBe('2026-10-26');
  });

  it('formats durations and time saved', () => {
    expect(formatDuration(41)).toBe('41 seconds');
    expect(formatDuration(1)).toBe('1 second');
    expect(formatDuration(180)).toBe('3 min');
    expect(formatDuration(35_321)).toBe('9 h 49 min');
    expect(formatDuration(3 * 86_400 + 2 * 3600)).toBe('3 days 2 h');
    expect(formatSaved(45)).toBe('45 min');
    expect(formatSaved(800)).toBe('13 h');
    expect(formatSaved(174)).toBe('2.9 h');
  });

  it('unsubscribe link token', () => {
    const id = '4e735171-687e-4485-9f59-13a2c6d85e0e';
    const secret = 's'.repeat(40);
    const t = weeklyReportToken(id, secret);
    expect(verifyWeeklyReportToken(id, t, secret)).toBe(true);
    expect(verifyWeeklyReportToken(id, t, 'x'.repeat(40))).toBe(false);
    expect(verifyWeeklyReportToken('5e735171-687e-4485-9f59-13a2c6d85e0e', t, secret)).toBe(false);
  });
});
