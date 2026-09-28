import {
  computeValue,
  customerText,
  formatDuration,
  formatSaved,
  localDefaults,
  localMonthStart,
  localWeekStart,
  type AssistantStep,
  type AssistantTool,
  type ValueReport,
} from '@noctiv/core';
import { loadValueRows } from '@noctiv/db';
import { formatMoney } from '@noctiv/quotes';
import type { TransactionSql } from 'postgres';
import { resolveMx } from 'node:dns/promises';
import {
  detectMailbox,
  EMAIL_ADDRESS,
  mailboxFromName,
  PRESETS,
  type DetectedMailbox,
} from '@noctiv/mail';
import { describeReason } from '../notify/templates.ts';
import { nextFreeSlots } from '../bookings/data.ts';
import { formatWhen, zoneName } from '@noctiv/bookings';

/**
 * Noctiv Assistant's read-only tools (PLAN.md §27). Each runs inside the
 * tenant's RLS context (withTenant), so no other business is visible; each
 * returns plain lines rendered by code — the numbers the assistant may use.
 * Text that came from customers is wrapped as data (customerText).
 */
const PROVIDER_NAMES: Record<string, string> = {
  gmail: 'Gmail',
  google_workspace: 'Google Workspace',
  yahoo: 'Yahoo Mail',
  hostinger: 'Hostinger',
  generic: 'other IMAP/SMTP',
  outlook: 'Outlook',
};

const STATUS_TEXT: Record<string, string> = {
  issued: 'ready (not sent)',
  sent: 'sent',
  paid: 'paid',
  delivered: 'delivered',
};

/** The buyer details on this customer's latest invoice or delivery note (address, reg. and VAT no.). */
export async function customerOnFile(
  tx: TransactionSql,
  c: { leadId: string | null; email: string },
): Promise<{ address: string; regNo: string; vatNo: string } | null> {
  const [d] = await tx<{ party: { address?: string; regNo?: string; vatNo?: string } | null }[]>`
    select case when type = 'invoice' then data->'buyer' else data->'receiver' end as party
    from public.documents
    where type in ('invoice', 'delivery_note')
      and (${c.leadId ? tx`lead_id = ${c.leadId} or ` : tx``}lower(data->'buyer'->>'email') = ${c.email.toLowerCase()})
    order by created_at desc limit 1`;
  const party = d?.party;
  return party?.address?.trim()
    ? { address: party.address, regNo: party.regNo ?? '', vatNo: party.vatNo ?? '' }
    : null;
}

/** Customers (leads) by e-mail address, or by a name or the start of the address. */
export async function findCustomers(tx: TransactionSql, query: string) {
  const q = query.trim().toLowerCase();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return tx<
    {
      id: string;
      name: string | null;
      email: string;
      last_activity_at: Date;
      thread_id: string | null;
    }[]
  >`
    select l.id, l.name, l.email::text as email, l.last_activity_at,
           (select th.id from public.threads th where th.lead_id = l.id
            order by th.created_at desc limit 1) as thread_id
    from public.leads l
    where ${q.includes('@') ? tx`lower(l.email::text) = ${q}` : tx`lower(coalesce(l.name, '')) like ${like} or split_part(lower(l.email::text), '@', 1) like ${like}`}
    order by l.last_activity_at desc limit 5`;
}

export interface ToolContext {
  tx: TransactionSql;
  tenantId: string;
  timeZone: string;
  nonce: string;
  /** Runs a mailbox connection test (the worker's health check). */
  checkMailbox: (connectionId: string) => Promise<{ ok: boolean; code?: string | null }>;
  /** MX lookup for mailbox_setup (DNS; a stub in tests). */
  resolveMx?: (domain: string) => Promise<{ exchange: string }[]>;
  /** Bookings (beta): app.noctiv.io, for the booking page address. */
  appUrl?: string;
}

/** DNS MX lookup with a short timeout: an unknown or slow domain is simply "unknown". */
export const dnsResolveMx = (domain: string) =>
  Promise.race([
    resolveMx(domain),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('dns timeout')), 3000)),
  ]);

