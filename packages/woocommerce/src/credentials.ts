import { open, seal, sealingKeyId, woocommerceCredentialsAssociatedData } from '@noctiv/core';

/**
 * The read-only REST key the merchant created in WooCommerce, sealed with the worker's public
 * key (as mailbox passwords and Shopify tokens are). The API can seal and never open; only the
 * worker opens, in memory, to call the store. Bound to the store address.
 */
export interface WooCredentials {
  consumerKey: string;
  consumerSecret: string;
}

export const KEY_RE = /^ck_[A-Za-z0-9]{16,80}$/;
export const SECRET_RE = /^cs_[A-Za-z0-9]{16,80}$/;

export function sealCredentials(c: WooCredentials, publicKey: string, storeUrl: string) {
  return {
    ciphertext: seal(
      Buffer.from(JSON.stringify(c), 'utf8'),
      publicKey,
      woocommerceCredentialsAssociatedData(storeUrl),
    ),
    keyId: sealingKeyId(publicKey),
  };
}

export function openCredentials(
  ciphertext: Uint8Array,
  keys: { publicKey: string; privateKey: string },
  storeUrl: string,
): WooCredentials {
  const plain = open(
    Buffer.from(ciphertext),
    keys.privateKey,
    keys.publicKey,
    woocommerceCredentialsAssociatedData(storeUrl),
  );
  try {
    const j = JSON.parse(plain.toString('utf8')) as Partial<WooCredentials>;
    if (!j.consumerKey || !j.consumerSecret)
      throw new Error('sealed WooCommerce credentials are incomplete');
    return { consumerKey: j.consumerKey, consumerSecret: j.consumerSecret };
  } finally {
    plain.fill(0);
  }
}
