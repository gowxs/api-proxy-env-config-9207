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
import { describeReason } from '../notify/templates.ts';

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

export interface ToolContext {
  tx: TransactionSql;
  tenantId: string;
  timeZone: string;
  nonce: string;
  /** Runs a mailbox connection test (the worker's health check). */
  checkMailbox: (connectionId: string) => Promise<{ ok: boolean; code?: string | null }>;
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
