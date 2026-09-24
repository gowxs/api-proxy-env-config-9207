import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTVerifyGetKey,
} from 'jose';

export interface AuthUser {
  userId: string;
  email?: string;
}

export type VerifyToken = (token: string) => Promise<AuthUser>;

export class AuthError extends Error {
  constructor() {
    super('unauthorized');
    this.name = 'AuthError';
  }
}

/**
 * Verifies Supabase Auth access tokens (asymmetric signing keys, published
 * at <SUPABASE_URL>/auth/v1/.well-known/jwks.json). Only signed-in users
 * ("authenticated" audience) with a subject are accepted.
 */
export function createTokenVerifier(opts: {
  jwksUrl?: string;
  jwks?: JSONWebKeySet;
  issuer?: string;
  /** Why a token was rejected (error name/code only; never the token). */
  onReject?: (reason: { name: string; code?: string; detail?: string }) => void;
}): VerifyToken {
  const keys: JWTVerifyGetKey = opts.jwks
    ? createLocalJWKSet(opts.jwks)
    : createRemoteJWKSet(new URL(opts.jwksUrl!));
  return async (token) => {
    try {
      const { payload } = await jwtVerify(token, keys, {
        audience: 'authenticated',
        ...(opts.issuer ? { issuer: opts.issuer } : {}),
        algorithms: ['ES256', 'RS256', 'EdDSA'],
      });
      if (typeof payload.sub !== 'string' || !payload.sub) throw new AuthError();
      return {
        userId: payload.sub,
        ...(typeof payload.email === 'string' ? { email: payload.email } : {}),
      };
    } catch (e) {
      const err = e as { name?: string; code?: string; message?: string };
      // jose messages are fixed strings (e.g. "Expected 200 OK …"); they never contain the token.
      const detail = err?.name === 'JOSEError' ? err.message?.slice(0, 120) : undefined;
      opts.onReject?.({
        name: err?.name ?? 'Error',
        ...(err?.code ? { code: err.code } : {}),
        ...(detail ? { detail } : {}),
      });
      throw new AuthError();
    }
  };
}
