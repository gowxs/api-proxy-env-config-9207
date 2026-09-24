import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';

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
 * The project's public signing keys, fetched with plain fetch and cached.
 * (jose's own remote fetcher got a non-JSON response on the hosting
 * network while plain fetch got the key set; found on the first deploy.)
 * An unknown key id reloads the set (key rotation), at most every 30 s.
 */
export function remoteKeySet(
  url: string,
  opts: { ttlMs?: number; minReloadMs?: number; fetchImpl?: typeof fetch } = {},
): JWTVerifyGetKey {
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const minReload = opts.minReloadMs ?? 30_000;
  const doFetch = opts.fetchImpl ?? fetch;
  let cached: { get: JWTVerifyGetKey; at: number } | undefined;
  let loading: Promise<JWTVerifyGetKey> | undefined;

  const load = () =>
    (loading ??= (async () => {
      try {
        const res = await doFetch(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) throw new Error(`key set request failed: HTTP ${res.status}`);
        const jwks = (await res.json()) as JSONWebKeySet;
        if (!Array.isArray(jwks?.keys)) throw new Error('key set response has no keys');
        cached = { get: createLocalJWKSet(jwks), at: Date.now() };
        return cached.get;
      } finally {
        loading = undefined;
      }
    })());

  return async (header, token) => {
    const fresh = cached && Date.now() - cached.at < ttl;
    const get = fresh ? cached!.get : await load();
    try {
      return await get(header, token);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'ERR_JWKS_NO_MATCHING_KEY' && cached && Date.now() - cached.at >= minReload) {
        return (await load())(header, token);
      }
      throw e;
    }
  };
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
    : remoteKeySet(new URL(opts.jwksUrl!).toString());
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
      // jose and key-set messages are fixed strings; they never contain the token.
      const detail =
        err?.name === 'JOSEError' || /^key set /.test(err?.message ?? '')
          ? err.message?.slice(0, 120)
          : undefined;
      opts.onReject?.({
        name: err?.name ?? 'Error',
        ...(err?.code ? { code: err.code } : {}),
        ...(detail ? { detail } : {}),
      });
      throw new AuthError();
    }
  };
}
