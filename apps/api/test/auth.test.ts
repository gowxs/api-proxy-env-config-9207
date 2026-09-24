import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT, type JSONWebKeySet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTokenVerifier, remoteKeySet } from '../src/auth.ts';

const ISSUER = 'https://project.example/auth/v1';
let server: Server;
let url: string;
let served: unknown;
let hits = 0;

async function signer(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const sign = (o: { iss?: string; aud?: string } = {}) =>
    new SignJWT({ role: 'authenticated', email: 'owner@example.test' })
      .setProtectedHeader({ alg: 'ES256', kid })
      .setSubject('user-1')
      .setAudience(o.aud ?? 'authenticated')
      .setIssuer(o.iss ?? ISSUER)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  return { jwk, sign };
}

beforeAll(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(typeof served === 'string' ? served : JSON.stringify(served));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/v1/.well-known/jwks.json`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('remote key set (Supabase JWKS)', () => {
  it('verifies tokens and caches the key set', async () => {
    const a = await signer('key-a');
    served = { keys: [a.jwk] } satisfies JSONWebKeySet;
    const verify = createTokenVerifier({ jwksUrl: url, issuer: ISSUER });
    hits = 0;
    expect(await verify(await a.sign())).toEqual({ userId: 'user-1', email: 'owner@example.test' });
    await verify(await a.sign());
    expect(hits).toBe(1);

    // A key published after the set was cached is not fetched again within 30 s.
    const b = await signer('key-b');
    served = { keys: [a.jwk, b.jwk] };
    await expect(verify(await b.sign())).rejects.toThrow('unauthorized');
    expect(hits).toBe(1);
  });

  it('reloads the key set when a token names an unknown key (rotation)', async () => {
    const a = await signer('key-a');
    const b = await signer('key-b');
    served = { keys: [a.jwk] };
    const keys = remoteKeySet(url, { minReloadMs: 0 });
    hits = 0;
    await jwtVerify(await a.sign(), keys);
    served = { keys: [a.jwk, b.jwk] };
    const { payload } = await jwtVerify(await b.sign(), keys);
    expect(payload.sub).toBe('user-1');
    expect(hits).toBe(2);
  });

  it('rejects wrong issuer, wrong audience and unknown keys, and reports why', async () => {
    const a = await signer('key-a');
    served = { keys: [a.jwk] };
    const reasons: unknown[] = [];
    const verify = createTokenVerifier({
      jwksUrl: url,
      issuer: ISSUER,
      onReject: (r) => reasons.push(r),
    });
    await expect(verify(await a.sign({ iss: 'https://evil.example/auth/v1' }))).rejects.toThrow(
      'unauthorized',
    );
    await expect(verify(await a.sign({ aud: 'anon' }))).rejects.toThrow('unauthorized');
    const stranger = await signer('key-x');
    await expect(verify(await stranger.sign())).rejects.toThrow('unauthorized');
    expect(reasons).toHaveLength(3);
    expect(JSON.stringify(reasons)).not.toMatch(/eyJ/); // never the token
  });

  it('accepts a gzip body sent without Content-Encoding (seen on the hosting network)', async () => {
    const { gzipSync } = await import('node:zlib');
    const a = await signer('key-a');
    const gz = createServer((_req, res) => {
      res.writeHead(200); // no content-type, no content-encoding
      res.end(gzipSync(JSON.stringify({ keys: [a.jwk] })));
    });
    await new Promise<void>((r) => gz.listen(0, '127.0.0.1', r));
    try {
      const verify = createTokenVerifier({
        jwksUrl: `http://127.0.0.1:${(gz.address() as AddressInfo).port}/jwks.json`,
        issuer: ISSUER,
      });
      expect((await verify(await a.sign())).userId).toBe('user-1');
    } finally {
      await new Promise<void>((r) => gz.close(() => r()));
    }
  });

  it('a key-set endpoint that returns something else fails closed', async () => {
    served = '<html>blocked</html>';
    const a = await signer('key-a');
    const reasons: { detail?: string }[] = [];
    const verify = createTokenVerifier({ jwksUrl: url, onReject: (r) => reasons.push(r) });
    await expect(verify(await a.sign())).rejects.toThrow('unauthorized');
    expect(reasons).toHaveLength(1);
  });
});
