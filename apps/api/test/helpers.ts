import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';

/** Test identity provider standing in for Supabase Auth (ES256 + JWKS). */
export async function testAuth() {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256', use: 'sig' };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const token = (userId: string, patch: { aud?: string; expSeconds?: number } = {}) =>
    new SignJWT({ role: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'test' })
      .setSubject(userId)
      .setAudience(patch.aud ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (patch.expSeconds ?? 600))
      .sign(privateKey);
  return { jwks, token };
}
