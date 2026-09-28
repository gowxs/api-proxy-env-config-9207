import {
  bookingSettingsPatch,
  formSchema,
  settingsProblems,
  signCalendarState,
  signFormLink,
  slugProblem,
  withKeys,
  type GoogleCalendarApi,
} from '@noctiv/bookings';
import { enqueue, withTenant } from '@noctiv/db';
import type { FastifyInstance } from 'fastify';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import {
  bookingPageUrl,
  ensureBookingSetup,
  formPageUrl,
  loadSettings,
  SETTINGS_COLUMNS,
} from '../bookings-data.ts';
import { HttpError } from './http-error.ts';

const tenantParams = z.object({ tenantId: z.uuid() });
const idParams = z.object({ tenantId: z.uuid(), id: z.uuid() });

const setupBody = bookingSettingsPatch
  .extend({ slug: z.string().trim().toLowerCase().min(3).max(40) })
  .partial()
  .strict();

const formBody = z
  .object({
    name: z.string(),
    intro: z.string().default(''),
    fields: z
      .array(
        z.object({
          key: z.string().optional(),
          label: z.string(),
          type: z.string(),
          required: z.boolean(),
          options: z.array(z.string()).optional(),
        }),
      )
      .max(10),
  })
  .strict();

export interface BookingRouteDeps extends AppDeps {
  appUrl: string;
  publicApiUrl: string;
  google?: GoogleCalendarApi;
}

export const calendarRedirectUri = (publicApiUrl: string) =>
  `${publicApiUrl.replace(/\/+$/, '')}/calendar/google/callback`;

/**
 * Bookings (beta), owner side (PLAN.md §29.8): setup, the calendar
 * connection, the list of bookings, owner cancellation and intake forms.
 */
