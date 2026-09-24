import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * Hybrid public-key encryption for mailbox credentials (PLAN.md §3.3):
 * ephemeral X25519 ECDH → HKDF-SHA256 → AES-256-GCM.
 *
 * The API holds only the public key and can seal; only the worker holds the
 * private key and can open. The additional data binds a ciphertext to its
 * tenant and connection, so copying one tenant's ciphertext into another
 * tenant's row makes it undecryptable.
 *
 * Wire format (v1): 0x01 | ephemeral public key (32) | IV (12) | tag (16) | ciphertext
 */

const VERSION = 0x01;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const HKDF_INFO = 'noctiv/sealed-box/v1';

export class SealedBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SealedBoxError';
  }
}

export interface SealingKeyPair {
  /** base64url raw X25519 public key — safe to give to the API. */
  publicKey: string;
  /** base64url raw X25519 private key — worker only, never in the database. */
  privateKey: string;
}

export function generateSealingKeyPair(): SealingKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  const jwk = privateKey.export({ format: 'jwk' });
  return { publicKey: publicKey.export({ format: 'jwk' }).x!, privateKey: jwk.d! };
}

function publicKeyObject(rawB64url: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: rawB64url }, format: 'jwk' });
}

function rawPublic(key: KeyObject): Buffer {
  return Buffer.from(key.export({ format: 'jwk' }).x!, 'base64url');
}

/** Short, stable identifier of a key pair, stored as credentials_key_id for rotation. */
export function sealingKeyId(publicKeyB64url: string): string {
  return createHash('sha256')
    .update(Buffer.from(publicKeyB64url, 'base64url'))
    .digest('hex')
    .slice(0, 16);
}

function deriveKey(shared: Buffer, ephemeralPub: Buffer, recipientPub: Buffer): Buffer {
  const salt = Buffer.concat([ephemeralPub, recipientPub]);
  return Buffer.from(hkdfSync('sha256', shared, salt, HKDF_INFO, KEY_LEN));
}

export function seal(
  plaintext: Buffer | string,
  recipientPublicKey: string,
  associatedData: string,
): Buffer {
  const recipient = publicKeyObject(recipientPublicKey);
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPub = rawPublic(ephemeral.publicKey);
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = deriveKey(shared, ephemeralPub, rawPublic(recipient));
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);
  shared.fill(0);
  return Buffer.concat([Buffer.from([VERSION]), ephemeralPub, iv, tag, body]);
}

export function open(
  sealed: Buffer,
  recipientPrivateKey: string,
  recipientPublicKey: string,
  associatedData: string,
): Buffer {
  if (sealed.length < 1 + KEY_LEN + IV_LEN + TAG_LEN || sealed[0] !== VERSION) {
    throw new SealedBoxError('Unsupported or truncated sealed payload');
  }
  const ephemeralPub = sealed.subarray(1, 1 + KEY_LEN);
  const iv = sealed.subarray(1 + KEY_LEN, 1 + KEY_LEN + IV_LEN);
  const tag = sealed.subarray(1 + KEY_LEN + IV_LEN, 1 + KEY_LEN + IV_LEN + TAG_LEN);
  const body = sealed.subarray(1 + KEY_LEN + IV_LEN + TAG_LEN);

  const privateKey = createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', d: recipientPrivateKey, x: recipientPublicKey },
    format: 'jwk',
  });
  const shared = diffieHellman({
    privateKey,
    publicKey: createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: ephemeralPub.toString('base64url') },
      format: 'jwk',
    }),
  });
  const key = deriveKey(shared, ephemeralPub, Buffer.from(recipientPublicKey, 'base64url'));
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    // Deliberately vague: wrong key, wrong tenant/connection binding or tampering.
    throw new SealedBoxError('Sealed payload could not be opened');
  } finally {
    key.fill(0);
    shared.fill(0);
  }
}

/** Additional data binding mailbox credentials to their row. */
export function credentialsAssociatedData(tenantId: string, connectionId: string): string {
  return `noctiv:email_credentials:v1:${tenantId}:${connectionId}`;
}
