import { logoAllowed } from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import { createSafeFetcher, loadAllowlist, type SafeFetch } from '@noctiv/kb';
import { DOCUMENTS_AUTOMATION_QUEUE, vatNoValid } from '@noctiv/documents';
import {
  fetchQuoteLogo,
  formatDate,
  formatMoney,
  formatQty,
  unitFor,
  formatRate,
  languageFromAcceptHeader,
  loadQuoteDocument,
  quoteLabels,
  quoteLang,
  quoteLocale,
  quoteAcceptUrl,
  quotePdfFileName,
  quotePdfInput,
  renderQuotePdf,
  verifyQuoteToken,
  type QuoteClaims,
  type QuoteDocument,
} from '@noctiv/quotes';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Sql, TransactionSql } from 'postgres';

export interface QuoteLinkDeps {
  sql: Sql;
  secret: string;
  publicApiUrl: string;
  /** Tests replace it; production uses the SSRF-safe fetcher. */
  fetchLogo?: SafeFetch;
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  // No scripts, no external resources; the form may only post back here.
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

function shell(
  reply: FastifyReply,
  code: number,
  lang: string,
  title: string,
  inner: string,
  color = '#2F3A56',
) {
  return reply
    .code(code)
    .headers(HEADERS)
    .send(
      `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>` +
        `<body style="margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1F2430;background:#F4F5F7">` +
        `<div style="height:6px;background:${color}"></div>` +
        `<main style="max-width:560px;margin:32px auto;padding:0 16px">${inner}</main></body></html>`,
    );
}

/** A short page with no quote on it (bad link, not found), in the browser's language. */
const message = (
  reply: FastifyReply,
  req: FastifyRequest,
  code: number,
  pick: (t: ReturnType<typeof quoteLabels>) => [string, string],
) => {
  const lang = languageFromAcceptHeader(req.headers['accept-language']);
  const [title, body] = pick(quoteLabels(lang));
  return shell(
    reply,
    code,
    lang,
    title,
    `<h1 style="font-size:20px">${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p>`,
  );
};
const notFound = (reply: FastifyReply, req: FastifyRequest) =>
  message(reply, req, 404, (t) => [t.notFound, t.replyToEmail]);

/** The note under the quote for a decided quote, in the quote's language. */
const statusNote = (status: string, language: string | null) => {
  const t = quoteLabels(language);
  return status === 'accepted'
    ? t.accepted
    : status === 'expired'
      ? t.expired
      : status === 'rejected'
        ? t.rejected
        : null;
};

/** Billing details asked before accepting (PLAN.md §21.8); stored on the lead. */
export interface Billing {
  name: string;
  address: string;
  regNo: string;
  vatNo: string;
}
type BillingErrors = Partial<Record<keyof Billing, string>>;
const BILLING_MAX: Record<keyof Billing, number> = {
  name: 200,
  address: 500,
  regNo: 40,
  vatNo: 30,
};

/** Reads and checks the form: name and address required, the VAT number must look like one. */
export function readBilling(
  body: unknown,
  language: string | null,
): { billing: Billing; errors: BillingErrors } {
  const t = quoteLabels(language);
  const f = (body ?? {}) as Record<string, string[] | undefined>;
  const v = (k: keyof Billing) =>
    (f[k]?.[0] ?? '').replace(/\s+/g, ' ').trim().slice(0, BILLING_MAX[k]);
  const billing: Billing = {
    name: v('name'),
    address: v('address'),
    regNo: v('regNo'),
    vatNo: v('vatNo').replace(/\s+/g, '').toUpperCase(),
  };
  const errors: BillingErrors = {};
  if (!billing.name) errors.name = t.required;
  if (!billing.address) errors.address = t.required;
  if (billing.vatNo && !vatNoValid(billing.vatNo)) errors.vatNo = t.vatInvalid;
  return { billing, errors };
}

function billingFields(
  t: ReturnType<typeof quoteLabels>,
  b: Billing,
  errors: BillingErrors,
  color: string,
): string {
  const field = (
    k: keyof Billing,
    label: string,
    o: { required?: boolean; autocomplete: string; textarea?: boolean },
  ) => {
    const id = `b-${k}`;
    const err = errors[k];
    const style = `display:block;box-sizing:border-box;width:100%;margin-top:6px;padding:12px;font:inherit;font-size:16px;border:1.5px solid ${err ? '#B42318' : '#C9CEDA'};border-radius:8px;background:#fff;color:#1F2430`;
    const attrs = `id="${id}" name="${k}" maxlength="${BILLING_MAX[k]}" autocomplete="${o.autocomplete}"${o.required ? ' required' : ''}${err ? ` aria-invalid="true" aria-describedby="${id}-err"` : ''}`;
    const input = o.textarea
      ? `<textarea ${attrs} rows="2" style="${style};resize:vertical">${escapeHtml(b[k])}</textarea>`
      : `<input ${attrs} value="${escapeHtml(b[k])}" style="${style}">`;
    return (
      `<p style="margin:14px 0 0"><label for="${id}" style="font-weight:600;font-size:15px">${escapeHtml(label)}` +
      (o.required
        ? ''
        : ` <span style="font-weight:400;color:#5B6275">(${escapeHtml(t.optional)})</span>`) +
      `</label>${input}` +
      (err
        ? `<span id="${id}-err" style="display:block;margin-top:4px;color:#B42318;font-size:14px">${escapeHtml(err)}</span>`
        : '') +
      `</p>`
    );
  };
  const hasErrors = Object.keys(errors).length > 0;
  return (
    `<fieldset style="margin:20px 0 0;padding:20px;border:0;border-radius:12px;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.06)">` +
    `<legend style="float:left;width:100%;padding:0;font-size:18px;font-weight:700">${escapeHtml(t.billingHeading)}</legend>` +
    `<p style="clear:both;margin:4px 0 0;color:#5B6275;font-size:14px">${escapeHtml(t.billingIntro)}</p>` +
    (hasErrors
      ? `<p role="alert" style="margin:12px 0 0;padding:10px 12px;border-radius:8px;background:#FEF3F2;color:#B42318;font-size:14px">${escapeHtml(t.fixBelow)}</p>`
      : '') +
    field('name', t.billingName, { required: true, autocomplete: 'organization' }) +
    field('address', t.billingAddress, {
      required: true,
      autocomplete: 'street-address',
      textarea: true,
    }) +
    field('regNo', t.billingRegNo, { autocomplete: 'off' }) +
    field('vatNo', t.billingVatNo, { autocomplete: 'off' }) +
    `</fieldset>` +
    `<button type="submit" style="width:100%;margin-top:20px;font-size:16px;padding:14px 18px;border:0;border-radius:8px;color:#fff;background:${color};cursor:pointer">${escapeHtml(t.acceptButton)}</button>`
  );
}

function quotePage(
  reply: FastifyReply,
  token: string,
  d: QuoteDocument,
  note: string | null,
  canAccept: boolean,
  form: { billing: Billing; errors: BillingErrors } = {
    billing: { name: '', address: '', regNo: '', vatNo: '' },
    errors: {},
  },
) {
  const t = quoteLabels(d.language);
  const lang = quoteLang(d.language);
  const locale = quoteLocale(lang);
  const rate = formatRate(d.vatRate, lang);
  const money = (c: number) => escapeHtml(formatMoney(c, d.currency, locale));
  const color =
    d.brand.color && /^#[0-9A-Fa-f]{6}$/.test(d.brand.color) ? d.brand.color : '#2F3A56';
  const rows = d.lines
    .map(
      (l) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #E3E6EE">${escapeHtml(l.name)}<br><span style="color:#5B6275;font-size:13px">${escapeHtml(formatQty(l.qty, locale))} ${escapeHtml(unitFor(l.unit, l.qty, lang))} × ${money(l.unitPriceCents)}</span></td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #E3E6EE;text-align:right;white-space:nowrap">${money(l.lineTotalCents)}</td></tr>`,
    )
    .join('');
  const total = (label: string, v: number, strong = false) =>
    `<tr><td style="padding:4px 0;text-align:right;${strong ? 'font-weight:700' : 'color:#5B6275'}">${escapeHtml(label)}</td><td style="padding:4px 0 4px 16px;text-align:right;white-space:nowrap;${strong ? 'font-weight:700' : ''}">${money(v)}</td></tr>`;
  const totals =
    d.vatMode === 'exclusive'
      ? total(t.subtotal, d.subtotalCents) +
        total(t.vat(rate), d.vatCents) +
        total(t.total, d.totalCents, true)
      : d.vatMode === 'inclusive'
        ? total(t.total, d.totalCents, true) + total(t.ofWhichVat(rate), d.vatCents)
        : total(t.total, d.totalCents, true);
  const inner =
    `<section style="background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 2px rgba(0,0,0,.06)">` +
    `<p style="margin:0;color:#5B6275;font-size:14px">${escapeHtml(d.brand.companyName)}</p>` +
    `<h1 style="margin:4px 0 2px;font-size:22px">${escapeHtml(t.quote)} <span style="white-space:nowrap">${escapeHtml(d.number)}</span></h1>` +
    `<p style="margin:0 0 16px;color:#5B6275;font-size:14px">${escapeHtml(t.validUntil)} ${escapeHtml(formatDate(d.validUntil, lang))}</p>` +
    `<table style="width:100%;border-collapse:collapse;font-size:15px">${rows}</table>` +
    `<table style="margin:12px 0 0 auto;border-collapse:collapse;font-size:15px">${totals}</table>` +
    (d.notes
      ? `<p style="margin:16px 0 0;font-size:14px;white-space:pre-wrap">${escapeHtml(d.notes)}</p>`
      : '') +
    `</section>` +
    (note
      ? `<p style="margin:20px 0;padding:12px 14px;border-radius:8px;background:#fff">${escapeHtml(note)}</p>`
      : '') +
    (canAccept
      ? `<form method="post" style="margin:0 0 20px">${billingFields(t, form.billing, form.errors, color)}</form>`
      : '') +
    `<p style="margin:16px 0;font-size:14px"><a href="${escapeHtml(token)}/pdf" style="color:${color}">${escapeHtml(t.downloadPdf)}</a></p>`;
  const code = Object.keys(form.errors).length ? 400 : 200;
  return shell(reply, code, lang, `${t.quote} ${d.number}`, inner, color);
}

/**
 * The customer's "Approve quote" link (PLAN.md §21.5). Opening it shows the
 * quote and marks it viewed; only the button (POST) accepts, so mail
 * scanners that pre-open links cannot accept anything.
 */
export function quoteLinkRoutes(app: FastifyInstance, deps: QuoteLinkDeps) {
  const fetchLogo =
    deps.fetchLogo ?? createSafeFetcher({ maxBytes: 1024 * 1024, timeoutMs: 8_000 });

  const claimsOr = (
    req: FastifyRequest<{ Params: { token: string } }>,
    reply: FastifyReply,
  ): QuoteClaims | undefined => {
    const v = verifyQuoteToken(req.params.token, deps.secret);
    if (v.ok) return v.claims;
    void message(reply, req, v.reason === 'expired' ? 410 : 404, (t) => [
      v.reason === 'expired' ? t.linkExpired : t.linkInvalid,
      t.askNew,
    ]);
    return undefined;
  };

  /** Validity is judged in the tenant's time zone (the date on the quote). */
  const isPastValidity = (tx: TransactionSql, quoteId: string) =>
    tx<{ past: boolean }[]>`
      select q.valid_until < (now() at time zone t.timezone)::date as past
      from public.quotes q join public.tenants t on t.id = q.tenant_id where q.id = ${quoteId}`;

  /**
   * What we already know about the buyer: their lead's billing details, else
   * the buyer on their latest invoice, else the name on the quote.
   */
  const knownBilling = async (tx: TransactionSql, quoteId: string): Promise<Billing> => {
    const [q] = await tx<
      {
        customer_name: string | null;
        customer_email: string;
        billing_name: string | null;
        billing_address: string | null;
        billing_reg_no: string | null;
        billing_vat_no: string | null;
      }[]
    >`select q.customer_name, q.customer_email::text, l.billing_name, l.billing_address,
             l.billing_reg_no, l.billing_vat_no
      from public.quotes q left join public.leads l on l.id = q.lead_id where q.id = ${quoteId}`;
    if (!q) return { name: '', address: '', regNo: '', vatNo: '' };
    if (q.billing_name && q.billing_address)
      return {
        name: q.billing_name,
        address: q.billing_address,
        regNo: q.billing_reg_no ?? '',
        vatNo: q.billing_vat_no ?? '',
      };
    const [inv] = await tx<{ name: string; address: string; reg_no: string; vat_no: string }[]>`
      select data->'buyer'->>'name' as name, data->'buyer'->>'address' as address,
             coalesce(data->'buyer'->>'regNo', '') as reg_no, coalesce(data->'buyer'->>'vatNo', '') as vat_no
      from public.documents
      where type = 'invoice' and number is not null and status <> 'cancelled'
        and lower(data->'buyer'->>'email') = lower(${q.customer_email})
        and coalesce(data->'buyer'->>'address', '') <> ''
      order by issued_at desc nulls last limit 1`;
    if (inv) return { name: inv.name, address: inv.address, regNo: inv.reg_no, vatNo: inv.vat_no };
    return { name: q.customer_name ?? '', address: '', regNo: '', vatNo: '' };
  };

  app.get<{ Params: { token: string } }>('/q/:token', async (req, reply) => {
    const c = claimsOr(req, reply);
    if (!c) return reply;
    let billing: Billing = { name: '', address: '', regNo: '', vatNo: '' };
    const d = await withTenant(deps.sql, c.tenantId, async (tx) => {
      await tx`update public.quotes set status = 'viewed', viewed_at = now()
               where id = ${c.quoteId} and status = 'sent'`;
      billing = await knownBilling(tx, c.quoteId);
      return loadQuoteDocument(tx, c.quoteId);
    });
    if (!d || !['sent', 'viewed', 'accepted', 'expired', 'rejected'].includes(d.status))
      return notFound(reply, req);
    const [v] = await withTenant(deps.sql, c.tenantId, (tx) => isPastValidity(tx, c.quoteId));
    const status = d.status !== 'accepted' && v?.past ? 'expired' : d.status;
    return quotePage(
      reply,
      req.params.token,
      d,
      statusNote(status, d.language),
      status === 'sent' || status === 'viewed',
      { billing, errors: {} },
    );
  });

  app.post<{ Params: { token: string } }>('/q/:token', async (req, reply) => {
    const c = claimsOr(req, reply);
    if (!c) return reply;
    const current = await withTenant(deps.sql, c.tenantId, async (tx) => {
      const doc = await loadQuoteDocument(tx, c.quoteId);
      const [v] = await isPastValidity(tx, c.quoteId);
      return doc ? { doc, past: Boolean(v?.past) } : null;
    });
    if (!current) return notFound(reply, req);
    const { billing, errors } = readBilling(req.body, current.doc.language);
    const open = ['sent', 'viewed'].includes(current.doc.status) && !current.past;
    // Billing details are needed to accept; a decided or expired quote just shows its state.
    if (open && Object.keys(errors).length)
      return quotePage(reply, req.params.token, current.doc, null, true, { billing, errors });
    const d = await withTenant(deps.sql, c.tenantId, async (tx) => {
      const [past] = await isPastValidity(tx, c.quoteId);
      const [q] = await tx<
        {
          id: string;
          lead_id: string | null;
          thread_id: string;
          number: string;
          total_cents: number;
          currency: string;
        }[]
      >`
        update public.quotes set status = 'accepted', accepted_at = now()
        where id = ${c.quoteId} and status in ('sent', 'viewed') and ${!past?.past}
        returning id, lead_id, thread_id, number, total_cents, currency`;
      if (q) {
        // The buyer's billing details go on their lead (created if the quote has none).
        const [ql] = await tx<{ customer_email: string }[]>`
          select customer_email::text from public.quotes where id = ${q.id}`;
        const [lead] = q.lead_id
          ? [{ id: q.lead_id }]
          : await tx<{ id: string }[]>`
              insert into public.leads (tenant_id, email) values (${c.tenantId}, ${ql!.customer_email})
              on conflict (tenant_id, email) do update set stage = leads.stage
              returning id`;
        await tx`update public.leads
                 set billing_name = ${billing.name}, billing_address = ${billing.address},
                     billing_reg_no = ${billing.regNo || null}, billing_vat_no = ${billing.vatNo || null},
                     billing_updated_at = now()
                 where id = ${lead!.id}`;
        if (!q.lead_id) await tx`update public.quotes set lead_id = ${lead!.id} where id = ${q.id}`;
        if (q.lead_id) {
          const [lead] = await tx<{ stage: string }[]>`
            select stage from public.leads where id = ${q.lead_id} for update`;
          if (lead && lead.stage !== 'accepted' && lead.stage !== 'converted') {
            await tx`update public.leads set stage = 'accepted', stage_changed_at = now() where id = ${q.lead_id}`;
            await tx`insert into public.lead_events (tenant_id, lead_id, from_stage, to_stage, actor, reason)
                     values (${c.tenantId}, ${q.lead_id}, ${lead.stage}, 'accepted', 'system',
                             ${`quote ${q.number} accepted`})`;
          }
        }
        // The owner e-mail says whether the invoice follows on its own (QA #28).
        const [auto] = await tx<{ on: boolean }[]>`
          select (documents_enabled and auto_invoice_on_accept) as on
          from public.tenants where id = ${c.tenantId}`;
        await tx`insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
                 values (${c.tenantId}, 'email_owner', 'quote_accepted', ${`quote_accepted:${q.id}`},
                         ${tx.json({ quoteId: q.id, threadId: q.thread_id, number: q.number, totalCents: q.total_cents, currency: q.currency, autoInvoice: Boolean(auto?.on) })})
                 on conflict do nothing`;
        await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
                 values (${c.tenantId}, 'system', 'quote.accepted', 'quote', ${q.id}, ${tx.json({ via: 'customer_link' })})`;
        // Documents automation (PLAN.md §22.11): the invoice follows on its own.
        await tx`
          insert into public.jobs (tenant_id, queue, payload, singleton_key)
          select t.id, ${DOCUMENTS_AUTOMATION_QUEUE}, ${tx.json({ event: 'quote_accepted', quoteId: q.id })},
                 ${`auto:quote:${q.id}`}
          from public.tenants t
          where t.id = ${c.tenantId} and t.documents_enabled and t.auto_invoice_on_accept
          on conflict (queue, singleton_key) where singleton_key is not null and status in ('queued', 'running')
          do nothing`;
      } else if (past?.past) {
        await tx`update public.quotes set status = 'expired', expired_at = now()
                 where id = ${c.quoteId} and status in ('sent', 'viewed')`;
      }
      return loadQuoteDocument(tx, c.quoteId);
    });
    if (!d || !['sent', 'viewed', 'accepted', 'expired', 'rejected'].includes(d.status))
      return notFound(reply, req);
    return quotePage(reply, req.params.token, d, statusNote(d.status, d.language), false);
  });

  app.get<{ Params: { token: string } }>('/q/:token/pdf', async (req, reply) => {
    const c = claimsOr(req, reply);
    if (!c) return reply;
    const found = await withTenant(deps.sql, c.tenantId, async (tx) => {
      const d = await loadQuoteDocument(tx, c.quoteId);
      if (!d) return null;
      const allowed = logoAllowed(d.brand.logoUrl, await loadAllowlist(tx));
      return { d, allowed };
    });
    if (!found || !['sent', 'viewed', 'accepted', 'expired'].includes(found.d.status))
      return notFound(reply, req);
    const logo = found.allowed ? await fetchQuoteLogo(fetchLogo, found.d.brand.logoUrl) : null;
    const pdf = await renderQuotePdf(
      quotePdfInput(found.d, quoteAcceptUrl(deps.publicApiUrl, req.params.token), logo),
    );
    return reply
      .code(200)
      .headers({
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${quotePdfFileName(found.d.number, found.d.language)}"`,
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex, nofollow',
        'x-content-type-options': 'nosniff',
      })
      .send(pdf);
  });
}
