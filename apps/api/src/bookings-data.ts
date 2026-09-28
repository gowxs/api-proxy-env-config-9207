import {
  DEFAULT_SETTINGS,
  formFieldSchema,
  slugFromName,
  type BookingSettings,
  type FormField,
  type Interval,
} from '@noctiv/bookings';
import { enqueue } from '@noctiv/db';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';

/**
 * Bookings data shared by the owner routes and the public pages (PLAN.md §29).
 * Everything runs inside the tenant's RLS context.
 */
type Tx = TransactionSql;

interface SettingsRow {
  hours: BookingSettings['hours'];
  slot_minutes: number;
  buffer_minutes: number;
  notice_hours: number;
  horizon_days: number;
  location_kind: BookingSettings['locationKind'];
  location_text: string;
  meeting_title: string;
  form_id: string | null;
}

export async function loadSettings(tx: Tx): Promise<BookingSettings> {
  const [r] = await tx<SettingsRow[]>`
    select hours, slot_minutes, buffer_minutes, notice_hours, horizon_days, location_kind,
           location_text, meeting_title, form_id
    from public.booking_settings`;
  if (!r) return DEFAULT_SETTINGS;
  return {
    hours: r.hours,
    slotMinutes: r.slot_minutes,
    bufferMinutes: r.buffer_minutes,
    noticeHours: r.notice_hours,
    horizonDays: r.horizon_days,
    locationKind: r.location_kind,
    locationText: r.location_text,
    meetingTitle: r.meeting_title,
    formId: r.form_id,
  };
}

export const SETTINGS_COLUMNS: Record<keyof BookingSettings, string> = {
  hours: 'hours',
  slotMinutes: 'slot_minutes',
  bufferMinutes: 'buffer_minutes',
  noticeHours: 'notice_hours',
  horizonDays: 'horizon_days',
  locationKind: 'location_kind',
  locationText: 'location_text',
  meetingTitle: 'meeting_title',
  formId: 'form_id',
};

/**
 * On first switch-on: a booking page address from the business name (made
 * unique with -2, -3 …) and the default settings row.
 */
export async function ensureBookingSetup(tx: Tx, tenantId: string): Promise<void> {
  await tx`insert into public.booking_settings (tenant_id) values (${tenantId}) on conflict do nothing`;
  const [t] = await tx<{ name: string; booking_slug: string | null }[]>`
    select name, booking_slug from public.tenants`;
  if (!t || t.booking_slug) return;
  const base = slugFromName(t.name);
  for (let n = 1; n < 50; n++) {
    const slug = n === 1 ? base : `${base.slice(0, 37)}-${n}`;
    const [taken] = await tx<
      { taken: boolean }[]
    >`select app.booking_slug_taken(${slug}, ${tenantId}) as taken`;
    if (!taken!.taken) {
      await tx`update public.tenants set booking_slug = ${slug} where id = ${tenantId}`;
      return;
    }
  }
}

/** Busy time for free-time checks: the calendar's (cached) and Noctiv's own bookings. */
export async function busyIntervals(tx: Tx, from: Date, to: Date): Promise<Interval[]> {
  const rows = await tx<{ s: Date; e: Date }[]>`
    select starts_at as s, ends_at as e from public.calendar_busy
    where ends_at > ${from} and starts_at < ${to}
    union all
    select starts_at, ends_at from public.bookings
    where status in ('pending', 'confirmed') and ends_at > ${from} and starts_at < ${to}`;
  return rows.map((r) => ({ start: r.s, end: r.e }));
}

/** Queue a calendar refresh when the cached busy times are older than 2 minutes. */
export async function refreshCalendarIfStale(tx: Tx, tenantId: string): Promise<void> {
  const [c] = await tx<{ stale: boolean }[]>`
    select status = 'connected' and (synced_at is null or synced_at < now() - interval '2 minutes') as stale
    from public.calendar_connections`;
  if (c?.stale)
    await enqueue(tx, {
      tenantId,
      queue: 'calendar.sync',
      singletonKey: `calendar.sync:${tenantId}`,
      maxAttempts: 2,
    });
}

export async function loadForm(
  tx: Tx,
  formId: string | null,
): Promise<{ id: string; name: string; intro: string; fields: FormField[] } | null> {
  if (!formId) return null;
  const [f] = await tx<{ id: string; name: string; intro: string; fields: unknown }[]>`
    select id, name, intro, fields from public.intake_forms where id = ${formId} and archived_at is null`;
  if (!f) return null;
  const fields = z.array(formFieldSchema).safeParse(f.fields);
  return { id: f.id, name: f.name, intro: f.intro, fields: fields.success ? fields.data : [] };
}

/** app.noctiv.io/book/<slug> (the dashboard proxies /book/* to the API). */
export const bookingPageUrl = (appUrl: string, slug: string) =>
  `${appUrl.replace(/\/+$/, '')}/book/${slug}`;
export const formPageUrl = (appUrl: string, token: string) =>
  `${appUrl.replace(/\/+$/, '')}/f/${token}`;