/** A detected provider as fact lines (servers: the preset for known providers). */
export function mailboxLines(what: string, d: DetectedMailbox): string[] {
  if (d.unsupported)
    return [
      `${what}: ${d.label}. Not supported yet (Microsoft switched off password sign-in for IMAP/SMTP); tell the owner, and do not propose connect_mailbox.`,
    ];
  if (d.source === 'unknown')
    return [
      `${what}: could not tell who hosts it. The form opens as "Other (IMAP/SMTP)": the owner fills in the server names from their email host's help pages.`,
    ];
  const preset = PRESETS[d.provider];
  const imap = preset
    ? `${preset.imap.host}:${preset.imap.port}`
    : `${d.imap!.host}:${d.imap!.port}`;
  const smtp = preset
    ? `${preset.smtp.host}:${preset.smtp.port}`
    : `${d.smtp!.host}:${d.smtp!.port}`;
  const how =
    d.source === 'address'
      ? 'from the address'
      : d.source === 'mx'
        ? "from the domain's mail servers"
        : 'from the provider name';
  return [
    `${what}: ${d.label} (${how}). Servers: IMAP ${imap}, SMTP ${smtp}. The owner only types an App Password; propose connect_mailbox.`,
  ];
}

const ago = (d: Date | null) => {
  if (!d) return 'never';
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  return m < 60
    ? `${m} min ago`
    : m < 1440
      ? `${Math.round(m / 60)} h ago`
      : `${Math.round(m / 1440)} days ago`;
};
const money = (c: number, cur: string) => formatMoney(c, cur);
const mt = (m: { currency: string; count: number; totalCents: number }[]) =>
  m.length ? m.map((x) => `${x.count} (${money(x.totalCents, x.currency)})`).join(' + ') : '0';

function valueLines(label: string, v: ValueReport): string[] {
  return [
    `Period: ${label}`,
    `E-mails answered: ${v.answered}`,
    `Average reply time: ${v.avgReplySeconds === null ? 'no replies' : formatDuration(v.avgReplySeconds)}`,
    `Average if answered only in business hours (Mon–Fri 09:00–17:00): ${v.avgBusinessHoursSeconds === null ? '—' : formatDuration(v.avgBusinessHoursSeconds)}`,
    `Arrived outside business hours: ${v.outsideHoursShare === null ? '—' : `${Math.round(v.outsideHoursShare * 100)}%`}`,
    `Follow-ups sent: ${v.followupsSent}`,
    `Replies won back (customer answered after a follow-up): ${v.wonBack}`,
    `Quotes sent: ${mt(v.quotesSent)}; quotes accepted: ${mt(v.quotesAccepted)}`,
    `Invoices paid: ${mt(v.invoicesPaid)}`,
    `Hours saved (estimate: ${v.assumptions.minutesPerReply} min per reply, ${v.assumptions.minutesPerFollowup} min per follow-up): ${formatSaved(v.minutesSaved)}`,
  ];
}

const localDay = (d: Date, tz: string) =>
  d.toLocaleDateString('en-GB', { timeZone: tz, day: 'numeric', month: 'long' });

