import {
  bookingEmail,
  googleEventId,
  GoogleAuthError,
  openCalendarToken,
  signManageToken,
  type BookingEmailKind,
} from '@noctiv/bookings';
import { enqueue, JobError, withTenant, type Job } from '@noctiv/db';
import type { Sql, TransactionSql } from 'postgres';
import {
  bookingPage,
  loadBookingSettings,
  markCalendarError,
  openCalendar,
  type BookingDeps,
} from '../bookings/data.ts';
import { setLeadStage } from '../pipeline/leads.ts';
import { QUEUES } from '../queues.ts';

/**
 * Bookings (beta) jobs (PLAN.md §29.2–§29.5):
 *   calendar.sync        free/busy of the primary calendar → calendar_busy
 *   calendar.disconnect  revoke the token at Google, then delete the connection
 *   bookings.confirm     re-check the time, create (or move) the event, confirm,
 *                        lead → booked, answers stored, e-mails queued
 *   bookings.cancel      delete the event, e-mail the customer, tell the owner
 */
type Deps = BookingDeps & { sql: Sql };

interface BookingRow {
  id: string;
  lead_id: string | null;
  thread_id: string | null;
  name: string;
  email: string;
  phone: string | null;
  note: string | null;
  answers: { key: string; label: string; type: string; value: string }[];
  starts_at: Date;
  ends_at: Date;
  language: string;
  status: string;
  cancelled_by: string | null;
  rescheduled_from: string | null;
  google_event_id: string | null;
  meet_url: string | null;
  ics_sequence: number;
  ics_uid: string | null;
  source: string;
}

const loadBooking = async (tx: TransactionSql, id: string) => {
  const [b] = await tx<BookingRow[]>`
    select id, lead_id, thread_id, name, email, phone, note, answers, starts_at, ends_at, language, status,
           cancelled_by, rescheduled_from, google_event_id, meet_url, ics_sequence, ics_uid, source
    from public.bookings where id = ${id}`;
  return b ?? null;
};

// ------------------------------------------------------------------ sync

export function calendarSyncHandler(deps: Deps) {
  return async (job: Job) =>
    withTenant(deps.sql, job.tenantId, async (tx) => {
      const [t] = await tx<
        { bookings_enabled: boolean }[]
      >`select bookings_enabled from public.tenants`;
      if (!t?.bookings_enabled) return { skipped: 'bookings_off' };
      const cal = await openCalendar(deps, tx, job.tenantId);
      if (!cal) return { skipped: 'no_calendar' };
      const settings = await loadBookingSettings(tx);
      const now = new Date();
      let busy;
      try {
        busy = await cal.api.freeBusy(
          cal.accessToken,
          new Date(now.getTime() - 3_600_000),
          new Date(now.getTime() + (settings.horizonDays + 2) * 86_400_000),
        );
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          await markCalendarError(tx, job.tenantId, cal.connectionId, 'access_revoked');
          return { status: 'error' };
        }
        throw new JobError('free/busy failed', { retryable: true, retryInSeconds: 60 });
      }
      // Noctiv's own events are in the calendar too; they are counted from the bookings table.
      const own = await tx<{ s: Date; e: Date }[]>`
        select starts_at as s, ends_at as e from public.bookings
        where status in ('pending', 'confirmed') and google_event_id is not null`;
      const mine = (b: { start: Date; end: Date }) =>
        own.some((o) => o.s.getTime() === b.start.getTime() && o.e.getTime() === b.end.getTime());
      await tx`delete from public.calendar_busy`;
      const rows = busy.filter((b) => !mine(b)).slice(0, 2000);
      if (rows.length)
        await tx`insert into public.calendar_busy ${tx(
          rows.map((b) => ({ tenant_id: job.tenantId, starts_at: b.start, ends_at: b.end })),
        )}`;
      await tx`update public.calendar_connections set synced_at = now(), last_error = null where id = ${cal.connectionId}`;
      return { busy: rows.length };
    });
}

/** Every few minutes: queue a sync for calendars not refreshed in 10 minutes. */
export async function scanCalendarSyncs(sql: Sql): Promise<number> {
  const due = await sql<{ tenant_id: string }[]>`select tenant_id from app.calendars_due_sync(100)`;
  for (const { tenant_id } of due)
    await withTenant(sql, tenant_id, (tx) =>
      enqueue(tx, {
        tenantId: tenant_id,
        queue: QUEUES.calendarSync,
        singletonKey: `calendar.sync:${tenant_id}`,
        maxAttempts: 2,
      }),
    );
  return due.length;
}

