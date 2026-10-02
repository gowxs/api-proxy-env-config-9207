/**
 * Live check against the owner's Shopify development store. Runs only when
 * SHOPIFY_TEST_SHOP and SHOPIFY_TEST_ACCESS_TOKEN are set (environment or .env);
 * otherwise it is skipped. Values are never printed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decideOrder } from '@noctiv/orders';
import { createShopifyClient } from '../src/client.ts';

function fromDotenv(key: string): string | undefined {
  try {
    const line = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key}=`));
    return (
      line
        ?.slice(key.length + 1)
        .trim()
        .replace(/^["']|["']$/g, '') || undefined
    );
  } catch {
    return undefined;
  }
}
const shop = process.env.SHOPIFY_TEST_SHOP ?? fromDotenv('SHOPIFY_TEST_SHOP');
const token = process.env.SHOPIFY_TEST_ACCESS_TOKEN ?? fromDotenv('SHOPIFY_TEST_ACCESS_TOKEN');

describe.skipIf(!shop || !token)('live dev store', () => {
  const provider = () => createShopifyClient().orders(shop!, token!);
  const decide = async (number: string, sender: string) =>
    decideOrder({
      numbers: [number],
      sender,
      byNumber: await provider().findByNumber(number),
      byEmail: [],
      now: new Date(),
      staleDays: 14,
    });

  it('only has the read scope', async () => {
    const info = await createShopifyClient().shopInfo(shop!, token!);
    expect(info.scopes.every((s) => s.startsWith('read_'))).toBe(true);
  });

  it('identity mismatch reveals nothing', async () => {
    const d = await decide('1001', 'gowxs612@gmail.com');
    expect(d.kind).toBe('escalate');
    expect(JSON.stringify(d)).not.toMatch(/Winfield|russel/i);
  });

  it('answers a verified, shipped order and escalates cancelled ones', async () => {
    expect((await decide('1002', 'gowxs612@gmail.com')).kind).toBe('reply');
    expect((await decide('1004', 'gowxs612@gmail.com')).kind).toBe('escalate');
  });
});