export function bookingRoutes(app: FastifyInstance, deps: BookingRouteDeps): void {
  const tenantTx = async <T>(
    req: { params: unknown; user?: { userId: string } },
    fn: (tx: TransactionSql, tenantId: string) => Promise<T>,
  ): Promise<T> => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    return withTenant(deps.sql, tenantId, (tx) => fn(tx, tenantId));
  };
  const audit = (
    tx: TransactionSql,
    tenantId: string,
    userId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    metadata: Record<string, unknown> = {},
  ) => tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
          values (${tenantId}, 'owner', ${userId}, ${action}, ${targetType}, ${targetId}, ${tx.json(metadata as never)})`;

  const setup = async (tx: TransactionSql) => {
    const [t] = await tx<
      { bookings_enabled: boolean; booking_slug: string | null; timezone: string }[]
    >`
      select bookings_enabled, booking_slug, timezone from public.tenants`;
    const settings = await loadSettings(tx);
    const [cal] = await tx<
      {
        provider: string;
        account_email: string;
        status: string;
        last_error: string | null;
        synced_at: Date | null;
      }[]
    >`select provider, account_email, status, last_error, synced_at from public.calendar_connections`;
    const forms = await tx<{ id: string; name: string }[]>`
      select id, name from public.intake_forms where archived_at is null order by name`;
    const [mailbox] =
      await tx`select 1 from public.email_connections where status = 'connected' limit 1`;
    return {
      enabled: t!.bookings_enabled,
      slug: t!.booking_slug,
      pageUrl: t!.booking_slug ? bookingPageUrl(deps.appUrl, t!.booking_slug) : null,
      timezone: t!.timezone,
      settings,
      problems: [...settingsProblems(settings), ...(mailbox ? [] : ['no_mailbox'])],
      calendar: cal
        ? {
            provider: cal.provider,
            email: cal.account_email,
            status: cal.status,
            lastError: cal.last_error,
            syncedAt: cal.synced_at,
          }
        : null,
      googleConfigured: Boolean(deps.google),
      forms,
    };
  };

  app.get('/v1/tenants/:tenantId/bookings/setup', (req) => tenantTx(req, (tx) => setup(tx)));

  app.patch('/v1/tenants/:tenantId/bookings/setup', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = setupBody.parse(req.body ?? {});
      await ensureBookingSetup(tx, tenantId);
      if (b.slug !== undefined) {
        const problem = slugProblem(b.slug);
        if (problem === 'format')
          throw new HttpError(400, 'Use 3–40 lower-case letters, digits and single hyphens.');
        if (problem === 'reserved') throw new HttpError(400, 'That address is reserved.');
        const [taken] = await tx<
          { taken: boolean }[]
        >`select app.booking_slug_taken(${b.slug}, ${tenantId}) as taken`;
        if (taken!.taken) throw new HttpError(409, 'That address is already taken.');
        await tx`update public.tenants set booking_slug = ${b.slug} where id = ${tenantId}`;
      }
      if (b.formId) {
        const [f] =
          await tx`select 1 from public.intake_forms where id = ${b.formId} and archived_at is null`;
        if (!f) throw new HttpError(400, 'Unknown form.');
      }
      const cols: Record<string, unknown> = {};
      for (const [k, col] of Object.entries(SETTINGS_COLUMNS)) {
        const v = (b as Record<string, unknown>)[k];
        if (v !== undefined) cols[col] = k === 'hours' ? tx.json(v as never) : v;
      }
      if (Object.keys(cols).length)
        await tx`update public.booking_settings set ${tx(cols)} where tenant_id = ${tenantId}`;
      await audit(tx, tenantId, req.user!.userId, 'bookings.settings_updated', 'tenant', tenantId, {
        fields: Object.keys(b),
      });
      return setup(tx);
    }),
  );

  // ------------------------------------------------------------ calendar
  app.post('/v1/tenants/:tenantId/calendar/google/start', (req) =>
    tenantTx(req, async (_tx, tenantId) => {
      if (!deps.google || !deps.actionSecret)
        throw new HttpError(409, 'Google Calendar is not set up on this server yet.');
      const state = signCalendarState({ tenantId, userId: req.user!.userId }, deps.actionSecret);
      return { url: deps.google.authUrl(state, calendarRedirectUri(deps.publicApiUrl)) };
    }),
  );

  app.delete('/v1/tenants/:tenantId/calendar', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const [c] = await tx<{ id: string }[]>`
        update public.calendar_connections set status = 'revoking' returning id`;
      if (!c) return { ok: true };
      await enqueue(tx, {
        tenantId,
        queue: 'calendar.disconnect',
        payload: { connectionId: c.id },
        singletonKey: `calendar.disconnect:${c.id}`,
      });
      await audit(
        tx,
        tenantId,
        req.user!.userId,
        'calendar.disconnected',
        'calendar_connection',
        c.id,
      );
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------ bookings
  app.get('/v1/tenants/:tenantId/bookings', (req) =>
    tenantTx(req, async (tx) => {
      const q = z
        .object({
          scope: z.enum(['upcoming', 'past', 'cancelled']).default('upcoming'),
          leadId: z.uuid().optional(),
        })
        .parse(req.query);
      const where = q.leadId
        ? tx`lead_id = ${q.leadId} and status in ('pending', 'confirmed', 'cancelled')`
        : q.scope === 'upcoming'
          ? tx`status in ('pending', 'confirmed') and ends_at > now()`
          : q.scope === 'past'
            ? tx`status = 'confirmed' and ends_at <= now()`
            : tx`status = 'cancelled'`;
      return tx`
        select id, lead_id, thread_id, name, email, phone, note, answers, starts_at, ends_at, language,
               status, cancelled_by, source, meet_url, created_at, confirmed_at, cancelled_at
        from public.bookings where ${where}
        order by ${q.scope === 'upcoming' || q.leadId ? tx`starts_at` : tx`starts_at desc`}
        limit 200`;
    }),
  );

  app.post('/v1/tenants/:tenantId/bookings/:id/cancel', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const [bk] = await tx<{ id: string }[]>`
        update public.bookings set status = 'cancelled', cancelled_by = 'owner', cancelled_at = now()
        where id = ${id} and status in ('pending', 'confirmed') and ends_at > now()
        returning id`;
      if (!bk) throw new HttpError(409, 'This booking can no longer be cancelled.');
      await enqueue(tx, {
        tenantId,
        queue: 'bookings.cancel',
        payload: { bookingId: id, by: 'owner' },
        singletonKey: `bookings.cancel:${id}`,
      });
      await audit(tx, tenantId, req.user!.userId, 'booking.cancelled', 'booking', id);
      return { ok: true };
    }),
  );

  // ---------------------------------------------------------------- forms
  const parseForm = (body: unknown) => {
    const raw = formBody.parse(body);
    const parsed = formSchema.safeParse({ ...raw, fields: withKeys(raw.fields) });
    if (!parsed.success)
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message === 'a choice needs at least two options'
          ? 'A choice needs at least two options.'
          : 'Check the form: every field needs a label (up to 100 characters), and at most 10 fields.',
      );
    return parsed.data;
  };

  app.get('/v1/tenants/:tenantId/forms', (req) =>
    tenantTx(
      req,
      (tx) =>
        tx`
        select f.id, f.name, f.intro, f.fields, f.created_at, f.updated_at,
               (select count(*) from public.intake_submissions s where s.form_id = f.id)::int as submissions
        from public.intake_forms f where f.archived_at is null order by f.name`,
    ),
  );

  app.post('/v1/tenants/:tenantId/forms', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const f = parseForm(req.body);
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.intake_forms where archived_at is null`;
      if (count!.n >= 50) throw new HttpError(409, 'At most 50 forms.');
      const [row] = await tx<{ id: string }[]>`
        insert into public.intake_forms (tenant_id, name, intro, fields)
        values (${tenantId}, ${f.name}, ${f.intro}, ${tx.json(f.fields as never)}) returning id`;
      await audit(tx, tenantId, req.user!.userId, 'form.created', 'intake_form', row!.id);
      return { id: row!.id };
    }),
  );

  app.patch('/v1/tenants/:tenantId/forms/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const f = parseForm(req.body);
      const [row] = await tx`
        update public.intake_forms set name = ${f.name}, intro = ${f.intro}, fields = ${tx.json(f.fields as never)}
        where id = ${id} and archived_at is null returning id`;
      if (!row) throw new HttpError(404, 'not found');
      await audit(tx, tenantId, req.user!.userId, 'form.updated', 'intake_form', id);
      return { ok: true };
    }),
  );

  app.delete('/v1/tenants/:tenantId/forms/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      await tx`update public.intake_forms set archived_at = now() where id = ${id} and archived_at is null`;
      await tx`update public.booking_settings set form_id = null where form_id = ${id}`;
      await audit(tx, tenantId, req.user!.userId, 'form.archived', 'intake_form', id);
      return { ok: true };
    }),
  );

  /**
   * A link to the form: general (for the website) or tied to a customer's
   * lead and conversation (inserted into a reply, or sent by the assistant).
   */
  app.post('/v1/tenants/:tenantId/forms/:id/link', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const b = z
        .object({ threadId: z.uuid().optional(), leadId: z.uuid().optional() })
        .strict()
        .parse(req.body ?? {});
      if (!deps.actionSecret) throw new HttpError(409, 'Links are not available on this server.');
      const [f] =
        await tx`select 1 from public.intake_forms where id = ${id} and archived_at is null`;
      if (!f) throw new HttpError(404, 'not found');
      let leadId = b.leadId ?? null;
      let threadId = b.threadId ?? null;
      if (threadId) {
        const [th] = await tx<{ lead_id: string | null }[]>`
          select lead_id from public.threads where id = ${threadId}`;
        if (!th) throw new HttpError(404, 'not found');
        leadId ??= th.lead_id;
      } else if (leadId) {
        const [l] = await tx`select 1 from public.leads where id = ${leadId}`;
        if (!l) throw new HttpError(404, 'not found');
      }
      if (!leadId) threadId = null;
      return {
        url: formPageUrl(
          deps.appUrl,
          signFormLink({ tenantId, formId: id, leadId, threadId }, deps.actionSecret),
        ),
      };
    }),
  );

  /** The conversation page: this customer's bookings and form answers. */
  app.get('/v1/tenants/:tenantId/conversations/:id/bookings', (req) =>
    tenantTx(req, async (tx) => {
      const { id } = idParams.parse(req.params);
      const [th] = await tx<
        { lead_id: string | null }[]
      >`select lead_id from public.threads where id = ${id}`;
      if (!th) throw new HttpError(404, 'not found');
      const who = th.lead_id
        ? tx`(lead_id = ${th.lead_id} or thread_id = ${id})`
        : tx`thread_id = ${id}`;
      return {
        bookings: await tx`
          select id, name, email, phone, note, answers, starts_at, ends_at, status, cancelled_by, meet_url
          from public.bookings where ${who} and status in ('pending', 'confirmed', 'cancelled')
          order by starts_at desc limit 20`,
        submissions: await tx`
          select id, form_name, name, email, answers, created_at from public.intake_submissions
          where ${who} order by created_at desc limit 20`,
      };
    }),
  );

  app.get('/v1/tenants/:tenantId/forms/submissions', (req) =>
    tenantTx(req, async (tx) => {
      const q = z
        .object({ leadId: z.uuid().optional(), threadId: z.uuid().optional() })
        .parse(req.query);
      return tx`
        select id, form_id, form_name, lead_id, thread_id, booking_id, name, email, answers, created_at
        from public.intake_submissions
        where ${q.leadId ? tx`lead_id = ${q.leadId}` : q.threadId ? tx`thread_id = ${q.threadId}` : tx`true`}
        order by created_at desc limit 100`;
    }),
  );
}
