import { enqueue, withTenant, type Job } from '@noctiv/db';
import { connectImap, MailConnectError, openMailboxPassword, verifySmtp } from '@noctiv/mail';
import type { Sql } from 'postgres';
import { DISCONNECT_CODES, loadConnection, markDisconnected } from '../mailbox/connection-repo.ts';
import { QUEUES } from '../queues.ts';

/** Consecutive failed checks (not login failures) before the admin is alerted. */
export const UNHEALTHY_AFTER = 3;

/** health.check (hourly): one job per connected mailbox. */
export async function scanHealthChecks(sql: Sql): Promise<number> {
  const rows = await sql<{ tenant_id: string; connection_id: string }[]>`
    select tenant_id, connection_id from app.list_mail_connections(array['connected'])`;
  let queued = 0;
  for (const r of rows) {
    const id = await withTenant(sql, r.tenant_id, (tx) =>
      enqueue(tx, {
        tenantId: r.tenant_id,
        queue: QUEUES.healthCheck,
        payload: { connectionId: r.connection_id },
        singletonKey: `health:${r.connection_id}`,
        maxAttempts: 1,
      }),
    );
    if (id) queued++;
  }
  return queued;
}

export interface HealthDeps {
  sql: Sql;
  keys: { publicKey: string; privateKey: string };
  allowInsecure: boolean;
}

/**
 * PLAN.md §4.7 health.check: IMAP login + NOOP and SMTP authentication (the
 * IDLE listener only ever proves IMAP). Every check is recorded. A rejected
 * login disconnects the mailbox (owner + admin notified); other failures
 * alert the admin once they repeat, without stopping the mailbox.
 */
export function healthCheckHandler(deps: HealthDeps) {
  return async (job: Job) => {
    const tenantId = job.tenantId;
    const connectionId = String(job.payload.connectionId);
    const conn = await withTenant(deps.sql, tenantId, (tx) => loadConnection(tx, connectionId));
    if (!conn || conn.status !== 'connected') return { skipped: 'not_connected' };
    const password = openMailboxPassword(conn.ciphertext, deps.keys, tenantId, conn.id);
    const opts = { allowInsecure: deps.allowInsecure, timeoutMs: 20_000 };
    const started = Date.now();

    let imapOk = false;
    let smtpOk = false;
    let code: string | null = null;
    try {
      const client = await connectImap(conn.settings, password, opts);
      try {
        await client.noop();
        imapOk = true;
      } finally {
        await client.logout().catch(() => client.close());
      }
      await verifySmtp(conn.settings, password, opts);
      smtpOk = true;
    } catch (e) {
      code = e instanceof MailConnectError ? e.code : 'UNKNOWN';
    }
    const latency = Date.now() - started;

    return withTenant(deps.sql, tenantId, async (tx) => {
      await tx`insert into public.connection_health_checks (tenant_id, connection_id, imap_ok, smtp_ok, error_code, latency_ms)
               values (${tenantId}, ${connectionId}, ${imapOk}, ${smtpOk}, ${code}, ${latency})`;
      if (!code) {
        await tx`update public.email_connections
                 set last_checked_at = now(), last_ok_at = now(), last_error_code = null, last_error_detail = null
                 where id = ${connectionId} and status = 'connected'`;
        return { ok: true, latencyMs: latency };
      }
      if (DISCONNECT_CODES.has(code)) {
        await markDisconnected(tx, tenantId, connectionId, code);
        return { ok: false, code, disconnected: true };
      }
      await tx`update public.email_connections set last_checked_at = now(), last_error_code = ${code}
               where id = ${connectionId}`;
      const recent = await tx<{ ok: boolean }[]>`
        select (imap_ok and smtp_ok) as ok from public.connection_health_checks
        where connection_id = ${connectionId} order by checked_at desc limit ${UNHEALTHY_AFTER}`;
      if (recent.length === UNHEALTHY_AFTER && recent.every((r) => !r.ok)) {
        const day = new Date().toISOString().slice(0, 10);
        await tx`
          insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
          values (${tenantId}, 'email_admin', 'mailbox_unhealthy', ${`unhealthy:${connectionId}:${day}`},
                  ${tx.json({ connectionId, code, failedChecks: UNHEALTHY_AFTER })})
          on conflict (tenant_id, dedupe_key) do nothing`;
      }
      return { ok: false, code };
    });
  };
}
