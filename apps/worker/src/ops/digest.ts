import type { Logger } from '@noctiv/core';
import type { Transporter } from 'nodemailer';
import type { Sql } from 'postgres';

export const DIGEST_TIME_ZONE = 'Europe/Riga';
export const DIGEST_HOUR = 8;

/** The admin digest numbers (app.admin_digest_stats). */
export interface DigestStats {
  tenants: Record<
    'active' | 'new' | 'onboarded' | 'trial' | 'paying' | 'past_due' | 'canceled' | 'comped',
    number
  >;
  emails: Record<
    'processed' | 'drafted' | 'auto_sent' | 'escalated' | 'skipped' | 'failed' | 'still_queued',
    number
  >;
  sent: Record<'auto' | 'approved' | 'failed', number>;
  escalations: Record<'new' | 'open', number>;
  quota: Record<'alerts' | 'waiting_now', number>;
  jobs: { dead: Record<string, number>; backlog: number };
  mailboxes: Record<'connected' | 'disconnected' | 'disconnects' | 'unhealthy_alerts', number>;
  usage: {
    day: string;
    llm_calls: number;
    tokens_in: number;
    tokens_out: number;
    embed_tokens: number;
    est_cost_micro_eur: number;
    halted_tenants: number;
  };
  waitlist: Record<'new' | 'confirmed' | 'total_confirmed', number>;
  top_tenants: { name: string; processed: number; auto_sent: number; escalated: number }[];
}

/** Calendar date and hour of an instant in a time zone. */
export function zonedParts(at: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute) };
}

/** The instant of a local wall-clock time (date "YYYY-MM-DD", hour) in a time zone. */
export function zonedInstant(date: string, hour: number, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const wall = Date.UTC(y!, m! - 1, d!, hour);
  let t = wall;
  // Two passes settle the zone offset, including across a DST change.
  for (let i = 0; i < 2; i++) {
    const z = zonedParts(new Date(t), timeZone);
    const [zy, zm, zd] = z.date.split('-').map(Number);
    const seen = Date.UTC(zy!, zm! - 1, zd!, z.hour, z.minute);
    t += wall - seen;
  }
  return new Date(t);
}

const n = (v: number) => new Intl.NumberFormat('en-GB').format(Number(v) || 0);

