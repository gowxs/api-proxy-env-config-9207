import { describe, expect, it } from 'vitest';
import {
  credentialsAssociatedData,
  generateSealingKeyPair,
  open,
  seal,
  SealedBoxError,
  sealingKeyId,
} from '../src/index.ts';

const keys = generateSealingKeyPair();
const aad = credentialsAssociatedData(
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
);
const password = 'abcd efgh ijkl mnop';

describe('sealed box (credential encryption)', () => {
  it('round-trips with the matching private key and binding', () => {
    const sealed = seal(password, keys.publicKey, aad);
    expect(open(sealed, keys.privateKey, keys.publicKey, aad).toString('utf8')).toBe(password);
  });

  it('never contains the plaintext and differs on every seal', () => {
    const a = seal(password, keys.publicKey, aad);
    const b = seal(password, keys.publicKey, aad);
    expect(a.includes(Buffer.from(password))).toBe(false);
    expect(a.equals(b)).toBe(false);
    expect(a[0]).toBe(1);
  });

  it("cannot be opened for another tenant's or connection's row", () => {
    const sealed = seal(password, keys.publicKey, aad);
    const other = credentialsAssociatedData(
      '33333333-3333-4333-8333-333333333333',
      '22222222-2222-4222-8222-222222222222',
    );
    expect(() => open(sealed, keys.privateKey, keys.publicKey, other)).toThrow(SealedBoxError);
  });

  it('cannot be opened with another key pair', () => {
    const sealed = seal(password, keys.publicKey, aad);
    const other = generateSealingKeyPair();
    expect(() => open(sealed, other.privateKey, other.publicKey, aad)).toThrow(SealedBoxError);
  });

  it('detects tampering and truncation', () => {
    const sealed = seal(password, keys.publicKey, aad);
    const flipped = Buffer.from(sealed);
    flipped[flipped.length - 1]! ^= 0x01;
    expect(() => open(flipped, keys.privateKey, keys.publicKey, aad)).toThrow(SealedBoxError);
    expect(() => open(sealed.subarray(0, 20), keys.privateKey, keys.publicKey, aad)).toThrow(
      SealedBoxError,
    );
  });

  it('error messages reveal nothing about the secret', () => {
    const sealed = seal(password, keys.publicKey, aad);
    try {
      open(sealed, keys.privateKey, keys.publicKey, 'wrong');
    } catch (e) {
      expect(String(e)).not.toContain(password);
      expect(String(e)).not.toContain(keys.privateKey);
    }
  });

  it('derives a stable short key id from the public key', () => {
    expect(sealingKeyId(keys.publicKey)).toMatch(/^[0-9a-f]{16}$/);
    expect(sealingKeyId(keys.publicKey)).toBe(sealingKeyId(keys.publicKey));
    expect(sealingKeyId(generateSealingKeyPair().publicKey)).not.toBe(sealingKeyId(keys.publicKey));
  });
});
