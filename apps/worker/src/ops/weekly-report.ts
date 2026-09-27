import {
  computeValue,
  fastestLine,
  isEmptyValue,
  localDate,
  localMonthStart,
  localWeekStart,
  type ValueReport,
} from '@noctiv/core';
import { loadValueRows, withTenant } from '@noctiv/db';
import type { Sql } from 'postgres';

/** Local hour on Monday from which the summary goes out. */
export const WEEKLY_REPORT_HOUR = 8;

const day = (d: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) =>
  d.toLocaleDateString('en-GB', { timeZone, ...opts });

/** "22–28 September 2026" / "29 September – 5 October 2026" for [start, end). */
export function weekLabel(start: Date, end: Date, timeZone: string): string {
  const last = new Date(end.getTime() - 1);
  const sameMonth =
    day(start, timeZone, { month: 'long' }) === day(last, timeZone, { month: 'long' });
  return sameMonth
    ? `${day(start, timeZone, { day: 'numeric' })}–${day(last, timeZone, { day: 'numeric', month: 'long', year: 'numeric' })}`
    : `${day(start, timeZone, { day: 'numeric', month: 'long' })} – ${day(last, timeZone, { day: 'numeric', month: 'long', year: 'numeric' })}`;
}

const numbers = (v: ValueReport) => {
  const { fastest: _f, ...rest } = v;
  return rest;
};

/**
 * The Monday summary (PLAN.md §26): from Monday 08:00 local time, once per
 * week and business, the numbers of the past Monday–Sunday and the month so
 * far (the month the week ended in). Nothing is sent for a week without any
 * activity. Called every 10 minutes; a missed Monday is sent later that week.
 */
export async function scanWeeklyReports(
  sql: Sql,
  now = new Date(),
  /** Tests: only these businesses. */
  only?: string[],
): Promise<number> {
  const all = await sql<{ tenant_id: string; timezone: string; last_week: string | null }[]>`
    select tenant_id, timezone, last_week::text as last_week from app.weekly_report_tenants()`;
  const rows = only ? all.filter((r) => only.includes(r.tenant_id)) : all;
  let queued = 0;
  for (const t of rows) {
    const tz = t.timezone;
    const thisMonday = localWeekStart(now, tz);
    if (now.getTime() < thisMonday.getTime() + WEEKLY_REPORT_HOUR * 3600_000) continue;
    const weekStart = localWeekStart(new Date(thisMonday.getTime() - 1), tz);
    const weekKey = localDate(weekStart, tz);
    if (t.last_week && t.last_week >= weekKey) continue;
    const sent = await withTenant(sql, t.tenant_id, async (tx) => {
      const [s] = await tx<{ reply: number; followup: number }[]>`
        select value_minutes_per_reply as reply, value_minutes_per_followup as followup
        from public.tenants where id = ${t.tenant_id}`;
      const assumptions = { minutesPerReply: s!.reply, minutesPerFollowup: s!.followup };
      const week = computeValue(await loadValueRows(tx, weekStart, thisMonday), {
        timeZone: tz,
        assumptions,
      });
      const monthStart = localMonthStart(new Date(thisMonday.getTime() - 1), tz);
      const month = computeValue(await loadValueRows(tx, monthStart, thisMonday), {
        timeZone: tz,
        assumptions,
      });
      await tx`update public.tenants set weekly_report_last_week = ${weekKey}::date
               where id = ${t.tenant_id}`;
      if (isEmptyValue(week)) return false;
      const r = await tx`
        insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
        values (${t.tenant_id}, 'email_owner', 'weekly_report', ${`weekly_report:${weekKey}`},
                ${tx.json({
                  weekLabel: weekLabel(weekStart, thisMonday, tz),
                  monthLabel: day(monthStart, tz, { month: 'long' }),
                  week: numbers(week),
                  month: numbers(month),
                  highlight: week.fastest ? fastestLine(week.fastest, tz) : null,
                } as never)})
        on conflict (tenant_id, dedupe_key) do nothing returning id`;
      return r.length > 0;
    });
    if (sent) queued++;
  }
  return queued;
}
