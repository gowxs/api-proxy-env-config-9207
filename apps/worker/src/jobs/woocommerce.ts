import { withTenant, type Job } from '@noctiv/db';
import { WooError } from '@noctiv/woocommerce';
import { openWooConnection, type WooConnectionDeps } from '../woocommerce/connection.ts';

export type WooJobResult = { ok: true; storeName: string | null } | { ok: false; code: string };

const code = (e: unknown) => (e instanceof WooError ? e.code : 'UNAVAILABLE');

/** woocommerce.test: "Test connection". Records the outcome on the connection. */
export function woocommerceTestHandler(deps: WooConnectionDeps) {
  return async (job: Job): Promise<WooJobResult> => {
    const c = await openWooConnection(deps, job.tenantId, { includeBroken: true });
    const fail = async (k: string): Promise<WooJobResult> => {
      await withTenant(
        deps.sql,
        job.tenantId,
        (tx) =>
          tx`update public.woocommerce_connections set status = 'error', last_error_code = ${k}, last_checked_at = now()`,
      );
      return { ok: false, code: k };
    };
    if ('error' in c) {
      if (c.error === 'not_connected') return { ok: false, code: 'NOT_CONNECTED' };
      return c.error === 'auth' ? fail('AUTH_FAILED') : { ok: false, code: 'UNAVAILABLE' };
    }
    try {
      const info = await deps.woo.ping(c.store, c.creds);
      await withTenant(
        deps.sql,
        job.tenantId,
        (tx) => tx`
          update public.woocommerce_connections
          set status = 'connected', last_error_code = null, last_checked_at = now(),
              store_name = coalesce(${info.storeName}, store_name)`,
      );
      return { ok: true, storeName: info.storeName };
    } catch (e) {
      return fail(code(e));
    }
  };
}

/**
 * woocommerce.disconnect: "Disconnect and delete keys". A REST key cannot be revoked from
 * outside (only the merchant can delete it in WooCommerce), so this deletes the sealed key
 * pair and the connection, and records it.
 */
export function woocommerceDisconnectHandler(deps: Pick<WooConnectionDeps, 'sql'>) {
  return async (job: Job): Promise<{ deleted: boolean }> => {
    return withTenant(deps.sql, job.tenantId, async (tx) => {
      const gone = await tx`delete from public.woocommerce_connections returning tenant_id`;
      if (gone.length)
        await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id)
                 values (${job.tenantId}, 'owner', 'woocommerce.disconnected', 'woocommerce_connection', ${job.tenantId})`;
      return { deleted: gone.length > 0 };
    });
  };
}
