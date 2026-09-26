import { timingSafeEqual } from 'node:crypto';
import {
  verifyWaitlistToken,
  WAITLIST_INTEGRATIONS,
  waitlistIpHash,
  type WaitlistAction,
} from '@noctiv/core';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Sql } from 'postgres';
import { z } from 'zod';
import { page } from './actions.ts';

export interface WaitlistDeps {
  sql: Sql;
  /** The action-link secret: signs confirm / unsubscribe links, salts the IP hash. */
  secret: string;
  /** The public site, for the "back" link (https://noctiv.io). */
  siteUrl: string;
  /** Bearer token for the founder's CSV export; without it the export is off. */
  exportToken?: string;
}

const SignupSchema = z.object({
  email: z.array(z.string().trim().toLowerCase().max(254).pipe(z.email())).length(1),
  integration: z.array(z.enum(WAITLIST_INTEGRATIONS)).min(1).max(5),
  consent: z.array(z.literal('yes')).min(1),
  source: z
    .array(z.string().regex(/^[a-z0-9-]{1,60}$/))
    .max(1)
    .optional(),
  // Honeypot: hidden from people, filled in by form bots.
  website: z.array(z.string()).optional(),
});

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Spreadsheets run cells that start with these as formulas.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/**
 * Integrations waitlist (PLAN.md §23). The site's forms post here without
 * JavaScript; the answer is a small page. Double opt-in: the worker e-mails a
 * confirm link; only confirmed addresses are exported. Opening a link (GET)
 * shows a button, the button (POST) acts, so link scanners decide nothing.
 */
export function waitlistRoutes(app: FastifyInstance, deps: WaitlistDeps) {
  const back = {
    href: `${deps.siteUrl.replace(/\/+$/, '')}/integrations/`,
    label: 'Back to Noctiv',
  };

  app.post('/waitlist', async (req, reply) => {
    const parsed = SignupSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const missing = new Set(parsed.error.issues.map((i) => String(i.path[0])));
      const why = missing.has('email')
        ? 'Please enter a valid e-mail address.'
        : missing.has('integration')
          ? 'Please choose at least one integration.'
          : missing.has('consent')
            ? 'Please tick “Notify me when this is ready” so we may e-mail you.'
            : 'Something in the form was not valid.';
      return page(reply, 400, 'Not signed up yet', why, undefined, back);
    }
    const f = parsed.data;
    const done = () =>
      page(
        reply,
        200,
        'Check your inbox',
        'We sent you a link to confirm your address. You will only hear from us when an integration you chose is ready.',
        undefined,
        back,
      );
    if (f.website?.some((v) => v.trim() !== '')) return done();
    const ipHash = waitlistIpHash(req.ip, deps.secret);
    await deps.sql`
      select * from app.waitlist_signup(${f.email[0]!}, ${[...new Set(f.integration)]},
                                        ${f.source?.[0] ?? 'integrations'}, ${ipHash})`;
    req.log.info('waitlist signup');
    return done();
  });

  const linkRoute = (action: WaitlistAction) => {
    const path = `/waitlist/${action}/:id/:token`;
    const text =
      action === 'confirm'
        ? {
            question: 'Confirm your address?',
            body: 'We will e-mail you once, when an integration you chose is ready. No other e-mails.',
            button: 'Confirm',
            doneTitle: 'Confirmed',
            done: 'We will e-mail you when an integration you chose is ready.',
          }
        : {
            question: 'Unsubscribe?',
            body: 'We will not e-mail you about integrations again.',
            button: 'Unsubscribe',
            doneTitle: 'Unsubscribed',
            done: 'You will not hear from us about integrations again.',
          };
    type P = { Params: { id: string; token: string } };
    const valid = (p: P['Params'], reply: FastifyReply) => {
      if (verifyWaitlistToken(p.id, action, p.token, deps.secret)) return true;
      void page(reply, 404, 'Link not valid', 'This link is not valid.', undefined, back);
      return false;
    };
    app.get<P>(path, async (req, reply) => {
      if (!valid(req.params, reply)) return reply;
      return page(reply, 200, text.question, text.body, {
        label: text.button,
        danger: action === 'unsubscribe',
      });
    });
    // Also the target of one-click unsubscribe (RFC 8058) from the e-mail's header.
    app.post<P>(path, async (req, reply) => {
      if (!valid(req.params, reply)) return reply;
      const [r] = await deps.sql<{ status: string | null }[]>`
        select app.waitlist_set_status(${req.params.id}::uuid,
               ${action === 'confirm' ? 'confirmed' : 'unsubscribed'}) as status`;
      if (!r?.status) {
        return page(
          reply,
          200,
          action === 'confirm' ? 'Not confirmed' : 'Unsubscribed',
          action === 'confirm'
            ? 'This address was unsubscribed. Sign up again on the integrations page.'
            : 'This address is not on the list.',
          undefined,
          back,
        );
      }
      return page(reply, 200, text.doneTitle, text.done, undefined, back);
    });
  };
  linkRoute('confirm');
  linkRoute('unsubscribe');

  // The founder's export: confirmed sign-ups and in-app "notify me" owners.
  const token = deps.exportToken;
  if (!token) return;
  app.get('/admin/waitlist.csv', async (req, reply) => {
    const header = req.headers.authorization ?? '';
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '', 'utf8');
    const expected = Buffer.from(token, 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const rows = await deps.sql<
      {
        email: string;
        integrations: string[];
        source: string;
        status: string;
        created_at: Date;
        confirmed_at: Date | null;
      }[]
    >`select * from app.waitlist_export()`;
    const lines = [
      'email,integrations,source,status,created_at,confirmed_at',
      ...rows.map((r) =>
        [r.email, r.integrations.join(' '), r.source, r.status, r.created_at, r.confirmed_at]
          .map(csvCell)
          .join(','),
      ),
    ];
    return reply
      .headers({
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="noctiv-waitlist.csv"',
        'cache-control': 'no-store',
      })
      .send(`${lines.join('\r\n')}\r\n`);
  });
}
