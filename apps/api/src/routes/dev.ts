import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet } from 'jose';
import type { FastifyInstance } from 'fastify';

/**
 * Local development only (refused in production config): a "Sign in as the
 * dev user" button, so the whole stack runs without a Supabase project.
 * Tokens look like Supabase access tokens but are signed by a key that
 * exists only in this process.
 */
export async function createDevAuth(user: { id: string; email: string }) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'noctiv-dev', alg: 'ES256', use: 'sig' };
  const jwks: JSONWebKeySet = { keys: [jwk] };
  const issue = () =>
    new SignJWT({ role: 'authenticated', email: user.email })
      .setProtectedHeader({ alg: 'ES256', kid: 'noctiv-dev' })
      .setSubject(user.id)
      .setAudience('authenticated')
      .setIssuedAt()
      .setExpirationTime('12h')
      .sign(privateKey);
  const routes = (app: FastifyInstance) => {
    app.post('/dev/login', async () => ({ accessToken: await issue(), email: user.email }));
  };
  return { jwks, routes };
}
