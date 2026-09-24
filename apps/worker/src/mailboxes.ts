import type { Sql } from 'postgres';
import type { MailboxRef } from '@noctiv/llm';

/** Every connected mailbox across tenants (identifiers and test flag only). */
export async function listConnectedMailboxes(sql: Sql): Promise<MailboxRef[]> {
  const rows = await sql<{ tenant_id: string; connection_id: string; is_test_mailbox: boolean }[]>`
    select tenant_id, connection_id, is_test_mailbox from app.list_mail_connections()`;
  return rows.map((r) => ({
    tenantId: r.tenant_id,
    connectionId: r.connection_id,
    isTestMailbox: r.is_test_mailbox,
  }));
}
