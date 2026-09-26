import { withTenant } from '@noctiv/db';
import type { Sql } from 'postgres';

const ADMIN_AFTER_MS = 30 * 60_000;
const OWNER_AFTER_MS = 4 * 60 * 60_000;

/**
 * Founder decision D5 (2026-09-26): customer e-mails waiting on the AI
 * provider's daily quota. After 30 minutes the admin is told; the owner sees
 * "Replies are delayed" in the app (GET /nav) and gets an e-mail only after
 * 4 hours. At most one of each per tenant and day; no customer data.
 */
export async function scanQuotaWaits(sql: Sql, now = new Date()): Promise<number> {
  const rows = await sql<{ tenant_id: string; since: Date; waiting: number }[]>`
    select tenant_id, since, waiting from app.quota_waits()`;
  const day = now.toISOString().slice(0, 10);
  let queued = 0;
  for (const r of rows) {
    const waitedMs = now.getTime() - r.since.getTime();
    if (waitedMs < ADMIN_AFTER_MS) continue;
    const payload = { since: r.since.toISOString(), waiting: r.waiting };
    await withTenant(sql, r.tenant_id, async (tx) => {
      const a = await tx`
        insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
        values (${r.tenant_id}, 'email_admin', 'quota_wait', ${`quota_wait:${day}`}, ${tx.json(payload)})
        on conflict (tenant_id, dedupe_key) do nothing returning id`;
      queued += a.length;
      if (waitedMs < OWNER_AFTER_MS) return;
      const o = await tx`
        insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
        values (${r.tenant_id}, 'email_owner', 'replies_delayed', ${`replies_delayed:${day}`},
                ${tx.json({ waiting: r.waiting })})
        on conflict (tenant_id, dedupe_key) do nothing returning id`;
      queued += o.length;
    });
  }
  return queued;
}
