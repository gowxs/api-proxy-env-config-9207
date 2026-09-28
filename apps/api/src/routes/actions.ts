import {
  ACTION_LINK_TTL_MS,
  buildAllowlist,
  describeConflicts,
  describeReason,
  renderReplyEmail,
  signActionToken,
  verifyActionToken,
  type ActionClaims,
  type AllowlistEntry,
  type DraftAction,
} from '@noctiv/core';
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

export function page(
  reply: FastifyReply,
  code: number,
  title: string,
  body: string,
  form?: { label: string; danger: boolean },
  link?: { href: string; label: string },
  /** The business's logo or name (brandHeader), above the title. */
  brand?: string,
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
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Noctiv</title></head>` +
        `<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#1a1a1a">` +
        `${brand ?? ''}<h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>${button}${link ? `<p><a href="${escapeHtml(link.href)}" style="color:#1f3a5f">${escapeHtml(link.label)}</a></p>` : ''}</body></html>`,
    );
}

/** Everything the owner needs to decide, loaded in the tenant's context. */
interface Review {
  draft: {
    id: string;
    kind: string;
    to: string;
    subject: string;
    text: string;
    createdAt: Date;
    attachments: string[];
  };
  customer: {
    name: string | null;
    address: string;
    receivedAt: Date;
    subject: string | null;
    text: string | null;
  } | null;
  reasons: string[];
  conflicts: string[];
  timeZone: string;
  businessName: string;
}

async function loadReview(
  sql: Sql,
  c: ActionClaims,
): Promise<{ status: string; review: Review } | null> {
  return withTenant(sql, c.tenantId, async (tx) => {
    const [d] = await tx<
      {
        id: string;
        status: string;
        kind: string;
        to_address: string;
        subject: string;
        body: string | null;
        created_at: Date;
        source_message_id: string | null;
        booking_id: string | null;
        name: string;
        timezone: string;
        reply_signature: string | null;
        email_template: string;
        brand_company_name: string | null;
        brand_logo_url: string | null;
        brand_color: string | null;
        brand_website: string | null;
        brand_phone: string | null;
        brand_address: string | null;
        brand_social_links: unknown;
      }[]
    >`
      select d.id, d.status, d.kind, d.to_address, d.subject, d.body, d.created_at, d.source_message_id, d.booking_id,
             t.name, t.timezone, t.reply_signature, t.email_template, t.brand_company_name, t.brand_logo_url,
             t.brand_color, t.brand_website, t.brand_phone, t.brand_address, t.brand_social_links
      from public.drafts d join public.tenants t on t.id = d.tenant_id
      where d.id = ${c.draftId}`;
    if (!d) return null;
    const [m] = d.source_message_id
      ? await tx<
          {
            from_address: string;
            from_name: string | null;
            received_at: Date;
            subject: string | null;
            body_text: string | null;
          }[]
        >`select from_address, from_name, received_at, subject, body_text
          from public.messages where id = ${d.source_message_id}`
      : [];
    const [mp] = d.source_message_id
      ? await tx<{ downgrade_reasons: string[] | null }[]>`
          select downgrade_reasons from public.message_processing where message_id = ${d.source_message_id}`
      : [];
    const quotes = await tx<{ number: string; hold_reasons: string[] | null }[]>`
      select number, hold_reasons from public.quotes where draft_id = ${d.id}`;
    const docs = await tx<{ type: string; number: string | null }[]>`
      select type, number from public.documents where draft_id = ${d.id} order by created_at`;
    const [n] = await tx<{ payload: { reasons?: unknown; conflicts?: unknown } }[]>`
      select payload from public.notifications
      where kind = 'draft_ready' and payload->>'draftId' = ${d.id} order by created_at desc limit 1`;
    const allowRows =
      d.email_template === 'plain'
        ? []
        : await tx<AllowlistEntry[]>`select distinct kind, value from public.kb_allowlist`;
    // The same rendering as the worker's send (mail-send.ts): the text version the customer gets.
    const rendered = renderReplyEmail({
      template: d.email_template as never,
      body: d.body ?? '',
      signature: d.reply_signature,
      brand: {
        companyName: d.brand_company_name ?? d.name,
        logoUrl: d.brand_logo_url,
        color: d.brand_color,
        website: d.brand_website,
        phone: d.brand_phone,
        address: d.brand_address,
        socialLinks: d.brand_social_links as never,
        logoInline: false,
      },
      allowlist: buildAllowlist(allowRows),
    });
    const reasonCodes = [
      ...new Set([
        ...(mp?.downgrade_reasons ?? []),
        ...(Array.isArray(n?.payload.reasons) ? (n.payload.reasons as string[]) : []),
        ...quotes.flatMap((q) => q.hold_reasons ?? []),
      ]),
    ].filter((r) => typeof r === 'string' && r !== 'acknowledgement_sent');
    const docName: Record<string, string> = {
      invoice: 'Invoice',
      delivery_note: 'Delivery note',
      cmr: 'CMR',
    };
    return {
      status: d.status,
      review: {
        draft: {
          id: d.id,
          kind: d.kind,
          to: d.to_address,
          subject: d.subject,
          text: rendered.text,
          createdAt: d.created_at,
          attachments: [
            ...quotes.map((q) => `Quote ${q.number} (PDF)`),
            ...docs.map((x) =>
              `${docName[x.type] ?? x.type} ${x.number ?? ''} (PDF)`.replace('  ', ' '),
            ),
            ...(d.booking_id ? ['Calendar invitation (.ics)'] : []),
          ],
        },
        customer: m
          ? {
              name: m.from_name,
              address: m.from_address,
              receivedAt: m.received_at,
              subject: m.subject,
              text: m.body_text,
            }
          : null,
        reasons: reasonCodes.map(describeReason),
        conflicts: describeConflicts(n?.payload.conflicts),
        timeZone: d.timezone,
        businessName: d.name,
      },
    };
  });
}

