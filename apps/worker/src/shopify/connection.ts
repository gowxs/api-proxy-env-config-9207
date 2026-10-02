import { withTenant } from '@noctiv/db';
import {
  accessNeedsRefresh,
  openTokens,
  sealTokens,
  ShopifyError,
  toStored,
  type AppCredentials,
  type ShopifyClient,
  type StoredTokens,
} from '@noctiv/shopify';
import { OrderLookupError } from '@noctiv/orders';
import type { Sql } from 'postgres';
import type { OrdersDeps } from '../orders/deps.ts';

export interface ShopifyConnectionDeps {
  sql: Sql;
  keys: { publicKey: string; privateKey: string };
  shopify: ShopifyClient;
  /** Noctiv's own Shopify app credentials (needed to renew tokens). */
  app: AppCredentials | null;
}

interface Row {
  shop_domain: string;
  credentials_ciphertext: Buffer;
  status: string;
}

/**
 * Opens the tenant's Shopify tokens (the only place they are decrypted) and, when
 * the 1-hour access token is about to lapse, renews it. A renewal replaces BOTH
 * tokens, so the row is locked while it happens and the new pair is sealed and
 * saved before anyone else can use the old refresh token.
 */
export async function openConnection(
  deps: ShopifyConnectionDeps,
  tenantId: string,
  opts: { includeBroken?: boolean } = {},
): Promise<
  { shop: string; tokens: StoredTokens } | { error: 'not_connected' | 'auth' | 'unavailable' }
> {
  return withTenant(deps.sql, tenantId, async (tx) => {
    const [row] = await tx<Row[]>`
      select shop_domain, credentials_ciphertext, status from public.shopify_connections for update`;
    if (!row || (row.status !== 'connected' && !opts.includeBroken))
      return { error: 'not_connected' } as const;
    let tokens: StoredTokens;
    try {
      tokens = openTokens(row.credentials_ciphertext, deps.keys, row.shop_domain);
    } catch {
      return { error: 'auth' } as const;
    }
    if (!accessNeedsRefresh(tokens)) return { shop: row.shop_domain, tokens };
    if (!deps.app || !tokens.refreshToken) return { error: 'auth' } as const;
    try {
      const next = toStored(
        await deps.shopify.refresh(row.shop_domain, deps.app, tokens.refreshToken),
      );
      const sealed = sealTokens(next, deps.keys.publicKey, row.shop_domain);
      await tx`
        update public.shopify_connections
        set credentials_ciphertext = ${sealed.ciphertext}, credentials_key_id = ${sealed.keyId},
            status = 'connected', last_error_code = null, tokens_renewed_at = now()`;
      return { shop: row.shop_domain, tokens: next };
    } catch (e) {
      if (e instanceof ShopifyError && e.code === 'AUTH_FAILED') {
        await tx`update public.shopify_connections set status = 'error', last_error_code = 'AUTH_FAILED', last_checked_at = now()`;
        return { error: 'auth' } as const;
      }
      return { error: 'unavailable' } as const;
    }
  });
}

export function shopifyOrders(deps: ShopifyConnectionDeps): OrdersDeps {
  return {
    async providerFor(tenantId) {
      const c = await openConnection(deps, tenantId);
      if ('error' in c) return c;
      return { provider: deps.shopify.orders(c.shop, c.tokens.accessToken) };
    },
    async markBroken(tenantId, code) {
      await withTenant(
        deps.sql,
        tenantId,
        (tx) => tx`
          update public.shopify_connections
          set status = 'error', last_error_code = ${code.slice(0, 40)}, last_checked_at = now()`,
      );
    },
  };
}

export { OrderLookupError };
export type { OrdersDeps };
