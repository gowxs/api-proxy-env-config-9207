import { withTenant, type Job } from '@noctiv/db';
import { checkScopes, ShopifyError } from '@noctiv/shopify';
import { openConnection, type ShopifyConnectionDeps } from '../shopify/connection.ts';

export type ShopifyJobResult = { ok: true; shopName: string } | { ok: false; code: string };

const code = (e: unknown) => (e instanceof ShopifyError ? e.code : 'UNAVAILABLE');

/** shopify.test: "Test connection" (and the check right after a store is linked). Records the outcome on the connection. */
export function shopifyTestHandler(deps: ShopifyConnectionDeps) {
  return async (job: Job): Promise<ShopifyJobResult> => {
    const c = await openConnection(deps, job.tenantId, { includeBroken: true });
    if ('error' in c) {
      if (c.error === 'not_connected') return { ok: false, code: 'NOT_CONNECTED' };
      if (c.error === 'auth') {
        await withTenant(
          deps.sql,
          job.tenantId,
          (tx) =>
            tx`update public.shopify_connections set status = 'error', last_error_code = 'AUTH_FAILED', last_checked_at = now()`,
        );
        return { ok: false, code: 'AUTH_FAILED' };
      }
      return { ok: false, code: 'UNAVAILABLE' };
    }
    try {
      const info = await deps.shopify.shopInfo(c.shop, c.tokens.accessToken);
      checkScopes(info.scopes);
      await withTenant(
        deps.sql,
        job.tenantId,
        (tx) => tx`
          update public.shopify_connections
          set status = 'connected', last_error_code = null, last_checked_at = now(),
              shop_name = ${info.shopName}, scopes = ${info.scopes}`,
      );
      return { ok: true, shopName: info.shopName };
    } catch (e) {
      const k = code(e);
      await withTenant(
        deps.sql,
        job.tenantId,
        (tx) =>
          tx`update public.shopify_connections set status = 'error', last_error_code = ${k}, last_checked_at = now()`,
      );
      return { ok: false, code: k };
    }
  };
}

/**
 * shopify.disconnect: "Disconnect and delete token". Uninstalls the app from the store
 * (which revokes the token) when that works, and deletes the connection and its sealed
 * tokens either way.
 */
export function shopifyDisconnectHandler(deps: ShopifyConnectionDeps) {
  return async (job: Job): Promise<{ revoked: boolean }> => {
    let revoked = false;
    const c = await openConnection(deps, job.tenantId, { includeBroken: true });
    if (!('error' in c)) {
      try {
        await deps.shopify.revoke(c.shop, c.tokens.accessToken);
        revoked = true;
      } catch {
        // The row is deleted regardless; the owner can also remove the app in Shopify.
      }
    }
    await withTenant(deps.sql, job.tenantId, async (tx) => {
      await tx`delete from public.shopify_connections`;
      await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
               values (${job.tenantId}, 'owner', 'shopify.disconnected', 'shopify_connection', ${job.tenantId},
                       ${tx.json({ revoked })})`;
    });
    return { revoked };
  };
}
