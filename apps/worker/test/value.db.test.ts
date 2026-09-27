import { randomUUID } from 'node:crypto';
import { loadValueRows, withTenant } from '@noctiv/db';
import { seedTenant, type SeededTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { EmailChannel } from '../src/notify/email-channel.ts';
import { renderNotificationEmail } from '../src/notify/templates.ts';
import { scanWeeklyReports } from '../src/ops/weekly-report.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

/** Monday 5 October 2026, 08:30 in Riga. */
const MONDAY = new Date('2026-10-05T05:30:00Z');

async function thread(t: SeededTenant) {
  const [th] = await owner<{ id: string }[]>`
    insert into public.threads (tenant_id, connection_id, subject)
    values (${t.tenantId}, ${t.connectionId}, 'Order') returning id`;
  return th!.id;
}
async function inbound(t: SeededTenant, threadId: string, at: string) {
  const [m] = await owner<{ id: string }[]>`
    insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header,
                                 from_address, received_at)
    values (${t.tenantId}, ${t.connectionId}, ${threadId}, 'inbound', ${`<${randomUUID()}@c.test>`},
            'anna@customer.test', ${at}) returning id`;
  return m!.id;
}
async function sent(
  t: SeededTenant,
  threadId: string,
  kind: string,
  at: string,
  sourceMessageId: string | null = null,
) {
  const [d] = await owner<{ id: string }[]>`
    insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, status)
    values (${t.tenantId}, ${threadId}, ${sourceMessageId}, ${kind}, 'anna@customer.test', 'Re: Order', 'Hi', 'sent')
    returning id`;
  await owner`
    insert into public.outbound_emails (tenant_id, draft_id, thread_id, message_id_header, to_address, subject,
                                        sent_via, status, sent_at)
    values (${t.tenantId}, ${d!.id}, ${threadId}, ${`<${randomUUID()}@shop.test>`}, 'anna@customer.test',
            'Re: Order', 'auto', 'sent', ${at})`;
}

let T: SeededTenant;
beforeAll(async () => {
  T = await seedTenant(owner, 'value', { embeddingAxis: 191 });
  await owner`update public.tenants set onboarding_completed_at = now(), timezone = 'Europe/Riga',
                trial_ends_at = '2026-12-31', billing_status = 'trial'
              where id = ${T.tenantId}`;
  // Tuesday 29 Sept, 23:11:19 Riga: answered in 41 seconds.
  const t1 = await thread(T);
  const m1 = await inbound(T, t1, '2026-09-29T20:11:19Z');
  await sent(T, t1, 'reply', '2026-09-29T20:12:00Z', m1);
  await sent(T, t1, 'reply', '2026-09-29T21:00:00Z', m1); // a second reply: not counted twice
  // Thursday 1 Oct, 10:00 Riga: answered in 3 minutes.
  const m2 = await inbound(T, t1, '2026-10-01T07:00:00Z');
  await sent(T, t1, 'reply', '2026-10-01T07:03:00Z', m2);
  // A follow-up on Friday; the customer answers two hours later (won back).
  const t2 = await thread(T);
  await sent(T, t2, 'followup', '2026-10-02T08:00:00Z');
  const m3 = await inbound(T, t2, '2026-10-02T10:00:00Z');
  await sent(T, t2, 'acknowledgement', '2026-10-02T10:01:00Z', m3); // not an answer
  // August: outside every period.
  const old = await inbound(T, t1, '2026-08-10T07:00:00Z');
  await sent(T, t1, 'reply', '2026-08-10T07:05:00Z', old);
  await owner`
    insert into public.quotes (tenant_id, number, thread_id, status, customer_email, currency, vat_mode, vat_rate,
                               subtotal_cents, vat_cents, total_cents, valid_until, sent_at, accepted_at)
    values (${T.tenantId}, 'Q-2026-0001', ${t1}, 'accepted', 'anna@customer.test', 'EUR', 'none', 0,
            12000, 0, 12000, '2026-10-30', '2026-09-30T09:00:00Z', '2026-10-01T09:00:00Z')`;
  await owner`
    insert into public.documents (tenant_id, type, status, currency, vat_mode, vat_rate, total_cents,
                                  payable, paid_at, number)
    values (${T.tenantId}, 'invoice', 'paid', 'EUR', 'none', 0, 9900, true, '2026-10-02T12:00:00Z',
            'INV-2026-0001')`;
});

describe('value report rows (PLAN.md §26)', () => {
  it('counts first replies, follow-ups, won-back conversations, quotes and paid invoices', async () => {
    const week = await withTenant(worker, T.tenantId, (tx) =>
      loadValueRows(tx, new Date('2026-09-27T21:00:00Z'), new Date('2026-10-04T21:00:00Z')),
    );
    expect(week.replies.map((r) => (r.sentAt.getTime() - r.receivedAt.getTime()) / 1000)).toEqual([
      41, 180,
    ]);
    expect(week).toMatchObject({
      followupsSent: 1,
      wonBack: 1,
      quotesSent: [{ currency: 'EUR', count: 1, totalCents: 12000 }],
      quotesAccepted: [{ currency: 'EUR', count: 1, totalCents: 12000 }],
      invoicesPaid: [{ currency: 'EUR', count: 1, totalCents: 9900 }],
    });
  });
});

describe('Monday summary e-mail', () => {
  it('is queued from Monday 08:00 local time, once, with the week and the month so far', async () => {
    expect(await scanWeeklyReports(worker, new Date('2026-10-05T04:59:00Z'), [T.tenantId])).toBe(0); // 07:59 Riga
    expect(await scanWeeklyReports(worker, MONDAY, [T.tenantId])).toBe(1);
    expect(await scanWeeklyReports(worker, new Date('2026-10-06T09:00:00Z'), [T.tenantId])).toBe(0);
    const [n] = await owner<{ id: string; kind: string; payload: Record<string, unknown> }[]>`
      select id, kind, payload from public.notifications
      where tenant_id = ${T.tenantId} and kind = 'weekly_report'`;
    expect(n!.payload).toMatchObject({
      weekLabel: '28 September – 4 October 2026',
      monthLabel: 'October',
      highlight: 'Fastest reply: 41 seconds at 23:12 on Tuesday',
      week: { answered: 2, followupsSent: 1, wonBack: 1, minutesSaved: 2 * 4 + 1 * 3 },
      month: { answered: 1, followupsSent: 1, wonBack: 1 },
    });

    const unsubscribe = `https://app.noctiv.test/api/reports/weekly/unsubscribe/${T.tenantId}/x`;
    const email = renderNotificationEmail({
      id: n!.id,
      tenantId: T.tenantId,
      tenantName: 'Nordlicht',
      audience: 'owner',
      kind: 'weekly_report',
      payload: n!.payload,
      links: { dashboard: 'https://app.noctiv.test/', unsubscribe },
    });
    expect(email.subject).toBe('Your Noctiv week: 2 e-mails answered');
    for (const line of [
      'REPLIES',
      '  E-mails answered: 2',
      '  Replies won back: 1 (customers who answered after a follow-up)',
      '  Quotes accepted: 1 (€120.00)',
      '  Invoices paid: 1 (€99.00)',
      'OCTOBER SO FAR',
      'Fastest reply: 41 seconds at 23:12 on Tuesday.',
      `Unsubscribe from this e-mail: ${unsubscribe}`,
    ])
      expect(email.text).toContain(line);
    // Every section has at most three lines.
    const sections = email.text.split('\n\n').filter((b) => /^[A-Z ]+\n/.test(b));
    for (const s of sections) expect(s.split('\n').length - 1).toBeLessThanOrEqual(3);

    // One-click unsubscribe header (RFC 8058).
    const mails: { headers: Record<string, string> }[] = [];
    await new EmailChannel({
      transport: { sendMail: async (m: never) => void mails.push(m) } as never,
      from: 'Noctiv <notify@noctiv.test>',
    }).deliver(
      {
        id: n!.id,
        tenantId: T.tenantId,
        tenantName: 'Nordlicht',
        audience: 'owner',
        kind: 'weekly_report',
        payload: n!.payload,
        links: { dashboard: 'https://app.noctiv.test/', unsubscribe },
      },
      ['owner@shop.test'],
    );
    expect(mails[0]!.headers['List-Unsubscribe']).toBe(`<${unsubscribe}>`);
    expect(mails[0]!.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('a quiet week sends nothing; an unsubscribed business gets nothing', async () => {
    const quiet = await seedTenant(owner, 'value-quiet', { embeddingAxis: 192 });
    await owner`update public.tenants set onboarding_completed_at = now(), trial_ends_at = '2026-12-31'
                where id = ${quiet.tenantId}`;
    expect(await scanWeeklyReports(worker, MONDAY, [quiet.tenantId])).toBe(0);
    const [q] = await owner<{ last_week: string }[]>`
      select weekly_report_last_week::text as last_week from public.tenants where id = ${quiet.tenantId}`;
    expect(q!.last_week).toBe('2026-09-28');

    await owner`update public.tenants set weekly_report_enabled = false, weekly_report_last_week = null
                where id = ${T.tenantId}`;
    await owner`delete from public.notifications where tenant_id = ${T.tenantId} and kind = 'weekly_report'`;
    expect(await scanWeeklyReports(worker, MONDAY, [T.tenantId])).toBe(0);
  });
});