export function calendarDisconnectHandler(deps: Deps) {
  return async (job: Job) =>
    withTenant(deps.sql, job.tenantId, async (tx) => {
      const [c] = await tx<{ id: string; credentials_ciphertext: Buffer }[]>`
        select id, credentials_ciphertext from public.calendar_connections
        where id = ${String(job.payload.connectionId)} and status = 'revoking'`;
      if (!c) return { skipped: 'gone' };
      if (deps.google) {
        const token = openCalendarToken(c.credentials_ciphertext, deps.keys, job.tenantId, c.id);
        await deps.google.revoke(token);
      }
      await tx`delete from public.calendar_connections where id = ${c.id}`;
      await tx`delete from public.calendar_busy`;
      return { status: 'disconnected' };
    });
}

// --------------------------------------------------------------- e-mails

/**
 * The customer's e-mail (fixed text, .ics attached at send time) as an
 * approved 'booking' draft: in the booking's conversation, else a new one.
 * Sent automatically in every mode (PLAN.md §29.5); none without a mailbox.
 */
async function queueCustomerEmail(
  deps: Deps,
  tx: TransactionSql,
  tenantId: string,
  b: BookingRow,
  kind: BookingEmailKind,
  timeZone: string,
): Promise<{ queued: boolean; threadId: string | null }> {
  const settings = await loadBookingSettings(tx);
  const page = await bookingPage(tx, deps.appUrl);
  const [conn] = await tx<{ id: string }[]>`
    select id from public.email_connections where status = 'connected' order by created_at limit 1`;
  if (!conn) return { queued: false, threadId: b.thread_id };
  const manageUrl =
    page && deps.secret && kind !== 'cancelled_by_customer' && kind !== 'cancelled_by_owner'
      ? `${page.url}/manage/${signManageToken({ tenantId, bookingId: b.id, endsAt: b.ends_at }, deps.secret)}`
      : null;
  const mail = bookingEmail({
    kind,
    language: b.language,
    customerName: b.name,
    start: b.starts_at,
    end: b.ends_at,
    timeZone,
    locationKind: settings.locationKind,
    locationText:
      settings.locationKind === 'google_meet'
        ? (b.meet_url ?? '')
        : settings.locationKind === 'phone'
          ? ''
          : settings.locationText,
    manageUrl,
    bookingUrl: page?.url ?? null,
  });
  let threadId = b.thread_id;
  if (!threadId) {
    const [th] = await tx<{ id: string }[]>`
      insert into public.threads (tenant_id, connection_id, lead_id, subject, followup_stop_reason)
      values (${tenantId}, ${conn.id}, ${b.lead_id}, ${mail.subject}, 'booking')
      returning id`;
    threadId = th!.id;
    await tx`update public.bookings set thread_id = ${threadId} where id = ${b.id}`;
  }
  const [d] = await tx<{ id: string }[]>`
    insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                               status, decided_by, decided_at, booking_id)
    values (${tenantId}, ${threadId}, null, 'booking', ${b.email}, ${mail.subject}, ${mail.text},
            'approved', 'auto', now(), ${b.id})
    returning id`;
  await enqueue(tx, {
    tenantId,
    queue: QUEUES.mailSend,
    payload: { draftId: d!.id, sentVia: 'auto' },
    singletonKey: d!.id,
  });
  return { queued: true, threadId };
}

const ownerPayload = async (tx: TransactionSql, b: BookingRow, extra: Record<string, unknown>) => {
  const [t] = await tx<{ full: boolean; timezone: string }[]>`
    select notify_full_text as full, timezone from public.tenants`;
  return {
    bookingId: b.id,
    leadId: b.lead_id,
    threadId: b.thread_id,
    customerName: b.name,
    senderDomain: b.email.split('@')[1] ?? '',
    startsAt: b.starts_at.toISOString(),
    endsAt: b.ends_at.toISOString(),
    timeZone: t!.timezone,
    ...(t!.full
      ? {
          email: b.email,
          phone: b.phone,
          note: b.note,
          answers: b.answers.map((a) => ({ label: a.label, value: a.value })),
        }
      : {}),
    ...extra,
  };
};

// --------------------------------------------------------------- confirm

