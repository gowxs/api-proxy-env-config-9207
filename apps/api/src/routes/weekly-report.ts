import { verifyWeeklyReportToken } from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Sql } from 'postgres';
import { page } from './actions.ts';

/**
 * Unsubscribe from the Monday summary e-mail (PLAN.md §26). Opening the link
 * (GET) shows a button; the button (POST) switches the summary off, so link
 * scanners decide nothing. POST is also the one-click target (RFC 8058) of
 * the e-mail's List-Unsubscribe header. Settings can switch it on again.
 */
export function weeklyReportRoutes(
  app: FastifyInstance,
  deps: { sql: Sql; secret: string; appUrl: string },
) {
  const path = '/reports/weekly/unsubscribe/:tenantId/:token';
  type P = { Params: { tenantId: string; token: string } };
  const settings = {
    href: `${deps.appUrl.replace(/\/+$/, '')}/settings#account`,
    label: 'Settings',
  };
  const valid = (p: P['Params'], reply: FastifyReply) => {
    if (verifyWeeklyReportToken(p.tenantId, p.token, deps.secret)) return true;
    void page(reply, 404, 'Link not valid', 'This link is not valid.');
    return false;
  };
  app.get<P>(path, async (req, reply) => {
    if (!valid(req.params, reply)) return reply;
    return page(
      reply,
      200,
      'Stop the weekly summary?',
      'You will no longer get the Monday e-mail with your Noctiv numbers. Your other notifications stay on.',
      { label: 'Unsubscribe', danger: true },
    );
  });
  app.post<P>(path, async (req, reply) => {
    if (!valid(req.params, reply)) return reply;
    const { tenantId } = req.params;
    await withTenant(deps.sql, tenantId, async (tx) => {
      const r = await tx`update public.tenants set weekly_report_enabled = false
                         where id = ${tenantId} and weekly_report_enabled returning id`;
      if (r.length)
        await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
                 values (${tenantId}, 'owner', 'weekly_report.unsubscribed', 'tenant', ${tenantId},
                         ${tx.json({ via: 'email_link' })})`;
    });
    return page(
      reply,
      200,
      'Unsubscribed',
      'The weekly summary is off. You can switch it on again in Settings → Account.',
      undefined,
      settings,
    );
  });
}
