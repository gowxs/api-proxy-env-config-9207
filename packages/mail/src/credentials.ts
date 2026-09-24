import { credentialsAssociatedData, open, seal, sealingKeyId } from '@noctiv/core';

/**
 * Mailbox password sealing (PLAN.md §3.3). The API holds only the public key
 * and seals; the worker holds the private key and opens. The ciphertext is
 * bound to its tenant and connection id.
 */
export function sealMailboxPassword(
  password: string,
  publicKey: string,
  tenantId: string,
  connectionId: string,
) {
  return {
    ciphertext: seal(
      Buffer.from(password, 'utf8'),
      publicKey,
      credentialsAssociatedData(tenantId, connectionId),
    ),
    keyId: sealingKeyId(publicKey),
  };
}

export function openMailboxPassword(
  ciphertext: Uint8Array,
  keys: { publicKey: string; privateKey: string },
  tenantId: string,
  connectionId: string,
): string {
  const plain = open(
    Buffer.from(ciphertext),
    keys.privateKey,
    keys.publicKey,
    credentialsAssociatedData(tenantId, connectionId),
  );
  const password = plain.toString('utf8');
  plain.fill(0);
  return password;
}
