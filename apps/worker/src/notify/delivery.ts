import {
  signActionToken,
  type Logger,
  type Notification,
  type NotificationChannel,
} from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import type { Sql, TransactionSql } from 'postgres';
import { PermanentDeliveryError } from './email-channel.ts';

export interface DeliveryDeps {
  sql: Sql;
  /** notifications.channel value → channel implementation and audience. */
  routes: Partial<
    Record<
      'email_owner' | 'email_admin',
      { channel: NotificationChannel; audience: 'owner' | 'admin' }
    >
  >;
  adminEmail?: string;
  links: {
    /** Public base URL of the API (Approve / Reject links). */
    apiUrl: string;
    /** Public base URL of the dashboard. */
    appUrl: string;
    /** Without a secret, draft emails carry only the dashboard link. */
    actionSecret?: string;
  };
  logger?: Logger;
  maxAttempts?: number;
  batchPerTenant?: number;
}

export interface DeliveryResult {
  sent: number;
  retrying: number;
  failed: number;
}

/** 1 min, 2 min, 4 min … capped at one hour. */
export const notificationBackoffMs = (attempts: number) =>
  Math.min(60_000 * 2 ** Math.max(attempts - 1, 0), 3_600_000);

/**
 * Delivers pending notifications, tenant by tenant inside each tenant's RLS
 * context. Rows are locked (SKIP LOCKED) so parallel workers never send the
 * same notification; failures retry with backoff and end as 'failed'.
 */
export async function deliverNotifications(deps: DeliveryDeps): Promise<DeliveryResult> {
  const result: DeliveryResult = { sent: 0, retrying: 0, failed: 0 };
  const tenants = await deps.sql<{ tenant_id: string }[]>`
    select tenant_id from app.tenants_with_pending_notifications(100)`;
  for (const { tenant_id: tenantId } of tenants) {
    await withTenant(deps.sql, tenantId, (tx) => deliverForTenant(deps, tx, tenantId, result));
  }
  return result;
}

async function deliverForTenant(
  deps: DeliveryDeps,
  tx: TransactionSql,
  tenantId: string,
  result: DeliveryResult,
): Promise<void> {
  const rows = await tx<
    {
      id: string;
      channel: 'email_owner' | 'email_admin';
      kind: string;
      payload: Record<string, unknown>;
      attempts: number;
    }[]
  >`
    select id, channel, kind, payload, attempts from public.notifications
    where status = 'pending' and next_attempt_at <= now()
    order by created_at
    limit ${deps.batchPerTenant ?? 20}
    for update skip locked`;
  if (rows.length === 0) return;
  const [tenant] = await tx<
    { name: string }[]
  >`select name from public.tenants where id = ${tenantId}`;
  let owners: string[] | undefined;

  for (const row of rows) {
    const route = deps.routes[row.channel];
    if (!route) continue; // No channel configured: stays pending.
    let recipients: string[];
    if (route.audience === 'owner') {
      owners ??= (
        await tx<{ email: string }[]>`select email from app.tenant_owner_emails(${tenantId})`
      ).map((r) => r.email);
      recipients = owners;
    } else {
      recipients = deps.adminEmail ? [deps.adminEmail] : [];
    }
    const n: Notification = {
      id: row.id,
      tenantId,
      tenantName: tenant?.name ?? 'your account',
      audience: route.audience,
      kind: row.kind,
      payload: row.payload,
      links: links(deps.links, tenantId, row.kind, row.payload),
      facts: await facts(tx, row.kind, row.payload),
    };
    const attempts = row.attempts + 1;
    try {
      await route.channel.deliver(n, recipients);
      await tx`update public.notifications set status = 'sent', sent_at = now(), attempts = ${attempts}, error = null
               where id = ${row.id}`;
      result.sent++;
    } catch (e) {
      const permanent = e instanceof PermanentDeliveryError;
      const code = errorCode(e);
      const failed = permanent || attempts >= (deps.maxAttempts ?? 5);
      await tx`
        update public.notifications
        set attempts = ${attempts}, error = ${code},
            status = ${failed ? 'failed' : 'pending'},
            next_attempt_at = ${new Date(Date.now() + notificationBackoffMs(attempts))}
        where id = ${row.id}`;
      if (failed) result.failed++;
      else result.retrying++;
      deps.logger?.warn(
        { tenantId, notificationId: row.id, kind: row.kind, code, failed },
        'notification delivery failed',
      );
    }
  }
}

function links(
  cfg: DeliveryDeps['links'],
  tenantId: string,
  kind: string,
  p: Record<string, unknown>,
): Notification['links'] {
  const app = cfg.appUrl.replace(/\/+$/, '');
  const api = cfg.apiUrl.replace(/\/+$/, '');
  const draftId = typeof p.draftId === 'string' ? p.draftId : undefined;
  const escalationId = typeof p.escalationId === 'string' ? p.escalationId : undefined;
  switch (kind) {
    case 'draft_ready': {
      const dashboard = draftId ? `${app}/drafts/${draftId}` : `${app}/drafts`;
      if (!draftId || !cfg.actionSecret) return { dashboard };
      const sign = (action: 'approve' | 'reject') =>
        `${api}/actions/${signActionToken({ tenantId, draftId, action }, cfg.actionSecret!)}`;
      return { dashboard, approve: sign('approve'), reject: sign('reject') };
    }
    case 'escalation':
      return {
        dashboard: escalationId ? `${app}/escalations/${escalationId}` : `${app}/escalations`,
      };
    case 'send_failed':
      return { dashboard: draftId ? `${app}/drafts/${draftId}` : `${app}/drafts` };
    case 'mailbox_disconnected':
      return { dashboard: `${app}/settings/mailboxes` };
    case 'quote_accepted':
    case 'quote_needs_you':
      return {
        dashboard:
          typeof p.threadId === 'string' ? `${app}/conversations/${p.threadId}` : `${app}/quotes`,
      };
    default:
      return { dashboard: `${app}/` };
  }
}

async function facts(
  tx: TransactionSql,
  kind: string,
  p: Record<string, unknown>,
): Promise<Record<string, string> | undefined> {
  if (kind !== 'mailbox_disconnected' || typeof p.connectionId !== 'string') return undefined;
  const [c] = await tx<{ email_address: string }[]>`
    select email_address from public.email_connections where id = ${p.connectionId}`;
  return c ? { mailbox: c.email_address } : undefined;
}

/** Short, address-free error code for the notifications row. */
function errorCode(e: unknown): string {
  if (e instanceof PermanentDeliveryError) return e.message;
  const x = e as { code?: unknown; responseCode?: unknown };
  const parts = [x?.code, x?.responseCode].filter(
    (v) => typeof v === 'string' || typeof v === 'number',
  );
  return parts.length ? parts.join(' ').slice(0, 100) : 'delivery_error';
}
