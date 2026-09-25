import { verifyActionToken, type ActionClaims, type DraftAction } from '@noctiv/core';
import { enqueue, withTenant } from '@noctiv/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Sql } from 'postgres';

/** Queue name shared with the worker (apps/worker/src/queues.ts). */
const MAIL_SEND_QUEUE = 'mail.send';

export interface ActionDeps {
  sql: Sql;
  actionSecret: string;
  appUrl: string;
}

const STATUS_TEXT: Record<string, string> = {
  approved: 'It was already approved and is being sent.',
  sent: 'It was already approved and sent.',
  rejected: 'It was already rejected.',
  send_failed: 'It was approved, but sending failed. See the dashboard.',
  superseded: 'A newer draft replaced it.',
  suggestion: 'This is an unverified suggestion; use the dashboard to reply.',
};

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

function page(
  reply: FastifyReply,
  code: number,
  title: string,
  body: string,
  form?: { label: string; danger: boolean },
) {
  const button = form
    ? `<form method="post"><button type="submit" style="font-size:16px;padding:10px 18px;border:0;border-radius:6px;color:#fff;background:${form.danger ? '#8a1f1f' : '#1f3a5f'};cursor:pointer">${escapeHtml(form.label)}</button></form>`
    : '';
  return reply
    .code(code)
    .headers({
      'content-type': 'text/html; charset=utf-8',
      // No scripts, no external resources; the form may only post back here.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Noctiv</title></head>` +
        `<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#1a1a1a">` +
        `<h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${button}</body></html>`,
    );
}

const VERB: Record<DraftAction, { confirm: string; done: string; question: string }> = {
  approve: {
    confirm: 'Approve and send',
    done: 'Approved — the reply is being sent.',
    question: 'Send this reply to the customer now?',
  },
  reject: {
    confirm: 'Reject draft',
    done: 'Rejected — nothing will be sent.',
    question: 'Reject this draft? Nothing will be sent.',
  },
};

/**
 * Approve / Reject links from owner emails. Opening a link (GET) only shows
 * a confirmation page, so mail-security scanners that pre-open links cannot
 * decide anything; the button (POST) acts. A draft can be decided once;
 * any later click just reports what happened.
 */
export function actionRoutes(app: FastifyInstance, deps: ActionDeps) {
  // The confirmation form posts no fields; accept and ignore its body.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 1024 },
    (_req, _body, done) => done(null, {}),
  );

  const dashboardHint = `Open the dashboard: ${deps.appUrl.replace(/\/+$/, '')}/drafts`;

  const claimsOr = (token: string, reply: FastifyReply): ActionClaims | undefined => {
    const v = verifyActionToken(token, deps.actionSecret);
    if (v.ok) return v.claims;
    if (v.reason === 'expired') {
      void page(reply, 410, 'This link has expired', `Links work for 7 days. ${dashboardHint}`);
    } else {
      void page(reply, 404, 'Link not valid', `This link is not valid. ${dashboardHint}`);
    }
    return undefined;
  };

  app.get<{ Params: { token: string } }>('/actions/:token', async (req, reply) => {
    const c = claimsOr(req.params.token, reply);
    if (!c) return reply;
    const [d] = await withTenant(
      deps.sql,
      c.tenantId,
      (tx) =>
        tx<{ status: string; subject: string }[]>`
          select status, subject from public.drafts where id = ${c.draftId}`,
    );
    if (!d)
      return page(reply, 404, 'Draft not found', `It may have been deleted. ${dashboardHint}`);
    if (d.status !== 'pending_approval') {
      return page(reply, 200, 'Already decided', STATUS_TEXT[d.status] ?? `Status: ${d.status}.`);
    }
    return page(reply, 200, VERB[c.action].question, `Draft: “${d.subject}”`, {
      label: VERB[c.action].confirm,
      danger: c.action === 'reject',
    });
  });

  app.post<{ Params: { token: string } }>('/actions/:token', async (req, reply) => {
    const c = claimsOr(req.params.token, reply);
    if (!c) return reply;
    const outcome = await withTenant(deps.sql, c.tenantId, async (tx) => {
      const [d] = await tx<{ id: string }[]>`
        update public.drafts
        set status = ${c.action === 'approve' ? 'approved' : 'rejected'},
            decided_by = 'owner:email_link', decided_at = now()
        where id = ${c.draftId} and status = 'pending_approval'
        returning id`;
      if (!d) {
        const [cur] = await tx<{ status: string }[]>`
          select status from public.drafts where id = ${c.draftId}`;
        return { decided: false as const, status: cur?.status };
      }
      if (c.action === 'reject') {
        await tx`update public.quotes set status = 'rejected'
                 where draft_id = ${c.draftId} and status = 'pending_approval'`;
      }
      if (c.action === 'approve') {
        await enqueue(tx, {
          tenantId: c.tenantId,
          queue: MAIL_SEND_QUEUE,
          payload: { draftId: c.draftId, sentVia: 'owner_approval' },
          singletonKey: c.draftId,
        });
      }
      await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
               values (${c.tenantId}, 'owner', ${`draft.${c.action === 'approve' ? 'approved' : 'rejected'}`},
                       'draft', ${c.draftId}, ${tx.json({ via: 'email_link' })})`;
      return { decided: true as const };
    });
    if (outcome.decided) return page(reply, 200, VERB[c.action].done, 'You can close this page.');
    if (!outcome.status) return page(reply, 404, 'Draft not found', dashboardHint);
    return page(
      reply,
      200,
      'Already decided',
      STATUS_TEXT[outcome.status] ?? `Status: ${outcome.status}.`,
    );
  });
}
