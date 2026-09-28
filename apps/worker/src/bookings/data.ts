import {
  DEFAULT_SETTINGS,
  freeSlots,
  GoogleAuthError,
  openCalendarToken,
  type BookingSettings,
  type GoogleCalendarApi,
  type Interval,
  type Slot,
} from '@noctiv/bookings';
import type { Logger } from '@noctiv/core';
import type { TransactionSql } from 'postgres';

/**
 * Bookings (beta) in the worker (PLAN.md §29): settings, free times, and the
 * calendar. Only the worker can open the calendar's refresh token.
 */
export interface BookingDeps {
  keys: { publicKey: string; privateKey: string };
  google?: GoogleCalendarApi;
  /** Signs the manage and reply links (ACTION_LINK_SECRET). */
  secret?: string;
  /** app.noctiv.io: the booking page lives at <appUrl>/book/<slug>. */
  appUrl: string;
  logger?: Logger;
}

export async function loadBookingSettings(tx: TransactionSql): Promise<BookingSettings> {
  const [r] = await tx<
    {
      hours: BookingSettings['hours'];
      slot_minutes: number;
      buffer_minutes: number;
      notice_hours: number;
      horizon_days: number;
      location_kind: BookingSettings['locationKind'];
      location_text: string;
      meeting_title: string;
      form_id: string | null;
    }[]
  >`select hours, slot_minutes, buffer_minutes, notice_hours, horizon_days, location_kind,
           location_text, meeting_title, form_id
    from public.booking_settings`;
  return r
    ? {
        hours: r.hours,
        slotMinutes: r.slot_minutes,
        bufferMinutes: r.buffer_minutes,
        noticeHours: r.notice_hours,
        horizonDays: r.horizon_days,
        locationKind: r.location_kind,
        locationText: r.location_text,
        meetingTitle: r.meeting_title,
        formId: r.form_id,
      }
    : DEFAULT_SETTINGS;
}

export async function busyFromDb(
  tx: TransactionSql,
  from: Date,
  to: Date,
  exceptBookingId: string | null = null,
): Promise<Interval[]> {
  const rows = await tx<{ s: Date; e: Date }[]>`
    select starts_at as s, ends_at as e from public.calendar_busy
    where ends_at > ${from} and starts_at < ${to}
    union all
    select starts_at, ends_at from public.bookings
    where status in ('pending', 'confirmed') and ends_at > ${from} and starts_at < ${to}
      and id is distinct from ${exceptBookingId}`;
  return rows.map((r) => ({ start: r.s, end: r.e }));
}

/** The next free times, from the cached calendar and Noctiv's own bookings. */
export async function nextFreeSlots(
  tx: TransactionSql,
  timeZone: string,
  limit: number,
  now = new Date(),
): Promise<{ settings: BookingSettings; slots: Slot[] }> {
  const settings = await loadBookingSettings(tx);
  const busy = await busyFromDb(
    tx,
    now,
    new Date(now.getTime() + (settings.horizonDays + 1) * 86_400_000),
  );
  return { settings, slots: freeSlots({ settings, timeZone, busy, now, limit }) };
}

export interface CalendarHandle {
  api: GoogleCalendarApi;
  accessToken: string;
  connectionId: string;
}

/**
 * An access token for the business's calendar, or null without a connected
 * calendar. A revoked token marks the connection 'error' and tells the owner
 * once (the booking page keeps working from Noctiv's own bookings).
 */
export async function openCalendar(
  deps: BookingDeps,
  tx: TransactionSql,
  tenantId: string,
): Promise<CalendarHandle | null> {
  if (!deps.google) return null;
  const [c] = await tx<{ id: string; status: string; credentials_ciphertext: Buffer }[]>`
    select id, status, credentials_ciphertext from public.calendar_connections`;
  if (!c || c.status !== 'connected') return null;
  const refresh = openCalendarToken(c.credentials_ciphertext, deps.keys, tenantId, c.id);
  try {
    return {
      api: deps.google,
      accessToken: await deps.google.accessToken(refresh),
      connectionId: c.id,
    };
  } catch (err) {
    if (err instanceof GoogleAuthError) {
      await markCalendarError(tx, tenantId, c.id, 'access_revoked');
      return null;
    }
    throw err;
  }
}

export async function markCalendarError(
  tx: TransactionSql,
  tenantId: string,
  connectionId: string,
  code: string,
): Promise<void> {
  const [changed] = await tx<{ id: string }[]>`
    update public.calendar_connections set status = 'error', last_error = ${code}
    where id = ${connectionId} and status = 'connected' returning id`;
  if (!changed) return;
  await tx`delete from public.calendar_busy`;
  await tx`
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    values (${tenantId}, 'email_owner', 'calendar_disconnected', ${`calendar_disconnected:${connectionId}`},
            ${tx.json({ code })})
    on conflict do nothing`;
  await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
           values (${tenantId}, 'system', 'calendar.error', 'calendar_connection', ${connectionId},
                   ${tx.json({ code })})`;
}

/** The booking page address, if Bookings has one. */
export async function bookingPage(
  tx: TransactionSql,
  appUrl: string,
): Promise<{ slug: string; url: string } | null> {
  const [t] = await tx<{ booking_slug: string | null }[]>`select booking_slug from public.tenants`;
  return t?.booking_slug
    ? { slug: t.booking_slug, url: `${appUrl.replace(/\/+$/, '')}/book/${t.booking_slug}` }
    : null;
}