const MAX_CUSTOMER_TEXT = 20_000;

function when(d: Date, timeZone: string): string {
  try {
    return d.toLocaleString('en-GB', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }
}

/**
 * The review page behind an Approve / Reject link: the customer's e-mail, the
 * reply exactly as it will be sent (with signature), why it waits and which
 * sources disagree, then the three choices. Full text here: the link is
 * signed for the owner (privacy mode only limits what the notification e-mail
 * shows). No scripts; each button posts its own signed link.
 */
function reviewPage(
  reply: FastifyReply,
  r: Review,
  links: { approve: string; reject: string; dashboard: string },
  opened: DraftAction,
) {
  const e = escapeHtml;
  const box = 'margin:0 0 16px;padding:12px 14px;border-radius:10px';
  const label =
    'margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#5B6275';
  const pre =
    'margin:8px 0 0;white-space:pre-wrap;word-wrap:break-word;overflow-wrap:anywhere;font:inherit';
  const row = (k: string, v: string) =>
    `<div style="display:flex;gap:8px;margin:2px 0"><span style="color:#5B6275;min-width:64px">${e(k)}</span><span style="overflow-wrap:anywhere">${v}</span></div>`;
  const c = r.customer;
  const customerText = c?.text
    ? e(c.text.length > MAX_CUSTOMER_TEXT ? `${c.text.slice(0, MAX_CUSTOMER_TEXT)}\n[…]` : c.text)
    : '<span style="color:#5B6275">The e-mail text is no longer stored (retention period).</span>';
  const button = (href: string, text: string, bg: string) =>
    `<form method="post" action="${e(href)}" style="margin:0 0 10px"><button type="submit" style="width:100%;font-size:17px;padding:14px 18px;border:0;border-radius:10px;color:#fff;background:${bg};cursor:pointer">${e(text)}</button></form>`;
  const html =
    `<h1 style="font-size:21px;margin:0 0 4px">${e(opened === 'reject' ? 'Reject this reply?' : 'Send this reply?')}</h1>` +
    `<p style="margin:0 0 18px;color:#5B6275">${e(r.businessName)} · drafted ${e(when(r.draft.createdAt, r.timeZone))}</p>` +
    (r.reasons.length
      ? `<section style="${box};background:#FFF6E5;border:1px solid #F3D9A4"><p style="${label}">Why it waits for you</p>` +
        `<ul style="margin:0;padding-left:18px">${r.reasons.map((x) => `<li>${e(x)}</li>`).join('')}</ul></section>`
      : '') +
    (r.conflicts.length
      ? `<section style="${box};background:#FDECEC;border:1px solid #F1B8B8"><p style="${label}">Sources disagree</p>` +
        r.conflicts.map((x) => `<p style="margin:0 0 8px">${e(x)}</p>`).join('') +
        `<p style="margin:0;color:#5B6275">Please correct the source that is out of date.</p></section>`
      : '') +
    `<section style="${box};background:#F5F6FA;border:1px solid #E3E6EE"><p style="${label}">The customer wrote</p>` +
    (c
      ? row('From', c.name ? `${e(c.name)} &lt;${e(c.address)}&gt;` : e(c.address)) +
        row('Received', e(when(c.receivedAt, r.timeZone))) +
        row('Subject', e(c.subject ?? '(no subject)')) +
        `<div style="${pre}">${customerText}</div>`
      : '<p style="margin:0">This reply was not written to an incoming e-mail.</p>') +
    `</section>` +
    `<section style="${box};background:#fff;border:1px solid #C9CFE0"><p style="${label}">Your reply, as it will be sent</p>` +
    row('To', e(r.draft.to)) +
    row('Subject', e(r.draft.subject)) +
    r.draft.attachments.map((a) => row('Attached', e(a))).join('') +
    `<div style="${pre}">${e(r.draft.text)}</div></section>` +
    button(links.approve, 'Approve and send', '#1f3a5f') +
    `<p style="margin:0 0 10px"><a href="${e(links.dashboard)}" style="display:block;text-align:center;font-size:17px;padding:13px 18px;border:1px solid #1f3a5f;border-radius:10px;color:#1f3a5f;text-decoration:none">Edit in dashboard</a></p>` +
    button(links.reject, 'Reject', '#8a1f1f') +
    `<p style="margin:14px 0 0;font-size:13px;color:#5B6275">Nothing is sent until you press Approve and send. This link works for 7 days.</p>`;
  return reply
    .code(200)
    .headers({
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review reply · Noctiv</title></head>` +
        `<body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:16px;line-height:1.45;max-width:560px;margin:24px auto 40px;padding:0 16px;color:#1a1a1a;background:#fff">${html}</body></html>`,
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
    const loaded = await loadReview(deps.sql, c);
    if (!loaded)
      return page(reply, 404, 'Draft not found', `It may have been deleted. ${dashboardHint}`);
    if (loaded.status !== 'pending_approval') {
      return page(
        reply,
        200,
        'Already decided',
        STATUS_TEXT[loaded.status] ?? `Status: ${loaded.status}.`,
      );
    }
    // The other choice gets its own link, expiring with this one. Relative: the page is served
    // both as /actions/… (API) and /api/actions/… (app.noctiv.io).
    const other: DraftAction = c.action === 'approve' ? 'reject' : 'approve';
    const otherToken = signActionToken(
      { tenantId: c.tenantId, draftId: c.draftId, action: other },
      deps.actionSecret,
      new Date(c.expiresAt.getTime() - ACTION_LINK_TTL_MS),
    );
    const own = req.params.token;
    return reviewPage(
      reply,
      loaded.review,
      {
        approve: c.action === 'approve' ? own : otherToken,
        reject: c.action === 'reject' ? own : otherToken,
        dashboard: `${deps.appUrl.replace(/\/+$/, '')}/drafts/${c.draftId}`,
      },
      c.action,
    );
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
