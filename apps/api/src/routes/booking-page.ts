import {
  BOOKING_LANGUAGES,
  bookedPage,
  bookingDocument,
  bookingIcs,
  bookingLabels,
  detailsPage,
  escapeHtml,
  formatWhen,
  freeSlots,
  groupByDay,
  intakePage,
  intakeSentPage,
  isFreeSlot,
  languageFromAccept,
  managePage,
  messagePage,
  readAnswers,
  readContact,
  REQUIRED_CALENDAR_SCOPES,
  sealCalendarToken,
  settingsProblems,
  signManageToken,
  slotsPage,
  verifyCalendarState,
  verifyFormLink,
  verifyManageToken,
  verifyReplyLink,
  zoneName,
  type BookingSettings,
  type Errors,
  type GoogleCalendarApi,
  type MeetingInfo,
  type PageBrand,
  type Slot,
} from '@noctiv/bookings';
import { localDate, zonedTimeToUtc } from '@noctiv/core';
import { enqueue, withTenant } from '@noctiv/db';
import { loadStoredLogo } from '@noctiv/quotes';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Sql, TransactionSql } from 'postgres';
import { busyIntervals, loadForm, loadSettings, refreshCalendarIfStale } from '../bookings-data.ts';
import { brandHeader } from './quote-link.ts';
import { calendarRedirectUri } from './bookings.ts';

/**
 * Bookings (beta), the customer's side (PLAN.md §29.4, §29.7): the booking
 * page, the manage link, intake forms, and Google's OAuth callback. No
 * script; everything is a link or a form post. Proxied from app.noctiv.io
 * (/book/*, /f/*; the callback under /api).
 */
export interface BookingPageDeps {
  sql: Sql;
  secret: string;
  appUrl: string;
  publicApiUrl: string;
  credentialsPublicKey: string;
  google?: GoogleCalendarApi;
  /** How long a booking waits for the worker's confirmation (default 8 s). */
  waitMs?: number;
}

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

