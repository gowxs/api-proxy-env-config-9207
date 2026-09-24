import type { Sql, TransactionSql } from 'postgres';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TenantContextError';
  }
}

/**
 * Runs `fn` in a transaction scoped to one tenant. RLS policies for the
 * runtime roles compare every row's tenant_id with this setting; it is
 * transaction-local, so a pooled connection never carries it into the next
 * transaction. Code that forgets withTenant sees zero rows.
 */
export async function withTenant<T>(
  sql: Sql,
  tenantId: string,
  fn: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new TenantContextError('withTenant requires a tenant UUID');
  }
  const result = await sql.begin(async (tx) => {
    await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
    return fn(tx);
  });
  return result as T;
}