export async function runTool(
  name: AssistantTool,
  args: AssistantStep['tool_args'],
  c: ToolContext,
): Promise<string[]> {
  const { tx, timeZone: tz, nonce } = c;
  switch (name) {
    case 'account_overview': {
      const [t] = await tx<Record<string, unknown>[]>`
        select name, website_url, timezone, mode, followup_after_days, followup_max, max_replies_per_hour,
               max_ai_replies_per_sender_24h, quotes_enabled, quotes_currency, quotes_vat_mode,
               quotes_vat_rate::float8 as quotes_vat_rate, quotes_auto_send_limit_cents, documents_enabled,
               auto_invoice_on_accept, auto_delivery_note_after_payment, billing_status, trial_ends_at,
               onboarding_completed_at, weekly_report_enabled
        from public.tenants where id = ${c.tenantId}`;
      const boxes = await tx<
        {
          id: string;
          email_address: string;
          status: string;
          last_ok_at: Date | null;
          is_test_mailbox: boolean;
        }[]
      >`select id, email_address, status, last_ok_at, is_test_mailbox from public.email_connections order by created_at`;
      const kb = await tx<{ status: string; n: number }[]>`
        select status, count(*)::int as n from public.kb_sources group by status`;
      const cur = String(t!.quotes_currency);
      return [
        `Business: ${String(t!.name)}; website: ${String(t!.website_url ?? '—')}; time zone: ${String(t!.timezone)}`,
        `Reply mode: ${String(t!.mode)} (draft_only = mode 1, auto_send = mode 2, full_auto = mode 3)`,
        `Follow-ups: after ${String(t!.followup_after_days)} business days, at most ${String(t!.followup_max)} per conversation`,
        `Limits: ${String(t!.max_replies_per_hour)} automatic replies per hour, ${String(t!.max_ai_replies_per_sender_24h)} per customer per day`,
        `Quotes (beta): ${t!.quotes_enabled ? 'on' : 'off'}; currency ${cur}; VAT ${String(t!.quotes_vat_mode)} ${String(t!.quotes_vat_rate)}%; automatic-send limit ${money(Number(t!.quotes_auto_send_limit_cents), cur)}`,
        `Documents (beta): ${t!.documents_enabled ? 'on' : 'off'}; invoice on quote acceptance: ${t!.auto_invoice_on_accept ? 'on' : 'off'}; delivery note after payment: ${t!.auto_delivery_note_after_payment ? 'on' : 'off'}`,
        `Billing: ${String(t!.billing_status)}${t!.billing_status === 'trial' ? `, trial ends ${localDay(t!.trial_ends_at as Date, tz)}` : ''} (the assistant cannot change billing)`,
        `Setup finished: ${t!.onboarding_completed_at ? 'yes' : 'no'}; weekly summary e-mail: ${t!.weekly_report_enabled ? 'on' : 'off'}`,
        boxes.length
          ? `Mailboxes: ${boxes.map((b) => `${b.email_address} — ${b.status}, last successful check ${ago(b.last_ok_at)}${b.is_test_mailbox ? ', test mailbox' : ''}`).join('; ')}`
          : 'Mailboxes: none connected (Settings → Mailboxes)',
        `Knowledge sources: ${kb.length ? kb.map((k) => `${k.n} ${k.status}`).join(', ') : 'none yet'}`,
      ];
    }
    case 'value_report': {
      const now = new Date();
      const [s] = await tx<{ r: number; f: number }[]>`
        select value_minutes_per_reply as r, value_minutes_per_followup as f from public.tenants
        where id = ${c.tenantId}`;
      const period = args.period ?? 'last_week';
      let from: Date;
      let to: Date;
      if (period === 'this_week') [from, to] = [localWeekStart(now, tz), now];
      else if (period === 'last_week') {
        to = localWeekStart(now, tz);
        from = localWeekStart(new Date(to.getTime() - 1), tz);
      } else if (period === 'this_month') [from, to] = [localMonthStart(now, tz), now];
      else {
        to = localMonthStart(now, tz);
        from = localMonthStart(new Date(to.getTime() - 1), tz);
      }
      const v = computeValue(await loadValueRows(tx, from, to), {
        timeZone: tz,
        assumptions: { minutesPerReply: s!.r, minutesPerFollowup: s!.f },
      });
      const last = new Date(Math.min(to.getTime(), now.getTime()) - 1);
      return valueLines(`${localDay(from, tz)} – ${localDay(last, tz)}`, v);
    }
    case 'find_customer': {
      const q = (args.query ?? '').trim();
      if (q.length < 2) return ['find_customer needs a name or e-mail address (query).'];
      const leads = await findCustomers(tx, q);
      if (!leads.length)
        return [`No customer matches "${q.slice(0, 80)}". A new customer can be used.`];
      const lines = [
        `Customers matching "${q.slice(0, 80)}": ${leads.length}${leads.length > 1 ? ' (several: ask the owner which one)' : ''}`,
      ];
      for (const l of leads) {
        const docs = await tx<
          { number: string; status: string; total_cents: number; currency: string }[]
        >`
          select number, status, total_cents, currency from public.documents
          where lead_id = ${l.id} and number is not null and status in ('issued', 'sent')
          order by created_at desc limit 3`;
        const onFile = await customerOnFile(tx, { leadId: l.id, email: l.email });
        lines.push(
          `${customerText(nonce, l.name ?? '—', 100)} <${l.email}>; ${onFile ? `address on file: ${customerText(nonce, onFile.address, 200)}` : 'no address on file (ask the owner for it before an invoice)'}; last contact ${localDay(l.last_activity_at, tz)}${docs.length ? `; open documents: ${docs.map((d) => `${d.number} (${d.status === 'issued' ? 'ready, not sent' : 'sent, unpaid'}, ${money(d.total_cents, d.currency)})`).join(', ')}` : ''}`,
        );
      }
      return lines;
    }
    case 'documents': {
      const docs = await tx<
        {
          number: string;
          type: string;
          status: string;
          counterparty_name: string | null;
          total_cents: number;
          currency: string;
          due_date: Date | null;
          payable: boolean;
        }[]
      >`
        select number, type, status, counterparty_name, total_cents, currency, due_date, payable
        from public.documents where number is not null and type <> 'cmr' and status <> 'cancelled'
        order by (status in ('issued', 'sent')) desc, created_at desc limit 15`;
      if (!docs.length) return ['Documents: none yet (Documents → New).'];
      return [
        `Documents (unpaid and ready first, at most 15):`,
        ...docs.map(
          (d) =>
            `${d.number}: ${d.type === 'invoice' ? 'invoice' : 'delivery note'}; ${STATUS_TEXT[d.status] ?? d.status}${d.payable && (d.status === 'issued' || d.status === 'sent') ? ', unpaid' : ''}; ${money(d.total_cents, d.currency)}; customer ${customerText(nonce, d.counterparty_name ?? '—', 100)}${d.due_date ? `; due ${localDay(d.due_date, 'UTC')}` : ''}`,
        ),
      ];
    }
    case 'bookings': {
      const [t] = await tx<{ bookings_enabled: boolean; booking_slug: string | null }[]>`
        select bookings_enabled, booking_slug from public.tenants`;
      if (!t!.bookings_enabled)
        return [
          'Bookings (beta): off. It can be turned on in Settings or with a settings card (bookingsEnabled).',
        ];
      const [cal] = await tx<{ account_email: string; status: string }[]>`
        select account_email, status from public.calendar_connections`;
      const { slots } = await nextFreeSlots(tx, tz, 3);
      const upcoming = await tx<{ name: string; starts_at: Date; ends_at: Date; status: string }[]>`
        select name, starts_at, ends_at, status from public.bookings
        where status in ('pending', 'confirmed') and ends_at > now() order by starts_at limit 10`;
      const forms = await tx<{ name: string; n: number }[]>`
        select name, jsonb_array_length(fields)::int as n from public.intake_forms
        where archived_at is null order by name limit 20`;
      const base = (c.appUrl ?? 'https://app.noctiv.io').replace(/\/+$/, '');
      return [
        'Bookings (beta): on.',
        t!.booking_slug
          ? `Booking page: ${base}/book/${t!.booking_slug}`
          : 'Booking page: not set up yet.',
        cal
          ? `Calendar: Google (${cal.account_email}), ${cal.status === 'connected' ? 'connected' : 'not working (connect it again in Bookings → Setup)'}`
          : 'Calendar: none connected (only bookings made in Noctiv are seen).',
        slots.length
          ? `Next free times (${zoneName('en', tz)}): ${slots.map((s) => formatWhen(s.start, s.end, 'en', tz)).join('; ')}`
          : 'Next free times: none in the booking window.',
        upcoming.length
          ? `Upcoming bookings: ${upcoming.length}${upcoming.length === 10 ? ' (the next 10)' : ''}`
          : 'Upcoming bookings: none.',
        ...upcoming.map(
          (b) =>
            `${formatWhen(b.starts_at, b.ends_at, 'en', tz)}: ${customerText(nonce, b.name, 100)}${b.status === 'pending' ? ' (being confirmed)' : ''}`,
        ),
        forms.length
          ? `Intake forms: ${forms.map((f) => `"${f.name}" (${f.n} questions)`).join(', ')}`
          : 'Intake forms: none yet (created in Bookings → Forms).',
      ];
    }
    case 'open_quotes': {
      const q = await tx<
        {
          number: string;
          status: string;
          customer_name: string | null;
          customer_email: string;
          total_cents: number;
          currency: string;
          valid_until: Date;
          hold_reasons: string[];
        }[]
      >`
        select number, status, customer_name, customer_email, total_cents, currency, valid_until, hold_reasons
        from public.quotes where status in ('pending_approval', 'sent', 'viewed')
        order by created_at desc limit 10`;
      if (!q.length) return ['Open quotes: none (nothing waiting for approval, sent or viewed).'];
      return [
        `Open quotes: ${q.length}${q.length === 10 ? ' (the 10 newest)' : ''}`,
        ...q.map(
          (x) =>
            `${x.number}: ${x.status === 'pending_approval' ? 'waiting for your approval' : x.status}; ${money(x.total_cents, x.currency)}; customer ${customerText(nonce, x.customer_name ?? x.customer_email.split('@')[1] ?? '')}; valid until ${localDay(x.valid_until, tz)}${x.hold_reasons.length ? `; held because: ${x.hold_reasons.map(describeReason).join('; ')}` : ''}`,
        ),
      ];
    }
    case 'escalations': {
      const thread =
        args.thread_id && /^[0-9a-f-]{36}$/.test(args.thread_id) ? args.thread_id : null;
      const rows = await tx<
        {
          category: string;
          reason: string | null;
          summary: string | null;
          subject: string | null;
          created_at: Date;
          resolved_at: Date | null;
          reasons: string[] | null;
          final_action: string | null;
        }[]
      >`
        select e.category, e.reason, e.summary, th.subject, e.created_at, e.resolved_at,
               mp.downgrade_reasons as reasons, mp.final_action
        from public.escalations e
        left join public.threads th on th.id = e.thread_id
        left join public.message_processing mp on mp.message_id = e.message_id
        where ${thread ? tx`e.thread_id = ${thread}` : tx`e.resolved_at is null`}
        order by e.created_at desc limit 5`;
      if (!rows.length && thread) {
        const [p] = await tx<
          { final_action: string | null; reasons: string[] | null; status: string }[]
        >`
          select mp.final_action, mp.downgrade_reasons as reasons, mp.status
          from public.messages m join public.message_processing mp on mp.message_id = m.id
          where m.thread_id = ${thread} and m.direction = 'inbound'
          order by m.received_at desc limit 1`;
        if (!p) return ['This conversation has no e-mail Noctiv has processed.'];
        return [
          `This conversation was not escalated. Latest e-mail: ${p.status}; action ${p.final_action ?? '—'}`,
          ...(p.reasons?.length
            ? [`Why it waits for approval: ${p.reasons.map(describeReason).join('; ')}`]
            : []),
        ];
      }
      if (!rows.length)
        return ['No open escalations: nothing is waiting for you to answer yourself.'];
      return rows.map(
        (r) =>
          `${localDay(r.created_at, tz)}: subject ${customerText(nonce, r.subject)}; category ${r.category.replace(/_/g, ' ')}; why: ${[...(r.reason ? r.reason.split(/[,;]\s*/) : []), ...(r.reasons ?? [])].filter(Boolean).map(describeReason).join('; ') || '—'}; summary ${customerText(nonce, r.summary, 300)}${r.resolved_at ? '; resolved' : '; open'}`,
      );
    }
    case 'knowledge_status': {
      const k = await tx<
        {
          type: string;
          title: string | null;
          url: string | null;
          status: string;
          error: string | null;
          chunk_count: number | null;
          ingested_at: Date | null;
        }[]
      >`select type, title, url, status, error, chunk_count, ingested_at from public.kb_sources
        order by created_at desc limit 20`;
      if (!k.length)
        return ['Knowledge base: empty. Add the website, files or a note in Knowledge.'];
      return [
        `Knowledge sources: ${k.length}${k.length === 20 ? ' (the 20 newest)' : ''}`,
        ...k.map(
          (s) =>
            `${s.type}: ${s.title ?? s.url ?? '—'} — ${s.status}${s.error ? ` (${s.error})` : ''}${s.chunk_count ? `, ${s.chunk_count} passages` : ''}${s.ingested_at ? `, read ${ago(s.ingested_at)}` : ''}`,
        ),
      ];
    }
    case 'price_list': {
      const items = await tx<
        { name: string; unit: string; unit_price_cents: number; status: string }[]
      >`
        select name, unit, unit_price_cents, status from public.price_items where status <> 'archived'
        order by (status = 'draft') desc, name limit 25`;
      const [t] = await tx<{ currency: string }[]>`
        select quotes_currency as currency from public.tenants where id = ${c.tenantId}`;
      if (!items.length) return ['Price list: empty (Quotes → Price list).'];
      return [
        `Price list items: ${items.length}${items.length === 25 ? ' (first 25)' : ''}`,
        ...items.map(
          (i) => `${i.name}: ${money(i.unit_price_cents, t!.currency)} per ${i.unit} (${i.status})`,
        ),
      ];
    }
    case 'mailbox_setup': {
      const q = (args.query ?? '').trim();
      if (!q) return ['mailbox_setup needs the e-mail address or the provider name (query).'];
      const connected = await tx<{ email_address: string }[]>`
        select email_address from public.email_connections where status = 'connected'`;
      const already = connected.find((c) => c.email_address.toLowerCase() === q.toLowerCase());
      if (already) return [`${already.email_address} is already connected: nothing to set up.`];
      if (EMAIL_ADDRESS.test(q))
        return mailboxLines(q, await detectMailbox(q, c.resolveMx ?? dnsResolveMx));
      const named = mailboxFromName(q);
      return named
        ? mailboxLines(`Provider "${q.slice(0, 60)}"`, named)
        : [
            `"${q.slice(0, 60)}" is not a provider Noctiv knows by name: ask for the e-mail address instead.`,
          ];
    }
    case 'mailbox_check': {
      const boxes = await tx<{ id: string; email_address: string; provider: string }[]>`
        select id, email_address, provider from public.email_connections where status = 'connected'
        order by created_at limit 3`;
      if (!boxes.length)
        return [
          'No mailbox is connected yet. During setup: the "Connect mailbox" button below the chat; later: Settings → Mailboxes.',
        ];
      const out: string[] = [
        `Connected mailboxes: ${boxes.length} (already connected: do not ask the owner to connect it again)`,
      ];
      for (const b of boxes) {
        const r = await c.checkMailbox(b.id);
        out.push(
          `${b.email_address} (provider: ${PROVIDER_NAMES[b.provider] ?? b.provider}): ${r.ok ? 'connection OK (IMAP and SMTP login work)' : `connection failed (${r.code ?? 'unknown error'})`}`,
        );
      }
      return out;
    }
    case 'locale_defaults': {
      const zone = args.timezone ?? tz;
      const d = localDefaults(zone);
      return d
        ? [`Usual for ${zone}: currency ${d.currency}, standard VAT rate ${d.vatRate}%`]
        : [`No defaults known for ${zone}: ask the owner for currency and VAT rate.`];
    }
  }
}