const SLOT_PARAM = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})Z$/;
const slotParam = (d: Date) => `${d.toISOString().slice(0, 16)}Z`;
const parseSlot = (s: string): Date | null => {
  const m = SLOT_PARAM.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAYS_PER_PAGE = 4;

/** Form posts arrive as lists (app.ts parser); fields take the first value. */
const firstValues = (body: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (body && typeof body === 'object')
    for (const [k, v] of Object.entries(body as Record<string, unknown>))
      out[k] = Array.isArray(v) ? String(v[0] ?? '') : typeof v === 'string' ? v : '';
  return out;
};

interface Ctx {
  tenantId: string;
  slug: string;
  timeZone: string;
  settings: BookingSettings;
  brand: PageBrand;
  meeting: MeetingInfo;
  form: Awaited<ReturnType<typeof loadForm>>;
  /** The business's mailbox (reply address), for "write to us" and the .ics organiser. */
  replyEmail: string | null;
  businessName: string;
}

async function loadCtx(tx: TransactionSql, tenantId: string, slug: string): Promise<Ctx> {
  const [t] = await tx<
    {
      name: string;
      brand_company_name: string | null;
      brand_color: string | null;
      timezone: string;
      reply: string | null;
    }[]
  >`
    select name, brand_company_name, brand_color, timezone,
           (select email_address from public.email_connections where status = 'connected'
            order by created_at limit 1) as reply
    from public.tenants`;
  const settings = await loadSettings(tx);
  const name = t!.brand_company_name || t!.name;
  const logo = await loadStoredLogo(tx);
  return {
    tenantId,
    slug,
    timeZone: t!.timezone,
    settings,
    businessName: name,
    brand: { headerHtml: brandHeader(name, t!.brand_color, logo), name, color: t!.brand_color },
    meeting: {
      title: settings.meetingTitle,
      minutes: settings.slotMinutes,
      locationKind: settings.locationKind,
      locationText: settings.locationText,
    },
    form: await loadForm(tx, settings.formId),
    replyEmail: t!.reply,
  };
}

export function bookingPageRoutes(app: FastifyInstance, deps: BookingPageDeps): void {
  const waitMs = deps.waitMs ?? 8_000;

  const send = (
    reply: FastifyReply,
    code: number,
    lang: string,
    page: { title: string; body: string },
    color: string | null = null,
  ) =>
    reply
      .code(code)
      .headers(HEADERS)
      .send(bookingDocument({ lang, title: page.title, body: page.body, color }));

  const plain = (
    reply: FastifyReply,
    req: FastifyRequest,
    code: number,
    pick: (t: ReturnType<typeof bookingLabels>) => [string, string],
  ) => {
    const lang = languageFromAccept(req.headers['accept-language']);
    const [title, text] = pick(bookingLabels(lang));
    return send(reply, code, lang, messagePage({ lang, brand: null, title, text }));
  };

  /** ?lang=, else the reply link's language, else the browser's. */
  const pickLang = (req: FastifyRequest, fromToken: string | null) => {
    const q = (req.query as Record<string, unknown>)?.lang;
    if (typeof q === 'string' && (BOOKING_LANGUAGES as readonly string[]).includes(q)) return q;
    if (fromToken && (BOOKING_LANGUAGES as readonly string[]).includes(fromToken)) return fromToken;
    return languageFromAccept(req.headers['accept-language']);
  };

  const tenantBySlug = async (slug: string): Promise<string | null> => {
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) return null;
    const [r] = await deps.sql<{ id: string | null }[]>`select app.booking_tenant(${slug}) as id`;
    return r?.id ?? null;
  };

  /** Reply-link reference (?r=): only honoured for this business. */
  const replyRef = (req: FastifyRequest, tenantId: string) => {
    const r = (req.query as Record<string, unknown>)?.r;
    if (typeof r !== 'string') return null;
    const v = verifyReplyLink(r, deps.secret);
    return v.ok && v.claims.tenantId === tenantId ? { token: r, ...v.claims } : null;
  };

  const query = (params: Record<string, string | null | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : '';
  };

  /** Free slots for the page starting at local date `from` (DAYS_PER_PAGE days with times). */
  const pageSlots = async (tx: TransactionSql, c: Ctx, fromDate: string | null) => {
    const now = new Date();
    const today = localDate(now, c.timeZone);
    const start = fromDate && DATE.test(fromDate) && fromDate > today ? fromDate : today;
    const [y, m, d] = start.split('-').map(Number) as [number, number, number];
    const from = zonedTimeToUtc(
      { year: y, month: m, day: d, hour: 0, minute: 0, second: 0 },
      c.timeZone,
    );
    const until = new Date(now.getTime() + (c.settings.horizonDays + 1) * 86_400_000);
    const busy = await busyIntervals(tx, now, until);
    const all = freeSlots({ settings: c.settings, timeZone: c.timeZone, busy, now, from });
    const days = groupByDay(all, c.timeZone);
    const shown = days.slice(0, DAYS_PER_PAGE);
    const next = days[DAYS_PER_PAGE]?.date ?? null;
    const earlier = start > today ? prevPageStart(start) : null;
    return { shown, next, earlier };
  };
  const prevPageStart = (date: string) => {
    const t = new Date(`${date}T12:00:00Z`);
    t.setUTCDate(t.getUTCDate() - 7);
    return t.toISOString().slice(0, 10);
  };

  const timesPage = async (
    tx: TransactionSql,
    c: Ctx,
    lang: string,
    o: {
      base: string;
      slotBase: string;
      keep: Record<string, string | null | undefined>;
      from: string | null;
      current?: { start: Date; end: Date } | null;
      heading?: string;
      notice?: string;
    },
  ) => {
    const { shown, next, earlier } = await pageSlots(tx, c, o.from);
    const page = slotsPage({
      lang,
      brand: c.brand,
      meeting: c.meeting,
      timeZone: c.timeZone,
      days: shown.map((d) => ({
        day: d.slots[0]!.start,
        slots: d.slots.map((s) => ({
          ...s,
          href: `${o.slotBase}/${slotParam(s.start)}${query(o.keep)}`,
        })),
      })),
      earlierHref: earlier ? `${o.base}${query({ ...o.keep, from: earlier })}` : null,
      laterHref: next ? `${o.base}${query({ ...o.keep, from: next })}` : null,
      ...(o.current !== undefined ? { current: o.current } : {}),
      ...(o.heading ? { heading: o.heading } : {}),
    });
    if (o.notice)
      page.body = page.body.replace(
        '</h1>',
        `</h1><p role="alert" style="margin:12px 0 0;padding:10px 12px;border-radius:8px;background:#FEF3F2;color:#B42318">${escapeHtml(o.notice)}</p>`,
      );
    return page;
  };

  /** Waits for the worker to confirm (or refuse) a pending booking. */
  const awaitStatus = async (tenantId: string, bookingId: string) => {
    const until = Date.now() + waitMs;
    for (;;) {
      const [b] = await withTenant(
        deps.sql,
        tenantId,
        (tx) =>
          tx<{ status: string }[]>`select status from public.bookings where id = ${bookingId}`,
      );
      if (!b || b.status !== 'pending' || Date.now() >= until) return b?.status ?? 'pending';
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  const manageUrl = (slug: string, token: string) => `/book/${slug}/manage/${token}`;

  /** Setup incomplete (no hours, no meeting link or address): no bookings for now. */
  const closed = (reply: FastifyReply, lang: string, c: Ctx) => {
    const t = bookingLabels(lang);
    return send(
      reply,
      503,
      lang,
      messagePage({
        lang,
        brand: c.brand,
        title: t.heading(c.brand.name),
        text: t.closed,
        extra: c.replyEmail
          ? `<p style="margin:8px 0 0">${escapeHtml(t.writeTo(c.replyEmail))}</p>`
          : '',
      }),
      c.brand.color,
    );
  };

  // --------------------------------------------------------------- times
  app.get<{ Params: { slug: string }; Querystring: Record<string, string> }>(
    '/book/:slug',
    async (req, reply) => {
      const tenantId = await tenantBySlug(req.params.slug);
      if (!tenantId) return plain(reply, req, 404, (t) => [t.notFound, t.closed]);
      const ref = replyRef(req, tenantId);
      const lang = pickLang(req, ref?.language ?? null);
      return withTenant(deps.sql, tenantId, async (tx) => {
        const c = await loadCtx(tx, tenantId, req.params.slug);
        if (settingsProblems(c.settings).length) return closed(reply, lang, c);
        await refreshCalendarIfStale(tx, tenantId);
        const base = `/book/${c.slug}`;
        const page = await timesPage(tx, c, lang, {
          base,
          slotBase: `${base}/t`,
          keep: { r: ref?.token, lang: req.query.lang ? lang : null },
          from: req.query.from ?? null,
        });
        return send(reply, 200, lang, page, c.brand.color);
      });
    },
  );

  // ------------------------------------------------------ details & book
  const details = async (
    req: FastifyRequest<{
      Params: { slug: string; start: string };
      Querystring: Record<string, string>;
    }>,
    reply: FastifyReply,
    posted: Record<string, string> | null,
  ) => {
    const tenantId = await tenantBySlug(req.params.slug);
    if (!tenantId) return plain(reply, req, 404, (t) => [t.notFound, t.closed]);
    const ref = replyRef(req, tenantId);
    const lang = pickLang(req, ref?.language ?? null);
    const t = bookingLabels(lang);
    const start = parseSlot(req.params.start);
    const keep = { r: ref?.token, lang: req.query.lang ? lang : null };
    const base = `/book/${req.params.slug}`;

    type Outcome =
      | { kind: 'page'; code: number; page: { title: string; body: string }; color: string | null }
      | { kind: 'wait'; bookingId: string; c: Ctx };
    const outcome = await withTenant(deps.sql, tenantId, async (tx): Promise<Outcome> => {
      const c = await loadCtx(tx, tenantId, req.params.slug);
      if (settingsProblems(c.settings).length)
        return {
          kind: 'page',
          code: 503,
          page: messagePage({
            lang,
            brand: c.brand,
            title: t.heading(c.brand.name),
            text: t.closed,
          }),
          color: c.brand.color,
        };
      const now = new Date();
      const busy = await busyIntervals(
        tx,
        now,
        new Date(now.getTime() + (c.settings.horizonDays + 1) * 86_400_000),
      );
      const slot: Slot | null = start
        ? isFreeSlot({ settings: c.settings, timeZone: c.timeZone, busy, now }, start)
        : null;
      const taken = async () => ({
        kind: 'page' as const,
        code: 409,
        page: await timesPage(tx, c, lang, {
          base,
          slotBase: `${base}/t`,
          keep,
          from: null,
          notice: `${t.takenTitle}. ${t.takenBody}`,
        }),
        color: c.brand.color,
      });
      if (!slot) return taken();

      const render = (values: Record<string, string>, errors: Errors, code: number) => ({
        kind: 'page' as const,
        code,
        page: detailsPage({
          lang,
          brand: c.brand,
          meeting: c.meeting,
          timeZone: c.timeZone,
          slot,
          action: `${base}/t/${slotParam(slot.start)}${query(keep)}`,
          changeHref: `${base}${query(keep)}`,
          hidden: {},
          values,
          errors,
          form: c.form ? { intro: c.form.intro, fields: c.form.fields } : null,
        }),
        color: c.brand.color,
      });

      if (!posted) {
        // Prefill from the reply link's lead.
        let values: Record<string, string> = {};
        if (ref?.leadId) {
          const [l] = await tx<{ name: string | null; email: string }[]>`
            select name, email from public.leads where id = ${ref.leadId}`;
          if (l) values = { name: l.name ?? '', email: l.email };
        }
        return render(values, {}, 200);
      }
      // A filled honeypot: say "almost done" and store nothing.
      if (posted.website)
        return {
          kind: 'page',
          code: 200,
          page: messagePage({ lang, brand: c.brand, title: t.waitingTitle, text: t.waitingBody }),
          color: c.brand.color,
        };

      const phoneRule = c.settings.locationKind === 'phone';
      const { contact, errors } = readContact(posted, { note: true, phone: true });
      if (phoneRule && !contact.phone) errors.phone = 'required';
      const { answers, errors: formErrors } = c.form
        ? readAnswers(c.form.fields, posted)
        : { answers: [], errors: {} };
      const all = { ...errors, ...formErrors };
      if (Object.keys(all).length) return render(posted, all, 400);

      try {
        // A savepoint, so a lost race (exclusion constraint) leaves the transaction usable.
        const [bk] = await tx.savepoint(
          (sp) => sp<{ id: string }[]>`
          insert into public.bookings (tenant_id, lead_id, thread_id, name, email, phone, note, answers,
                                       starts_at, ends_at, language, status, source)
          values (${tenantId}, ${ref?.leadId ?? null}, ${ref?.threadId ?? null}, ${contact.name}, ${contact.email},
                  ${contact.phone || null}, ${contact.note || null}, ${tx.json(answers as never)},
                  ${slot.start}, ${slot.end}, ${lang}, 'pending', ${ref ? 'reply' : 'page'})
          returning id`,
        );
        await enqueue(tx, {
          tenantId,
          queue: 'bookings.confirm',
          payload: { bookingId: bk!.id },
          singletonKey: `bookings.confirm:${bk!.id}`,
        });
        return { kind: 'wait', bookingId: bk!.id, c };
      } catch (err) {
        if ((err as { code?: string }).code === '23P01') return taken();
        throw err;
      }
    });

    if (outcome.kind === 'page')
      return send(reply, outcome.code, lang, outcome.page, outcome.color);
    return afterBooking(reply, lang, outcome.c, outcome.bookingId, false);
  };

  /** After a booking or a move: confirmed → the manage link; taken → times; slow → "almost done". */
  const afterBooking = async (
    reply: FastifyReply,
    lang: string,
    c: Ctx,
    bookingId: string,
    moved: boolean,
  ) => {
    const t = bookingLabels(lang);
    const status = await awaitStatus(c.tenantId, bookingId);
    const base = `/book/${c.slug}`;
    if (status === 'confirmed') {
      const [b] = await withTenant(
        deps.sql,
        c.tenantId,
        (tx) =>
          tx<{ ends_at: Date }[]>`select ends_at from public.bookings where id = ${bookingId}`,
      );
      const token = signManageToken(
        { tenantId: c.tenantId, bookingId, endsAt: b!.ends_at },
        deps.secret,
      );
      return reply
        .code(303)
        .header('location', `${manageUrl(c.slug, token)}?${moved ? 'moved' : 'done'}=1`)
        .send();
    }
    if (status === 'taken')
      return withTenant(deps.sql, c.tenantId, async (tx) =>
        send(
          reply,
          409,
          lang,
          await timesPage(tx, c, lang, {
            base,
            slotBase: `${base}/t`,
            keep: {},
            from: null,
            notice: `${t.takenTitle}. ${t.takenBody}`,
          }),
          c.brand.color,
        ),
      );
    return send(
      reply,
      202,
      lang,
      messagePage({ lang, brand: c.brand, title: t.waitingTitle, text: t.waitingBody }),
      c.brand.color,
    );
  };

  app.get<{ Params: { slug: string; start: string }; Querystring: Record<string, string> }>(
    '/book/:slug/t/:start',
    (req, reply) => details(req, reply, null),
  );
  app.post<{ Params: { slug: string; start: string }; Querystring: Record<string, string> }>(
    '/book/:slug/t/:start',
    (req, reply) => details(req, reply, firstValues(req.body)),
  );

  // --------------------------------------------------------------- manage
  interface BookingRow {
    id: string;
    lead_id: string | null;
    thread_id: string | null;
    name: string;
    email: string;
    phone: string | null;
    note: string | null;
    answers: unknown;
    starts_at: Date;
    ends_at: Date;
    language: string;
    status: string;
    source: string;
    meet_url: string | null;
    ics_sequence: number;
    ics_uid: string | null;
  }
  const withBooking = async <T>(
    req: FastifyRequest<{ Params: { slug: string; token: string } }>,
    reply: FastifyReply,
    fn: (tx: TransactionSql, c: Ctx, b: BookingRow, lang: string) => Promise<T>,
  ) => {
    const tenantId = await tenantBySlug(req.params.slug);
    const v = verifyManageToken(req.params.token, deps.secret);
    if (!tenantId || !v.ok || v.claims.tenantId !== tenantId) {
      // An expired link means the meeting is over.
      if (tenantId && !v.ok && v.reason === 'expired')
        return plain(reply, req, 410, (t) => [t.manageTitle, t.pastBooking]);
      return plain(reply, req, 404, (t) => [t.linkInvalid, t.notFound]);
    }
    // A handler that writes returns a function: the response is sent after the commit.
    const out = await withTenant(deps.sql, tenantId, async (tx) => {
      const [b] = await tx<BookingRow[]>`
        select id, lead_id, thread_id, name, email, phone, note, answers, starts_at, ends_at, language,
               status, source, meet_url, ics_sequence, ics_uid
        from public.bookings where id = ${v.claims.bookingId}`;
      if (!b) return plain(reply, req, 404, (t) => [t.linkInvalid, t.notFound]);
      const c = await loadCtx(tx, tenantId, req.params.slug);
      return fn(tx, c, b, pickLang(req, b.language));
    });
    return typeof out === 'function' ? (out as () => unknown)() : out;
  };

  const manageView = (
    c: Ctx,
    b: BookingRow,
    lang: string,
    token: string,
    o: { confirmCancel?: boolean } = {},
  ) => {
    const base = manageUrl(c.slug, token);
    const status: 'confirmed' | 'pending' | 'cancelled' | 'past' =
      b.status === 'cancelled' || b.status === 'taken'
        ? 'cancelled'
        : b.ends_at <= new Date()
          ? 'past'
          : b.status === 'pending'
            ? 'pending'
            : 'confirmed';
    return managePage({
      lang,
      brand: c.brand,
      meeting: c.meeting,
      timeZone: c.timeZone,
      start: b.starts_at,
      end: b.ends_at,
      status,
      cancelAction: `${base}/cancel`,
      rescheduleHref: `${base}/times`,
      icsHref: `${base}/ics`,
      ...(o.confirmCancel ? { confirmCancel: true } : {}),
    });
  };

  app.get<{ Params: { slug: string; token: string }; Querystring: Record<string, string> }>(
    '/book/:slug/manage/:token',
    (req, reply) =>
      withBooking(req, reply, async (_tx, c, b, lang) => {
        const t = bookingLabels(lang);
        if (b.status === 'rescheduled')
          return send(
            reply,
            200,
            lang,
            messagePage({ lang, brand: c.brand, title: t.movedTitle, text: t.cancelledBody }),
            c.brand.color,
          );
        if ((req.query.done || req.query.moved) && b.status === 'confirmed')
          return send(
            reply,
            200,
            lang,
            bookedPage({
              lang,
              brand: c.brand,
              meeting: c.meeting,
              timeZone: c.timeZone,
              start: b.starts_at,
              end: b.ends_at,
              email: b.email,
              icsHref: `${manageUrl(c.slug, req.params.token)}/ics`,
              moved: Boolean(req.query.moved),
            }),
            c.brand.color,
          );
        return send(reply, 200, lang, manageView(c, b, lang, req.params.token), c.brand.color);
      }),
  );

  app.get<{ Params: { slug: string; token: string } }>(
    '/book/:slug/manage/:token/ics',
    (req, reply) =>
      withBooking(req, reply, async (_tx, c, b, lang) => {
        if (b.status !== 'confirmed' && b.status !== 'cancelled')
          return plain(reply, req, 404, (t) => [t.notFound, t.linkInvalid]);
        const where =
          b.meet_url ?? (c.settings.locationKind === 'phone' ? '' : c.settings.locationText);
        const ics = bookingIcs({
          method: b.status === 'cancelled' ? 'CANCEL' : 'REQUEST',
          uid: `${b.ics_uid ?? b.id}@noctiv.io`,
          sequence: b.ics_sequence,
          start: b.starts_at,
          end: b.ends_at,
          summary: c.settings.meetingTitle || c.businessName,
          description: formatWhen(b.starts_at, b.ends_at, lang, c.timeZone),
          location: where,
          url:
            b.meet_url ??
            (c.settings.locationKind === 'online_link' ? c.settings.locationText : null),
          organizer: { name: c.businessName, email: c.replyEmail ?? 'bookings@noctiv.io' },
          attendee: { name: b.name, email: b.email },
        });
        return reply
          .code(200)
          .headers({
            'content-type': 'text/calendar; charset=utf-8',
            'content-disposition': 'attachment; filename="booking.ics"',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          })
          .send(ics);
      }),
  );

  app.post<{ Params: { slug: string; token: string } }>(
    '/book/:slug/manage/:token/cancel',
    (req, reply) =>
      withBooking(req, reply, async (tx, c, b, lang) => {
        const posted = firstValues(req.body);
        const open = (b.status === 'confirmed' || b.status === 'pending') && b.ends_at > new Date();
        if (!open)
          return send(reply, 200, lang, manageView(c, b, lang, req.params.token), c.brand.color);
        if (posted.confirm !== 'yes')
          return send(
            reply,
            200,
            lang,
            manageView(c, b, lang, req.params.token, { confirmCancel: true }),
            c.brand.color,
          );
        await tx`
        update public.bookings set status = 'cancelled', cancelled_by = 'customer', cancelled_at = now()
        where id = ${b.id} and status in ('pending', 'confirmed')`;
        await enqueue(tx, {
          tenantId: c.tenantId,
          queue: 'bookings.cancel',
          payload: { bookingId: b.id, by: 'customer' },
          singletonKey: `bookings.cancel:${b.id}`,
        });
        return () => reply.code(303).header('location', manageUrl(c.slug, req.params.token)).send();
      }),
  );

  // ------------------------------------------------------------ reschedule
  app.get<{ Params: { slug: string; token: string }; Querystring: Record<string, string> }>(
    '/book/:slug/manage/:token/times',
    (req, reply) =>
      withBooking(req, reply, async (tx, c, b, lang) => {
        if (!['confirmed', 'pending'].includes(b.status) || b.ends_at <= new Date())
          return send(reply, 200, lang, manageView(c, b, lang, req.params.token), c.brand.color);
        const base = `${manageUrl(c.slug, req.params.token)}/times`;
        const page = await timesPage(tx, c, lang, {
          base,
          slotBase: `${manageUrl(c.slug, req.params.token)}/t`,
          keep: { lang: req.query.lang ? lang : null },
          from: req.query.from ?? null,
          current: { start: b.starts_at, end: b.ends_at },
          heading: bookingLabels(lang).chooseAnother,
        });
        return send(reply, 200, lang, page, c.brand.color);
      }),
  );

  const moveView = (c: Ctx, b: BookingRow, lang: string, token: string, slot: Slot) => {
    const t = bookingLabels(lang);
    const card = (label: string, s: { start: Date; end: Date }, strike = false) =>
      `<section style="margin:16px 0 0;padding:20px;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06)"><p style="margin:0;color:#5B6275">${escapeHtml(label)}</p><p style="margin:2px 0 0;font-size:18px;font-weight:700${strike ? ';text-decoration:line-through;color:#5B6275' : ''}">${escapeHtml(formatWhen(s.start, s.end, lang, c.timeZone))}</p></section>`;
    return messagePage({
      lang,
      brand: c.brand,
      title: t.chooseAnother,
      text: zoneName(lang, c.timeZone, slot.start),
      extra:
        card(t.yourTime, { start: b.starts_at, end: b.ends_at }, true) +
        card(t.newTime, slot) +
        `<form method="post" action="${escapeHtml(`${manageUrl(c.slug, token)}/t/${slotParam(slot.start)}`)}"><button type="submit" style="width:100%;margin-top:20px;font-size:16px;font-weight:600;padding:14px 18px;border:0;border-radius:8px;color:#fff;background:#2F3A56;cursor:pointer">${escapeHtml(t.moveHere)}</button></form>` +
        `<p style="margin:16px 0 0;text-align:center"><a href="${escapeHtml(`${manageUrl(c.slug, token)}/times`)}" style="font-weight:600;color:#2F3A56">${escapeHtml(t.chooseAnother)}</a></p>`,
    });
  };

  const move = async (
    req: FastifyRequest<{ Params: { slug: string; token: string; start: string } }>,
    reply: FastifyReply,
    post: boolean,
  ) => {
    let pending: { c: Ctx; id: string; lang: string } | null = null;
    const res = await withBooking(req, reply, async (tx, c, b, lang) => {
      const t = bookingLabels(lang);
      if (!['confirmed', 'pending'].includes(b.status) || b.ends_at <= new Date())
        return send(reply, 200, lang, manageView(c, b, lang, req.params.token), c.brand.color);
      const start = parseSlot(req.params.start);
      const now = new Date();
      const busy = await busyIntervals(
        tx,
        now,
        new Date(now.getTime() + (c.settings.horizonDays + 1) * 86_400_000),
      );
      const slot = start
        ? isFreeSlot({ settings: c.settings, timeZone: c.timeZone, busy, now }, start)
        : null;
      const takenPage = async () =>
        send(
          reply,
          409,
          lang,
          await timesPage(tx, c, lang, {
            base: `${manageUrl(c.slug, req.params.token)}/times`,
            slotBase: `${manageUrl(c.slug, req.params.token)}/t`,
            keep: {},
            from: null,
            current: { start: b.starts_at, end: b.ends_at },
            heading: t.chooseAnother,
            notice: `${t.takenTitle}. ${t.takenBody}`,
          }),
          c.brand.color,
        );
      if (!slot) return takenPage();
      if (!post)
        return send(reply, 200, lang, moveView(c, b, lang, req.params.token, slot), c.brand.color);
      let nb: { id: string } | undefined;
      try {
        [nb] = await tx.savepoint(
          (sp) => sp<{ id: string }[]>`
        insert into public.bookings (tenant_id, lead_id, thread_id, name, email, phone, note, answers,
                                     starts_at, ends_at, language, status, source, rescheduled_from)
        values (${c.tenantId}, ${b.lead_id}, ${b.thread_id}, ${b.name}, ${b.email}, ${b.phone}, ${b.note},
                ${tx.json(b.answers as never)}, ${slot.start}, ${slot.end}, ${b.language}, 'pending',
                ${b.source}, ${b.id})
        returning id`,
        );
      } catch (err) {
        if ((err as { code?: string }).code === '23P01') return takenPage();
        throw err;
      }
      await enqueue(tx, {
        tenantId: c.tenantId,
        queue: 'bookings.confirm',
        payload: { bookingId: nb!.id },
        singletonKey: `bookings.confirm:${nb!.id}`,
      });
      pending = { c, id: nb!.id, lang };
      return null;
    });
    if (pending) {
      const p = pending as { c: Ctx; id: string; lang: string };
      return afterBooking(reply, p.lang, p.c, p.id, true);
    }
    return res;
  };

  app.get<{ Params: { slug: string; token: string; start: string } }>(
    '/book/:slug/manage/:token/t/:start',
    (req, reply) => move(req, reply, false),
  );
  app.post<{ Params: { slug: string; token: string; start: string } }>(
    '/book/:slug/manage/:token/t/:start',
    (req, reply) => move(req, reply, true),
  );

  // ------------------------------------------------------------ intake form
  const intake = async (
    req: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply,
    posted: Record<string, string> | null,
  ) => {
    const v = verifyFormLink(req.params.token, deps.secret);
    if (!v.ok)
      return plain(reply, req, v.reason === 'expired' ? 410 : 404, (t) => [
        v.reason === 'expired' ? t.linkExpired : t.linkInvalid,
        t.notFound,
      ]);
    const cl = v.claims;
    const lang = pickLang(req, null);
    const out = await withTenant(deps.sql, cl.tenantId, async (tx) => {
      const [tenant] = await tx<{ status: string }[]>`select status from public.tenants`;
      const form = await loadForm(tx, cl.formId);
      if (!form || tenant?.status !== 'active')
        return plain(reply, req, 404, (x) => [x.notFound, x.linkInvalid]);
      const c = await loadCtx(tx, cl.tenantId, '');
      let known: { name: string; email: string } | null = null;
      if (cl.leadId) {
        const [l] = await tx<{ name: string | null; email: string }[]>`
          select name, email from public.leads where id = ${cl.leadId}`;
        if (l) known = { name: l.name ?? l.email, email: l.email };
      }
      const action = `/f/${req.params.token}${req.query && (req.query as Record<string, string>).lang ? `?lang=${lang}` : ''}`;
      const render = (values: Record<string, string>, errors: Errors, code: number) =>
        send(
          reply,
          code,
          lang,
          intakePage({ lang, brand: c.brand, form, action, values, errors, known }),
          c.brand.color,
        );
      if (!posted) return render({}, {}, 200);
      if (posted.website)
        return send(reply, 200, lang, intakeSentPage({ lang, brand: c.brand }), c.brand.color);

      const who = known
        ? { contact: { name: known.name, email: known.email, phone: '', note: '' }, errors: {} }
        : readContact(posted, { note: false, phone: false });
      const { answers, errors } = readAnswers(form.fields, posted);
      const all = { ...who.errors, ...errors };
      if (Object.keys(all).length) return render(posted, all, 400);

      let leadId = known ? cl.leadId : null;
      if (!leadId) {
        const [l] = await tx<{ id: string }[]>`
          insert into public.leads (tenant_id, email) values (${cl.tenantId}, ${who.contact.email})
          on conflict (tenant_id, email) do update set stage = leads.stage
          returning id`;
        leadId = l!.id;
        await tx`update public.leads set name = ${who.contact.name} where id = ${leadId} and name is null`;
      }
      const [sub] = await tx<{ id: string }[]>`
        insert into public.intake_submissions (tenant_id, form_id, lead_id, thread_id, form_name, name, email, answers)
        values (${cl.tenantId}, ${form.id}, ${leadId}, ${known ? cl.threadId : null}, ${form.name},
                ${who.contact.name}, ${who.contact.email}, ${tx.json(answers as never)})
        returning id`;
      const [n] = await tx<
        { full: boolean }[]
      >`select notify_full_text as full from public.tenants`;
      await tx`
        insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
        values (${cl.tenantId}, 'email_owner', 'intake_submitted', ${`intake_submitted:${sub!.id}`},
                ${tx.json({
                  submissionId: sub!.id,
                  formName: form.name,
                  leadId,
                  threadId: known ? cl.threadId : null,
                  customerName: who.contact.name,
                  senderDomain: who.contact.email.split('@')[1] ?? '',
                  answerCount: answers.length,
                  ...(n!.full
                    ? { answers: answers.map((a) => ({ label: a.label, value: a.value })) }
                    : {}),
                } as never)})
        on conflict do nothing`;
      await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
               values (${cl.tenantId}, 'system', 'form.submitted', 'intake_submission', ${sub!.id},
                       ${tx.json({ formId: form.id } as never)})`;
      // Sent after the commit, so the answers are stored when the customer sees "Thank you".
      return () => send(reply, 200, lang, intakeSentPage({ lang, brand: c.brand }), c.brand.color);
    });
    return typeof out === 'function' ? (out as () => unknown)() : out;
  };

  app.get<{ Params: { token: string } }>('/f/:token', (req, reply) => intake(req, reply, null));
  app.post<{ Params: { token: string } }>('/f/:token', (req, reply) =>
    intake(req, reply, firstValues(req.body)),
  );

  // --------------------------------------------------------- OAuth callback
  app.get<{ Querystring: Record<string, string> }>(
    '/calendar/google/callback',
    async (req, reply) => {
      const back = (params: Record<string, string>) =>
        reply
          .code(302)
          .header(
            'location',
            `${deps.appUrl.replace(/\/+$/, '')}/bookings?${new URLSearchParams({ tab: 'setup', ...params })}`,
          )
          .send();
      const v = verifyCalendarState(req.query.state ?? '', deps.secret);
      if (!v.ok)
        return back({ calendar: 'error', reason: v.reason === 'expired' ? 'expired' : 'state' });
      if (!deps.google) return back({ calendar: 'error', reason: 'not_configured' });
      if (req.query.error || !req.query.code)
        return back({
          calendar: 'error',
          reason: req.query.error === 'access_denied' ? 'denied' : 'google',
        });
      let got: { refreshToken: string; email: string; scopes: string[] };
      try {
        got = await deps.google.exchangeCode(
          req.query.code,
          calendarRedirectUri(deps.publicApiUrl),
        );
      } catch (err) {
        req.log.warn({ err: { message: (err as Error).message } }, 'calendar code exchange failed');
        return back({ calendar: 'error', reason: 'google' });
      }
      if (!REQUIRED_CALENDAR_SCOPES.every((s) => got.scopes.includes(s))) {
        await deps.google.revoke(got.refreshToken);
        return back({ calendar: 'error', reason: 'scopes' });
      }
      const { tenantId, userId } = v.claims;
      const member = await withTenant(
        deps.sql,
        tenantId,
        (tx) => tx`select 1 from public.tenant_members where user_id = ${userId}`,
      );
      if (!member.length) return back({ calendar: 'error', reason: 'state' });
      await withTenant(deps.sql, tenantId, async (tx) => {
        await tx`delete from public.calendar_connections`;
        const id = crypto.randomUUID();
        const sealed = sealCalendarToken(got.refreshToken, deps.credentialsPublicKey, tenantId, id);
        await tx`
        insert into public.calendar_connections (id, tenant_id, provider, account_email, credentials_ciphertext,
                                                 credentials_key_id, scopes, status)
        values (${id}, ${tenantId}, 'google', ${got.email.slice(0, 320)}, ${sealed.ciphertext}, ${sealed.keyId},
                ${got.scopes}, 'connected')`;
        await tx`delete from public.calendar_busy`;
        await enqueue(tx, {
          tenantId,
          queue: 'calendar.sync',
          singletonKey: `calendar.sync:${tenantId}`,
          maxAttempts: 2,
        });
        await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
               values (${tenantId}, 'owner', ${userId}, 'calendar.connected', 'calendar_connection', ${id},
                       ${tx.json({ provider: 'google' } as never)})`;
      });
      return back({ calendar: 'connected' });
    },
  );
}