export function bookingConfirmHandler(deps: Deps) {
  return async (job: Job) => {
    const tenantId = job.tenantId;
    const bookingId = String(job.payload.bookingId);
    const lastTry = job.attempts >= job.maxAttempts;

    // 1. Calendar: re-read free/busy for this time and create (or move) the event.
    const cal = await withTenant(deps.sql, tenantId, async (tx) => {
      const b = await loadBooking(tx, bookingId);
      if (!b || b.status !== 'pending') return { skip: true as const };
      const settings = await loadBookingSettings(tx);
      const [t] = await tx<{ timezone: string; name: string; brand_company_name: string | null }[]>`
        select timezone, name, brand_company_name from public.tenants`;
      const old = b.rescheduled_from ? await loadBooking(tx, b.rescheduled_from) : null;
      const handle = await openCalendar(deps, tx, tenantId);
      return { skip: false as const, b, settings, t: t!, old, handle };
    });
    if (cal.skip) return { skipped: 'not_pending' };
    const { b, settings, t, old, handle } = cal;

    let eventId: string | null = old?.google_event_id ?? null;
    let meetUrl: string | null = old?.meet_url ?? null;
    let calendarError: string | null = null;
    if (handle) {
      try {
        const buffer = settings.bufferMinutes * 60_000;
        const busy = await handle.api.freeBusy(
          handle.accessToken,
          new Date(b.starts_at.getTime() - buffer),
          new Date(b.ends_at.getTime() + buffer),
        );
        // The old event of a moved booking may overlap the new time; it is not a conflict.
        const conflict = busy.some(
          (x) =>
            !(
              old &&
              x.start.getTime() === old.starts_at.getTime() &&
              x.end.getTime() === old.ends_at.getTime()
            ) &&
            x.start.getTime() < b.ends_at.getTime() + buffer &&
            x.end.getTime() > b.starts_at.getTime() - buffer,
        );
        if (conflict) {
          await withTenant(
            deps.sql,
            tenantId,
            (tx) =>
              tx`update public.bookings set status = 'taken' where id = ${b.id} and status = 'pending'`,
          );
          return { status: 'taken' };
        }
        if (old?.google_event_id) {
          await handle.api.moveEvent(
            handle.accessToken,
            old.google_event_id,
            b.starts_at,
            b.ends_at,
            t.timezone,
          );
        } else {
          const description = [
            `${b.name} <${b.email}>`,
            ...(b.phone ? [`Phone: ${b.phone}`] : []),
            ...(b.note ? ['', b.note] : []),
            ...(b.answers.length ? ['', ...b.answers.map((a) => `${a.label}: ${a.value}`)] : []),
            '',
            'Booked with Noctiv',
          ].join('\n');
          const ev = await handle.api.createEvent(handle.accessToken, {
            eventId: googleEventId(b.id),
            start: b.starts_at,
            end: b.ends_at,
            timeZone: t.timezone,
            summary: `${settings.meetingTitle || 'Meeting'}: ${b.name}`.slice(0, 200),
            description: description.slice(0, 4000),
            location:
              settings.locationKind === 'in_person' || settings.locationKind === 'online_link'
                ? settings.locationText
                : '',
            attendee: { name: b.name, email: b.email },
            meet: settings.locationKind === 'google_meet',
          });
          eventId = ev.id;
          meetUrl = ev.meetUrl;
        }
      } catch (err) {
        if (err instanceof GoogleAuthError) {
          await withTenant(deps.sql, tenantId, (tx) =>
            markCalendarError(tx, tenantId, handle.connectionId, 'access_revoked'),
          );
          calendarError = 'access_revoked';
        } else if (!lastTry) {
          throw new JobError('calendar call failed', { retryable: true, retryInSeconds: 20 });
        } else {
          // The customer was promised this time: confirm it, and tell the owner the event is missing.
          calendarError = 'event_not_created';
        }
      }
    }

    // 2. Confirm, lead, answers, e-mails, owner notification: one transaction.
    return withTenant(deps.sql, tenantId, async (tx) => {
      const [done] = await tx<{ id: string }[]>`
        update public.bookings
        set status = 'confirmed', confirmed_at = now(), google_event_id = ${eventId}, meet_url = ${meetUrl},
            ics_uid = ${old ? (old.ics_uid ?? old.id) : null},
            ics_sequence = ${old ? old.ics_sequence + 1 : 0}
        where id = ${b.id} and status = 'pending' returning id`;
      if (!done) return { skipped: 'not_pending' };
      if (old)
        await tx`update public.bookings set status = 'rescheduled', google_event_id = null where id = ${old.id}`;

      // The lead: from the reply link, else by e-mail (created if new).
      let leadId = b.lead_id;
      if (!leadId) {
        const [l] = await tx<{ id: string; created: boolean }[]>`
          insert into public.leads (tenant_id, email) values (${tenantId}, ${b.email})
          on conflict (tenant_id, email) do update set stage = leads.stage
          returning id, (xmax = 0) as created`;
        leadId = l!.id;
        if (l!.created)
          await tx`insert into public.lead_events (tenant_id, lead_id, to_stage, actor, reason)
                   values (${tenantId}, ${leadId}, 'received', 'system', 'booked on the booking page')`;
        await tx`update public.bookings set lead_id = ${leadId} where id = ${b.id}`;
      }
      await tx`update public.leads set name = ${b.name} where id = ${leadId} and name is null`;
      await setLeadStage(tx, tenantId, leadId, 'booked', old ? 'meeting moved' : 'meeting booked');
      // A booked customer is not chased: pending follow-ups stop.
      await tx`
        update public.threads set next_followup_at = null, followup_stop_reason = 'booked'
        where lead_id = ${leadId} and status = 'awaiting_customer' and next_followup_at is not null`;

      if (!old && b.answers.length) {
        const [f] = await tx<{ id: string; name: string }[]>`
          select f.id, f.name from public.booking_settings s join public.intake_forms f on f.id = s.form_id`;
        await tx`
          insert into public.intake_submissions (tenant_id, form_id, lead_id, thread_id, booking_id, form_name,
                                                 name, email, answers)
          values (${tenantId}, ${f?.id ?? null}, ${leadId}, ${b.thread_id}, ${b.id}, ${f?.name ?? 'Booking'},
                  ${b.name}, ${b.email}, ${tx.json(b.answers as never)})`;
      }

      const current: BookingRow = { ...b, lead_id: leadId, meet_url: meetUrl };
      const mail = await queueCustomerEmail(
        deps,
        tx,
        tenantId,
        current,
        old ? 'moved' : 'booked',
        t.timezone,
      );
      current.thread_id = mail.threadId;
      const kind = old ? 'booking_rescheduled' : 'booking_created';
      await tx`
        insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
        values (${tenantId}, 'email_owner', ${kind}, ${`${kind}:${b.id}`},
                ${tx.json(
                  (await ownerPayload(tx, current, {
                    ...(old ? { previousStartsAt: old.starts_at.toISOString() } : {}),
                    ...(calendarError ? { calendarError } : {}),
                    ...(mail.queued ? {} : { noMailbox: true }),
                  })) as never,
                )})
        on conflict do nothing`;
      await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
               values (${tenantId}, 'system', ${old ? 'booking.moved' : 'booking.confirmed'}, 'booking', ${b.id},
                       ${tx.json({ source: b.source, calendar: Boolean(eventId), ...(calendarError ? { calendarError } : {}) })})`;
      return { status: 'confirmed', calendar: Boolean(eventId) };
    });
  };
}

// ---------------------------------------------------------------- cancel

export function bookingCancelHandler(deps: Deps) {
  return async (job: Job) => {
    const tenantId = job.tenantId;
    const bookingId = String(job.payload.bookingId);
    const by = job.payload.by === 'owner' ? 'owner' : 'customer';
    const first = await withTenant(deps.sql, tenantId, async (tx) => {
      const b = await loadBooking(tx, bookingId);
      if (!b || b.status !== 'cancelled') return null;
      return { b, handle: b.google_event_id ? await openCalendar(deps, tx, tenantId) : null };
    });
    if (!first) return { skipped: 'not_cancelled' };
    const { b, handle } = first;
    if (handle && b.google_event_id) {
      try {
        await handle.api.deleteEvent(handle.accessToken, b.google_event_id);
      } catch (err) {
        if (err instanceof GoogleAuthError)
          await withTenant(deps.sql, tenantId, (tx) =>
            markCalendarError(tx, tenantId, handle.connectionId, 'access_revoked'),
          );
        else if (job.attempts < job.maxAttempts)
          throw new JobError('calendar delete failed', { retryable: true, retryInSeconds: 30 });
      }
    }
    return withTenant(deps.sql, tenantId, async (tx) => {
      await tx`update public.bookings set google_event_id = null where id = ${b.id}`;
      const [t] = await tx<{ timezone: string }[]>`select timezone from public.tenants`;
      await queueCustomerEmail(
        deps,
        tx,
        tenantId,
        b,
        by === 'owner' ? 'cancelled_by_owner' : 'cancelled_by_customer',
        t!.timezone,
      );
      if (by === 'customer')
        await tx`
          insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
          values (${tenantId}, 'email_owner', 'booking_cancelled', ${`booking_cancelled:${b.id}`},
                  ${tx.json((await ownerPayload(tx, b, {})) as never)})
          on conflict do nothing`;
      await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
               values (${tenantId}, 'system', 'booking.cancel_processed', 'booking', ${b.id}, ${tx.json({ by })})`;
      return { status: 'cancelled', by };
    });
  };
}
