import type { Job } from '@noctiv/db';
import type { Sql } from 'postgres';

/**
 * tenant.delete — hard delete requested by the owner (PLAN.md §4.7). The
 * database function erases every tenant row and the owners' logins that
 * belong to no other tenant, and completes the proof-of-erasure row.
 * Mailbox listeners stop on the next refresh (only active tenants listen).
 */
export function tenantDeleteHandler(deps: { sql: Sql }) {
  return async (job: Job) => {
    const [r] = await deps.sql<{ users_deleted: number }[]>`
      select users_deleted from app.delete_tenant(${job.tenantId})`;
    return { deleted: true, usersDeleted: r?.users_deleted ?? 0 };
  };
}

/** retention.purge: email content older than each tenant's retention_days. */
export async function purgeExpiredContent(sql: Sql) {
  const [r] = await sql<
    { messages_purged: number; drafts_purged: number; notifications_deleted: number }[]
  >`select * from app.purge_expired_content()`;
  return r!;
}