/** Plain-text digest; every line is a count, no customer content. */
export function digestText(s: DigestStats, day: string, health: HealthLine): string {
  const dead = Object.entries(s.jobs.dead);
  const lines = [
    `Noctiv daily digest — the 24 hours to 08:00 Riga on ${day}`,
    '',
    'ACCOUNTS',
    `  Active: ${n(s.tenants.active)} (new: ${n(s.tenants.new)}, set up: ${n(s.tenants.onboarded)})`,
    `  Trial: ${n(s.tenants.trial)} · paying: ${n(s.tenants.paying)} · past due: ${n(s.tenants.past_due)} · canceled/paused: ${n(s.tenants.canceled)} · comped: ${n(s.tenants.comped)}`,
    '',
    'E-MAILS',
    `  Processed: ${n(s.emails.processed)} (drafts: ${n(s.emails.drafted)}, auto-sent: ${n(s.emails.auto_sent)}, escalated: ${n(s.emails.escalated)}, ignored: ${n(s.emails.skipped)}, failed: ${n(s.emails.failed)})`,
    `  Still waiting to be processed: ${n(s.emails.still_queued)}`,
    `  Sent: ${n(s.sent.auto)} automatically, ${n(s.sent.approved)} after approval; failed sends: ${n(s.sent.failed)}`,
    `  Escalations: ${n(s.escalations.new)} new, ${n(s.escalations.open)} open in total`,
    '',
    'AI (GEMINI)',
    `  UTC day ${s.usage.day}: ${n(s.usage.llm_calls)} calls, ${n(s.usage.tokens_in)} tokens in, ${n(s.usage.tokens_out)} out, ${n(s.usage.embed_tokens)} embedding tokens, est. €${(Number(s.usage.est_cost_micro_eur) / 1e6).toFixed(2)}`,
    `  Quota waits: ${n(s.quota.alerts)} alert(s); e-mails waiting now: ${n(s.quota.waiting_now)} · accounts at budget limit: ${n(s.usage.halted_tenants)}`,
    '',
    'SYSTEM',
    `  Failed jobs: ${dead.length ? dead.map(([q, c]) => `${q} ${n(c)}`).join(', ') : 'none'} · overdue queued jobs: ${n(s.jobs.backlog)}`,
    `  Mailboxes: ${n(s.mailboxes.connected)} connected, ${n(s.mailboxes.disconnected)} not connected; disconnects: ${n(s.mailboxes.disconnects)}; repeated check failures: ${n(s.mailboxes.unhealthy_alerts)}`,
    `  Worker heartbeat: ${health.heartbeat} · mailboxes not checked for 60 min: ${n(health.unchecked)}`,
    '',
    'WAITLIST',
    `  Sign-ups: ${n(s.waitlist.new)} new, ${n(s.waitlist.confirmed)} confirmed; ${n(s.waitlist.total_confirmed)} confirmed in total`,
  ];
  if (s.top_tenants.length) {
    lines.push('', 'BUSIEST ACCOUNTS (processed / auto-sent / escalated)');
    for (const t of s.top_tenants)
      lines.push(
        `  ${t.name.replace(/[\r\n]+/g, ' ').slice(0, 60)}: ${n(t.processed)} / ${n(t.auto_sent)} / ${n(t.escalated)}`,
      );
  }
  lines.push('', 'Noctiv admin digest, sent daily at 08:00 Riga.');
  return lines.join('\n');
}

export interface HealthLine {
  heartbeat: string;
  unchecked: number;
}

export interface DigestDeps {
  sql: Sql;
  transport: Pick<Transporter, 'sendMail'>;
  from: string;
  to: string;
  logger?: Logger;
}

/**
 * The admin daily digest (PLAN.md §25): from 08:00 Riga, once per Riga day.
 * Called every minute; app.admin_digest_claim makes sure only one worker
 * sends it and a failed send is retried.
 */
export async function maybeSendDigest(deps: DigestDeps, now = new Date()): Promise<boolean> {
  const local = zonedParts(now, DIGEST_TIME_ZONE);
  if (local.hour < DIGEST_HOUR) return false;
  const [claim] = await deps.sql<{ claimed: boolean | null }[]>`
    select app.admin_digest_claim(${local.date}::date) as claimed`;
  if (!claim?.claimed) return false;

  const to = zonedInstant(local.date, DIGEST_HOUR, DIGEST_TIME_ZONE);
  const from = new Date(to.getTime() - 24 * 3600_000);
  const usageDay = new Date(to.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
  const [row] = await deps.sql<{ stats: DigestStats }[]>`
    select app.admin_digest_stats(${from}, ${to}, ${usageDay}::date) as stats`;
  const [h] = await deps.sql<{ last_beat: Date | null; unchecked: number }[]>`
    select last_beat, unchecked from app.worker_health(interval '60 minutes')`;
  const beatAge = h?.last_beat ? Math.round((now.getTime() - h.last_beat.getTime()) / 1000) : null;
  const text = digestText(row!.stats, local.date, {
    heartbeat: beatAge === null ? 'none' : `${beatAge} s ago`,
    unchecked: h?.unchecked ?? 0,
  });
  await deps.transport.sendMail({
    from: deps.from,
    to: deps.to,
    subject: `[admin] Noctiv daily digest ${local.date}`,
    text,
    headers: { 'Auto-Submitted': 'auto-generated' },
  });
  await deps.sql`select app.admin_digest_sent(${local.date}::date)`;
  deps.logger?.info({ day: local.date }, 'admin digest sent');
  return true;
}
