import { localDate, localParts, zonedTimeToUtc } from '@noctiv/core';
import type { BookingSettings } from './settings.ts';

/**
 * Free times (PLAN.md §29.3). The weekly hours are wall-clock times in the
 * business's time zone; each window is cut into slots of `slotMinutes` from
 * its start. A slot is free when it starts after now + notice, ends within
 * the horizon, and neither the slot nor the buffer around it overlaps a busy
 * interval (the calendar's, or another pending or confirmed booking).
 */
export interface Interval {
  start: Date;
  end: Date;
}
export interface Slot {
  start: Date;
  end: Date;
}

export interface FreeSlotInput {
  settings: Pick<
    BookingSettings,
    'hours' | 'slotMinutes' | 'bufferMinutes' | 'noticeHours' | 'horizonDays'
  >;
  timeZone: string;
  busy: Interval[];
  now: Date;
  /** Start searching here (default now). */
  from?: Date;
  /** Stop after this many slots. */
  limit?: number;
}

const MIN = 60_000;

/** 1 = Monday … 7 = Sunday, for a local calendar date. */
function isoWeekday(y: number, m: number, d: number): number {
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return w === 0 ? 7 : w;
}

export function freeSlots(i: FreeSlotInput): Slot[] {
  const s = i.settings;
  const earliest = Math.max(
    i.now.getTime() + s.noticeHours * 60 * MIN,
    (i.from ?? i.now).getTime(),
  );
  const latest = i.now.getTime() + s.horizonDays * 24 * 60 * MIN;
  const buffer = s.bufferMinutes * MIN;
  const busy = i.busy
    .map((b) => ({ start: b.start.getTime() - buffer, end: b.end.getTime() + buffer }))
    .sort((a, b) => a.start - b.start);
  const out: Slot[] = [];
  const limit = i.limit ?? Number.POSITIVE_INFINITY;

  const first = localParts(new Date(earliest), i.timeZone);
  // Walk local calendar days from the first possible one to the horizon.
  for (let n = 0; n <= s.horizonDays + 1 && out.length < limit; n++) {
    const day = new Date(Date.UTC(first.year, first.month - 1, first.day + n));
    const y = day.getUTCFullYear();
    const m = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    const windows = s.hours[String(isoWeekday(y, m, d)) as keyof typeof s.hours] ?? [];
    for (const w of [...windows].sort((a, b) => a.from.localeCompare(b.from))) {
      const [fh, fm] = w.from.split(':').map(Number) as [number, number];
      const [th, tm] = w.to.split(':').map(Number) as [number, number];
      const windowEnd = zonedTimeToUtc(
        { year: y, month: m, day: d, hour: th, minute: tm, second: 0 },
        i.timeZone,
      ).getTime();
      // Slots follow the wall clock from the window's start (DST-safe).
      for (let k = 0; ; k++) {
        const startMinutes = fh * 60 + fm + k * s.slotMinutes;
        const start = zonedTimeToUtc(
          {
            year: y,
            month: m,
            day: d,
            hour: Math.floor(startMinutes / 60),
            minute: startMinutes % 60,
            second: 0,
          },
          i.timeZone,
        ).getTime();
        const end = start + s.slotMinutes * MIN;
        if (end > windowEnd || startMinutes >= 24 * 60) break;
        if (start < earliest || end > latest) continue;
        if (busy.some((b) => b.start < end && b.end > start)) continue;
        out.push({ start: new Date(start), end: new Date(end) });
        if (out.length >= limit) break;
      }
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** True when this exact slot is on offer (the booking page's POST check). */
export function isFreeSlot(i: FreeSlotInput, start: Date): Slot | null {
  const day = localParts(start, i.timeZone);
  const from = zonedTimeToUtc({ ...day, hour: 0, minute: 0, second: 0 }, i.timeZone);
  return freeSlots({ ...i, from }).find((s) => s.start.getTime() === start.getTime()) ?? null;
}

/** Slots grouped by local calendar day ("YYYY-MM-DD" in the business's zone), in order. */
export function groupByDay(slots: Slot[], timeZone: string): { date: string; slots: Slot[] }[] {
  const out: { date: string; slots: Slot[] }[] = [];
  for (const s of slots) {
    const date = localDate(s.start, timeZone);
    const last = out[out.length - 1];
    if (last?.date === date) last.slots.push(s);
    else out.push({ date, slots: [s] });
  }
  return out;
}
