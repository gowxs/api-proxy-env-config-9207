import { withTenant } from '@noctiv/db';
import { OrderLookupError } from '@noctiv/orders';
import { openCredentials, type WooClient, type WooCredentials } from '@noctiv/woocommerce';
import type { Sql } from 'postgres';
import type { OrdersDeps } from '../orders/deps.ts';

export interface WooConnectionDeps {
  sql: Sql;
  keys: { publicKey: string; privateKey: string };
  woo: WooClient;
}

interface Row {
  store_url: string;
  credentials_ciphertext: Buffer;
  status: string;
}

/** Opens the tenant's REST key (the only place it is decrypted), in memory, for one call sequence. */
export async function openWooConnection(
  deps: WooConnectionDeps,
  tenantId: string,
  opts: { includeBroken?: boolean } = {},
): Promise<
  { store: string; creds: WooCredentials } | { error: 'not_connected' | 'auth' | 'unavailable' }
> {
  return withTenant(deps.sql, tenantId, async (tx) => {
    const [row] = await tx<Row[]>`
      select store_url, credentials_ciphertext, status from public.woocommerce_connections`;
    if (!row || (row.status !== 'connected' && !opts.includeBroken))
      return { error: 'not_connected' } as const;
    try {
      return {
        store: row.store_url,
        creds: openCredentials(row.credentials_ciphertext, deps.keys, row.store_url),
      };
    } catch {
      return { error: 'auth' } as const;
    }
  });
}

export function wooOrders(deps: WooConnectionDeps): OrdersDeps {
  return {
    async providerFor(tenantId) {
      const c = await openWooConnection(deps, tenantId);
      if ('error' in c) return c;
      return { provider: deps.woo.orders(c.store, c.creds) };
    },
    async markBroken(tenantId, code) {
      await withTenant(
        deps.sql,
        tenantId,
        (tx) => tx`
          update public.woocommerce_connections
          set status = 'error', last_error_code = ${code.slice(0, 40)}, last_checked_at = now()`,
      );
    },
  };
}

export { OrderLookupError };
