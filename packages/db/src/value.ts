import type { MoneyTotal, ValueRows } from '@noctiv/core';
import type { TransactionSql } from 'postgres';

/**
 * The facts behind the value report (PLAN.md §26) for [from, to), inside the
 * tenant's RLS context (API dashboard and worker Monday e-mail).
 *  - answered: a customer e-mail whose first reply (reply, quote or document
 *    cover; not the mode-3 acknowledgement) was sent in the period;
 *  - follow-ups: follow-up e-mails sent in the period;
 *  - won back: conversations where the customer wrote in the period and the
 *    last e-mail before theirs was a follow-up;
 *  - quotes sent / accepted and invoices paid in the period, per currency.
 */
export async function loadValueRows(tx: TransactionSql, from: Date, to: Date): Promise<ValueRows> {
  const replies = await tx<{ received_at: Date; sent_at: Date }[]>`
    select m.received_at, min(o.sent_at) as sent_at
    from public.outbound_emails o
    join public.drafts d on d.id = o.draft_id
    join public.messages m on m.id = d.source_message_id and m.direction = 'inbound'
    where o.status = 'sent' and o.sent_at < ${to}
      and d.kind in ('reply', 'quote', 'document')
    group by m.id, m.received_at
    having min(o.sent_at) >= ${from}
    order by 2`;
  const [f] = await tx<{ followups: number; won_back: number }[]>`
    select
      (select count(*)::int from public.outbound_emails o
       join public.drafts d on d.id = o.draft_id
       where o.status = 'sent' and d.kind = 'followup'
         and o.sent_at >= ${from} and o.sent_at < ${to}) as followups,
      (select count(distinct m.thread_id)::int from public.messages m
       where m.direction = 'inbound' and m.received_at >= ${from} and m.received_at < ${to}
         and (select d.kind from public.outbound_emails o
              join public.drafts d on d.id = o.draft_id
              where o.thread_id = m.thread_id and o.status = 'sent' and o.sent_at < m.received_at
              order by o.sent_at desc limit 1) = 'followup') as won_back`;
  const money = (rows: { currency: string; n: number; total: string | number }[]): MoneyTotal[] =>
    rows
      .filter((r) => r.n > 0)
      .map((r) => ({ currency: r.currency, count: r.n, totalCents: Number(r.total) }));
  const quotes = await tx<
    { currency: string; sent: number; sent_total: string; acc: number; acc_total: string }[]
  >`
    select currency,
           count(*) filter (where sent_at >= ${from} and sent_at < ${to})::int as sent,
           coalesce(sum(total_cents) filter (where sent_at >= ${from} and sent_at < ${to}), 0) as sent_total,
           count(*) filter (where accepted_at >= ${from} and accepted_at < ${to})::int as acc,
           coalesce(sum(total_cents) filter (where accepted_at >= ${from} and accepted_at < ${to}), 0) as acc_total
    from public.quotes
    where (sent_at >= ${from} and sent_at < ${to}) or (accepted_at >= ${from} and accepted_at < ${to})
    group by currency order by currency`;
  const paid = await tx<{ currency: string; n: number; total: string }[]>`
    select currency, count(*)::int as n, sum(total_cents) as total
    from public.documents
    where payable and status = 'paid' and paid_at >= ${from} and paid_at < ${to}
    group by currency order by currency`;
  return {
    replies: replies.map((r) => ({ receivedAt: r.received_at, sentAt: r.sent_at })),
    followupsSent: f!.followups,
    wonBack: f!.won_back,
    quotesSent: money(
      quotes.map((q) => ({ currency: q.currency, n: q.sent, total: q.sent_total })),
    ),
    quotesAccepted: money(
      quotes.map((q) => ({ currency: q.currency, n: q.acc, total: q.acc_total })),
    ),
    invoicesPaid: money(paid),
  };
}
