import { bookingIcs, formatWhen, freeSlots, offerBlock } from '@noctiv/bookings';
import type { TransactionSql } from 'postgres';
import { busyFromDb, loadBookingSettings } from './data.ts';

/** What a booking_offer draft remembers about its times block (drafts.booking_offer). */
export interface BookingOffer {
  block: string;
  language: string | null;
  url: string;
  starts: string[];
}

/** The .ics attached to a 'booking' e-mail: the booking's current state. */
export async function bookingIcsFor(tx: TransactionSql, bookingId: string): Promise<string | null> {
  const [b] = await tx<
    {
      id: string;
      name: string;
      email: string;
      starts_at: Date;
      ends_at: Date;
      status: string;
      language: string;
      meet_url: string | null;
      ics_sequence: number;
      ics_uid: string | null;
    }[]
  >`select id, name, email, starts_at, ends_at, status, language, meet_url, ics_sequence, ics_uid
    from public.bookings where id = ${bookingId}`;
  if (!b) return null;
  const [t] = await tx<
    { name: string; brand_company_name: string | null; timezone: string; reply: string | null }[]
  >`
    select name, brand_company_name, timezone,
           (select email_address from public.email_connections where status = 'connected'
            order by created_at limit 1) as reply
    from public.tenants`;
  const s = await loadBookingSettings(tx);
  const business = t!.brand_company_name || t!.name;
  const cancelled = b.status === 'cancelled';
  return bookingIcs({
    method: cancelled ? 'CANCEL' : 'REQUEST',
    uid: `${b.ics_uid ?? b.id}@noctiv.io`,
    // A cancellation must be newer than the last version the customer got.
    sequence: b.ics_sequence + (cancelled ? 1 : 0),
    start: b.starts_at,
    end: b.ends_at,
    summary: s.meetingTitle || business,
    description: formatWhen(b.starts_at, b.ends_at, b.language, t!.timezone),
    location:
      s.locationKind === 'google_meet'
        ? (b.meet_url ?? '')
        : s.locationKind === 'phone'
          ? ''
          : s.locationText,
    url: b.meet_url ?? (s.locationKind === 'online_link' ? s.locationText : null),
    organizer: { name: business, email: t!.reply ?? 'bookings@noctiv.io' },
    attendee: { name: b.name, email: b.email },
  });
}

/**
 * At send time (an approval may come hours later): when a time in the offer
 * has gone, the block is rebuilt with the next free times and the draft body
 * updated. Nothing changes when all times are still free, or none are left
 * (the link still shows what is free).
 */
export async function refreshOffer(
  tx: TransactionSql,
  draftId: string,
  body: string | null,
  offer: BookingOffer,
  timeZone: string,
): Promise<string | null> {
  if (!body || !body.includes(offer.block)) return body;
  const now = new Date();
  const settings = await loadBookingSettings(tx);
  const busy = await busyFromDb(
    tx,
    now,
    new Date(now.getTime() + (settings.horizonDays + 1) * 86_400_000),
  );
  const free = freeSlots({ settings, timeZone, busy, now });
  const still = offer.starts.every((iso) => free.some((f) => f.start.toISOString() === iso));
  if (still) return body;
  const slots = free.slice(0, 3);
  if (!slots.length) return body;
  const block = offerBlock({ language: offer.language, timeZone, slots, bookingUrl: offer.url });
  const next = body.replace(offer.block, block);
  await tx`update public.drafts set body = ${next},
             booking_offer = ${tx.json({ ...offer, block, starts: slots.map((x) => x.start.toISOString()) } as never)}
           where id = ${draftId}`;
  return next;
}
