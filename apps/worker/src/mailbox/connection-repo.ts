import { utcDay } from '@noctiv/core';
import type { MailServerSettings } from '@noctiv/mail';
import type { TransactionSql } from 'postgres';

export interface StoredConnection {
  id: string;
  tenantId: string;
  settings: MailServerSettings;
  ciphertext: Buffer;
  status: string;
  isTestMailbox: boolean;
  uidValidity: string | null;
  lastUid: number | null;
  /** When the mailbox was connected: mail that arrived earlier is never processed. */
  connectedAt: Date;
}

// Runs inside withTenant(); RLS scopes every query to the tenant.

export async function loadConnection(
  tx: TransactionSql,
  connectionId: string,
): Promise<StoredConnection | undefined> {
  const [r] = await tx<
    {
      id: string;
      tenant_id: string;
      provider: MailServerSettings['provider'];
      email_address: string;
      username: string;
      imap_host: string;
      imap_port: number;
      imap_secure: boolean;
      smtp_host: string;
      smtp_port: number;
      smtp_security: 'tls' | 'starttls';
      credentials_ciphertext: Buffer;
      status: string;
      is_test_mailbox: boolean;
      inbox_uidvalidity: string | null;
      inbox_last_uid: string | null;
      created_at: Date;
    }[]
  >`select id, tenant_id, provider, email_address, username, imap_host, imap_port, imap_secure, smtp_host, smtp_port,
           smtp_security, credentials_ciphertext, status, is_test_mailbox, inbox_uidvalidity::text, inbox_last_uid::text, created_at
    from public.email_connections where id = ${connectionId}`;
  if (!r) return undefined;
  return {
    id: r.id,
    tenantId: r.tenant_id,
    settings: {
      provider: r.provider,
      emailAddress: r.email_address,
      username: r.username,
      imap: { host: r.imap_host, port: r.imap_port, secure: r.imap_secure },
      smtp: { host: r.smtp_host, port: r.smtp_port, security: r.smtp_security },
    },
    ciphertext: r.credentials_ciphertext,
    status: r.status,
    isTestMailbox: r.is_test_mailbox,
    uidValidity: r.inbox_uidvalidity,
    lastUid: r.inbox_last_uid === null ? null : Number(r.inbox_last_uid),
    connectedAt: r.created_at,
  };
}

export async function saveInboxState(
  tx: TransactionSql,
  connectionId: string,
  uidValidity: string,
  lastUid: number,
): Promise<void> {
  // Never move backwards (a slower concurrent fetch cannot rewind the position).
  await tx`
    update public.email_connections
    set inbox_uidvalidity = ${uidValidity},
        inbox_last_uid = case when inbox_uidvalidity::text = ${uidValidity} then greatest(coalesce(inbox_last_uid, 0), ${lastUid}) else ${lastUid} end,
        last_checked_at = now(), last_ok_at = now()
    where id = ${connectionId}`;
}

/** Codes that mean the saved password no longer works: stop and ask the owner to reconnect. */
export const DISCONNECT_CODES = new Set([
  'AUTH_FAILED',
  'APP_PASSWORD_REQUIRED',
  'IMAP_DISABLED',
  'BASIC_AUTH_DISABLED',
  'SMTP_AUTH_FAILED',
]);

/**
 * Brief: on auth failure mark the connection disconnected and notify the
 * owner (Telegram + email, with a reconnect link) and the admin. One set of
 * notifications per connection per day.
 */
export async function markDisconnected(
  tx: TransactionSql,
  tenantId: string,
  connectionId: string,
  code: string,
  now = new Date(),
) {
  const rows = await tx`
    update public.email_connections
    set status = 'disconnected', last_error_code = ${code}, last_checked_at = now()
    where id = ${connectionId} and status <> 'disconnected'
    returning id`;
  if (rows.length === 0) return false;
  const payload = { connectionId, code };
  const day = utcDay(now);
  for (const channel of ['telegram_owner', 'email_owner', 'telegram_admin'] as const) {
    await tx`
      insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
      values (${tenantId}, ${channel}, 'mailbox_disconnected', ${`disconnected:${connectionId}:${day}:${channel}`}, ${tx.json(payload)})
      on conflict (tenant_id, dedupe_key) do nothing`;
  }
  await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
           values (${tenantId}, 'system', 'connection.disconnected', 'email_connection', ${connectionId}, ${tx.json({ code })})`;
  return true;
}
