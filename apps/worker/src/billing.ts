import { withTenant } from '@noctiv/db';
import type { Sql } from 'postgres';

/**
 * Whether the tenant is served: in its free trial or with a live Paddle
 * subscription (app.billing_entitled). Without it the worker stops reading
 * and answering the tenant's mail; its data is kept.
 */
export async function tenantEntitled(sql: Sql, tenantId: string): Promise<boolean> {
  const [r] = await withTenant(
    sql,
    tenantId,
    (tx) => tx<{ entitled: boolean }[]>`
      select app.billing_entitled(billing_status, trial_ends_at) as entitled from public.tenants`,
  );
  return r?.entitled ?? false;
}
