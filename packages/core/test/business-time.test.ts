import { describe, expect, it } from 'vitest';
import {
  isWithinBusinessWindow,
  nextFollowupAt,
  zonedTimeToUtc,
} from '../src/schedule/business-time.ts';

const RIGA = 'Europe/Riga';
const iso = (d: Date) => d.toISOString();

describe('nextFollowupAt (Q7: Mon–Fri, 09:00–17:00 tenant time)', () => {
  it('keeps the local time of day when it is inside the window', () => {
    // Tue 2026-09-22 11:30 Riga (UTC+3) + 3 business days = Fri 11:30.
    expect(iso(nextFollowupAt(new Date('2026-09-22T08:30:00Z'), 3, RIGA))).toBe(
      '2026-09-25T08:30:00.000Z',
    );
  });

  it('skips weekends', () => {
    // Thu 2026-09-24 10:00 Riga + 3 = Tue 2026-09-29 10:00.
    expect(iso(nextFollowupAt(new Date('2026-09-24T07:00:00Z'), 3, RIGA))).toBe(
      '2026-09-29T07:00:00.000Z',
    );
  });

  it('moves an evening time to 09:00 the next business day', () => {
    // Fri 2026-09-25 18:15 Riga + 1 = Mon 18:15 → Tue 09:00.
    expect(iso(nextFollowupAt(new Date('2026-09-25T15:15:00Z'), 1, RIGA))).toBe(
      '2026-09-29T06:00:00.000Z',
    );
  });

  it('moves an early-morning time to 09:00 the same day', () => {
    // Mon 2026-09-21 06:00 Riga + 2 = Wed 06:00 → Wed 09:00.
    expect(iso(nextFollowupAt(new Date('2026-09-21T03:00:00Z'), 2, RIGA))).toBe(
      '2026-09-23T06:00:00.000Z',
    );
  });

  it('17:00 exactly is outside the window', () => {
    expect(iso(nextFollowupAt(new Date('2026-09-21T14:00:00Z'), 1, RIGA))).toBe(
      '2026-09-23T06:00:00.000Z',
    );
  });

  it('counts from a weekend send to the following business days', () => {
    // Sat 2026-09-26 12:00 Riga + 1 = Mon 12:00.
    expect(iso(nextFollowupAt(new Date('2026-09-26T09:00:00Z'), 1, RIGA))).toBe(
      '2026-09-28T09:00:00.000Z',
    );
  });

  it('uses the offset in force on the due date across a DST change', () => {
    // Riga leaves summer time on Sun 2026-10-25. Fri 23rd 10:00 (UTC+3) + 1 = Mon 26th 10:00 (UTC+2).
    expect(iso(nextFollowupAt(new Date('2026-10-23T07:00:00Z'), 1, RIGA))).toBe(
      '2026-10-26T08:00:00.000Z',
    );
  });

  it('works for zones west of UTC and across the date line', () => {
    // Mon 2026-09-21 16:30 New York (UTC-4) + 1 = Tue 16:30.
    expect(iso(nextFollowupAt(new Date('2026-09-21T20:30:00Z'), 1, 'America/New_York'))).toBe(
      '2026-09-22T20:30:00.000Z',
    );
    // Mon 2026-09-21 20:00 Auckland (UTC+12) + 1 = Tue 20:00 → Wed 09:00 (UTC+12).
    expect(iso(nextFollowupAt(new Date('2026-09-21T08:00:00Z'), 1, 'Pacific/Auckland'))).toBe(
      '2026-09-22T21:00:00.000Z',
    );
  });

  it('with zero days only moves the time into the window', () => {
    const inside = new Date('2026-09-22T08:30:00Z');
    expect(iso(nextFollowupAt(inside, 0, RIGA))).toBe(iso(inside));
  });

  it('rejects invalid input', () => {
    expect(() => nextFollowupAt(new Date(), -1, RIGA)).toThrow();
    expect(() => nextFollowupAt(new Date(), 1, 'Not/AZone')).toThrow();
  });
});

describe('helpers', () => {
  it('zonedTimeToUtc', () => {
    expect(
      iso(
        zonedTimeToUtc(
          { year: 2026, month: 1, day: 5, hour: 9, minute: 0, second: 0 },
          'Europe/Riga',
        ),
      ),
    ).toBe('2026-01-05T07:00:00.000Z');
  });

  it('isWithinBusinessWindow', () => {
    expect(isWithinBusinessWindow(new Date('2026-09-22T08:30:00Z'), RIGA)).toBe(true);
    expect(isWithinBusinessWindow(new Date('2026-09-26T08:30:00Z'), RIGA)).toBe(false);
    expect(isWithinBusinessWindow(new Date('2026-09-22T15:00:00Z'), RIGA)).toBe(false);
  });
});
