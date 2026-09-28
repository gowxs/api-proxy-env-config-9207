import { z } from 'zod';

/**
 * Booking settings (PLAN.md §29.1): weekly hours in the business's time zone,
 * slot length, buffer, notice, horizon and where the meeting happens.
 */
export const LOCATION_KINDS = ['in_person', 'phone', 'online_link', 'google_meet'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export const hoursWindowSchema = z
  .object({ from: z.string().regex(TIME), to: z.string().regex(TIME) })
  .refine((w) => minutesOf(w.to) > minutesOf(w.from), { message: 'ends before it starts' });
export type HoursWindow = z.infer<typeof hoursWindowSchema>;

/** Keys "1" (Monday) … "7" (Sunday); a missing or empty day is closed. */
export const weeklyHoursSchema = z
  .partialRecord(z.enum(['1', '2', '3', '4', '5', '6', '7']), z.array(hoursWindowSchema).max(4))
  .refine(
    (h) =>
      Object.values(h).every((ws = []) => {
        const sorted = [...ws].sort((a, b) => minutesOf(a.from) - minutesOf(b.from));
        return sorted.every((w, i) => i === 0 || minutesOf(w.from) >= minutesOf(sorted[i - 1]!.to));
      }),
    { message: 'windows on the same day overlap' },
  );
export type WeeklyHours = z.infer<typeof weeklyHoursSchema>;

export const DEFAULT_HOURS: WeeklyHours = Object.fromEntries(
  ['1', '2', '3', '4', '5'].map((d) => [d, [{ from: '09:00', to: '17:00' }]]),
) as WeeklyHours;

export interface BookingSettings {
  hours: WeeklyHours;
  slotMinutes: number;
  bufferMinutes: number;
  noticeHours: number;
  horizonDays: number;
  locationKind: LocationKind;
  locationText: string;
  meetingTitle: string;
  formId: string | null;
}

export const DEFAULT_SETTINGS: BookingSettings = {
  hours: DEFAULT_HOURS,
  slotMinutes: 30,
  bufferMinutes: 15,
  noticeHours: 12,
  horizonDays: 30,
  locationKind: 'online_link',
  locationText: '',
  meetingTitle: '',
  formId: null,
};

/** PATCH body: every field optional; checked again as a whole (location). */
export const bookingSettingsPatch = z
  .object({
    hours: weeklyHoursSchema,
    slotMinutes: z.number().int().min(15).max(240),
    bufferMinutes: z.number().int().min(0).max(120),
    noticeHours: z.number().int().min(0).max(336),
    horizonDays: z.number().int().min(1).max(90),
    locationKind: z.enum(LOCATION_KINDS),
    locationText: z.string().trim().max(500),
    meetingTitle: z.string().trim().max(120),
    formId: z.uuid().nullable(),
  })
  .partial()
  .strict();

/** What must be true before the booking page can take a booking. */
export function settingsProblems(s: BookingSettings): string[] {
  const out: string[] = [];
  if (!Object.values(s.hours).some((ws) => ws?.length)) out.push('no_hours');
  if (s.locationKind === 'online_link' && !/^https:\/\/\S+$/.test(s.locationText))
    out.push('online_link_missing');
  if (s.locationKind === 'in_person' && !s.locationText) out.push('address_missing');
  return out;
}

// ------------------------------------------------------------------ slug

export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const RESERVED_SLUGS = new Set([
  'api',
  'app',
  'admin',
  'book',
  'bookings',
  'help',
  'login',
  'manage',
  'noctiv',
  'settings',
  'signup',
  'support',
  'www',
]);

export function slugProblem(slug: string): 'format' | 'reserved' | null {
  if (!SLUG.test(slug) || slug.includes('--')) return 'format';
  if (RESERVED_SLUGS.has(slug)) return 'reserved';
  return null;
}

/** "Nordlicht Candles GmbH" → "nordlicht-candles-gmbh"; accents folded. */
export function slugFromName(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  const slug = base.length >= 3 ? base : `${base || 'book'}-now`.slice(0, 40);
  return RESERVED_SLUGS.has(slug) ? `${slug}-1` : slug;
}
