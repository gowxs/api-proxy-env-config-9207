import { open, seal, sealingKeyId, shopifyCredentialsAssociatedData } from '@noctiv/core';
import type { TokenSet } from './client.ts';

/**
 * What is stored per store: the expiring offline access token and its refresh
 * token, sealed with the worker's public key (as mailbox passwords are). The API
 * can seal and never open; only the worker opens, in memory, to call Shopify.
 * The ciphertext is bound to its business.
 */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: string | null;
  refreshExpiresAt: string | null;
}

export const toStored = (t: TokenSet): StoredTokens => ({
  accessToken: t.accessToken,
  refreshToken: t.refreshToken,
  accessExpiresAt: t.accessExpiresAt,
  refreshExpiresAt: t.refreshExpiresAt,
});

export function sealTokens(tokens: StoredTokens, publicKey: string, shop: string) {
  return {
    ciphertext: seal(
      Buffer.from(JSON.stringify(tokens), 'utf8'),
      publicKey,
      shopifyCredentialsAssociatedData(shop),
    ),
    keyId: sealingKeyId(publicKey),
  };
}

export function openTokens(
  ciphertext: Uint8Array,
  keys: { publicKey: string; privateKey: string },
  shop: string,
): StoredTokens {
  const plain = open(
    Buffer.from(ciphertext),
    keys.privateKey,
    keys.publicKey,
    shopifyCredentialsAssociatedData(shop),
  );
  try {
    const j = JSON.parse(plain.toString('utf8')) as Partial<StoredTokens>;
    if (!j.accessToken) throw new Error('sealed Shopify credentials are incomplete');
    return {
      accessToken: j.accessToken,
      refreshToken: j.refreshToken ?? null,
      accessExpiresAt: j.accessExpiresAt ?? null,
      refreshExpiresAt: j.refreshExpiresAt ?? null,
    };
  } finally {
    plain.fill(0);
  }
}

/** True when the access token is gone or about to be (within 5 minutes). */
export function accessNeedsRefresh(t: StoredTokens, now = Date.now()): boolean {
  return (
    Boolean(t.refreshToken) &&
    (t.accessExpiresAt === null || Date.parse(t.accessExpiresAt) - 300_000 <= now)
  );
}
