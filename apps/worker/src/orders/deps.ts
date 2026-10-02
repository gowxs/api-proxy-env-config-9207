import type { OrderProvider } from '@noctiv/orders';

type Missing = { error: 'not_connected' | 'auth' | 'unavailable' };

/** What the pipeline needs to look orders up, whatever the shop platform. */
export interface OrdersDeps {
  /** The read-only lookup for this business, or why there is none. */
  providerFor(tenantId: string): Promise<{ provider: OrderProvider } | Missing>;
  /** The connection stopped working (token revoked, key deleted): show it in the app. */
  markBroken(tenantId: string, code: string, platform: OrderProvider['platform']): Promise<void>;
}

/**
 * One business has one shop connection. If it ever had two, the first platform that is
 * connected answers (Shopify before WooCommerce); a broken one reports its own error.
 */
export function combineOrders(
  platforms: { platform: OrderProvider['platform']; deps: OrdersDeps }[],
): OrdersDeps {
  return {
    async providerFor(tenantId) {
      let last: Missing = { error: 'not_connected' };
      for (const p of platforms) {
        const r = await p.deps.providerFor(tenantId);
        if (!('error' in r)) return r;
        if (r.error !== 'not_connected') last = r;
      }
      return last;
    },
    async markBroken(tenantId, code, platform) {
      await platforms
        .find((p) => p.platform === platform)
        ?.deps.markBroken(tenantId, code, platform);
    },
  };
}
