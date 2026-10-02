import { enqueue, withTenant } from '@noctiv/db';
import {
  authorizeUrl,
  checkScopes,
  newNonce,
  normalizeShopDomain,
  SHOPIFY_ERROR_MESSAGES,
  sealTokens,
  ShopifyError,
  signToken,
  toStored,
  verifyQueryHmac,
  verifyToken,
  verifyWebhookHmac,
  type AppCredentials,
  type ShopifyClient,
  type ShopifyErrorCode,
} from '@noctiv/shopify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { HttpError } from './http-error.ts';
import { runJob as runJobFor } from './run-job.ts';

const tenantParams = z.object({ tenantId: z.uuid() });
const COOKIE = 'noctiv_shopify_oauth';

export interface ShopifyAppDeps {
  /** Noctiv's own app in the Shopify Partner Dashboard. */
  app: AppCredentials;
  client: ShopifyClient;
  /** Where merchants install from (the App Store listing or the install link); shown as "Connect Shopify". */
  installUrl: string | null;
}

export interface ShopifyRouteDeps extends AppDeps {
  appUrl: string;
  publicApiUrl: string;
  /** Signs the OAuth state and the claim (ACTION_LINK_SECRET). */
  secret: string;
  shopify: ShopifyAppDeps;
}

export const shopifyCallbackUrl = (publicApiUrl: string) =>
  `${publicApiUrl.replace(/\/+$/, '')}/shopify/callback`;

const MESSAGES: Record<string, string> = {
  ...SHOPIFY_ERROR_MESSAGES,
  NOT_CONNECTED: 'No Shopify store is connected.',
};

function cookieOf(req: FastifyRequest, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export function shopifyRoutes(app: FastifyInstance, deps: ShopifyRouteDeps): void {
  const { app: creds, client } = deps.shopify;
  const back = (reply: FastifyReply, params: Record<string, string>) =>
    reply
      .code(302)
      .header(
        'location',
        `${deps.appUrl.replace(/\/+$/, '')}/integrations?${new URLSearchParams({ shopify: 'result', ...params })}`,
      )
      .send();
  const secureCookie = deps.publicApiUrl.startsWith('https:') ? '; Secure' : '';

  // ------------------------------------------------------- owner, signed in
  app.get('/v1/tenants/:tenantId/shopify', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    return withTenant(deps.sql, tenantId, async (tx) => {
      const [c] = await tx`
        select shop_domain, shop_name, scopes, status, last_error_code, last_checked_at
        from public.shopify_connections`;
      const [t] = await tx<
        { days: number }[]
      >`select shopify_stale_days as days from public.tenants`;
      return {
        configured: true,
        installUrl: deps.shopify.installUrl,
        staleDays: t?.days ?? 14,
        connection: c
          ? {
              shopDomain: c.shop_domain,
              shopName: c.shop_name,
              scopes: c.scopes,
              status: c.status,
              lastErrorCode: c.last_error_code,
              lastCheckedAt: c.last_checked_at,
            }
          : null,
      };
    });
  });

  const runJob = (tenantId: string, queue: string) => runJobFor(deps, tenantId, queue);

  app.post('/v1/tenants/:tenantId/shopify/test', async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    const r = await runJob(tenantId, 'shopify.test');
    if (!r.done) return reply.code(202).send({ status: 'pending' });
    const res = r.result as { ok: boolean; shopName?: string; code?: string };
    return res.ok
      ? { status: 'ok', shopName: res.shopName }
      : {
          status: 'failed',
          code: res.code,
          message: MESSAGES[res.code ?? ''] ?? MESSAGES.UNAVAILABLE,
        };
  });

  /** "Disconnect and delete token": the worker uninstalls the app (revoking the token) and deletes the row; if it is slow the row is deleted here anyway. */
  app.delete('/v1/tenants/:tenantId/shopify', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    const r = await runJob(tenantId, 'shopify.disconnect');
    if (r.done)
      return {
        status: 'disconnected',
        revoked: Boolean((r.result as { revoked?: boolean })?.revoked),
      };
    await withTenant(deps.sql, tenantId, async (tx) => {
      const gone = await tx`delete from public.shopify_connections returning tenant_id`;
      if (gone.length)
        await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
                 values (${tenantId}, 'owner', ${req.user!.userId}, 'shopify.disconnected', 'shopify_connection', ${tenantId},
                         ${tx.json({ revoked: false })})`;
    });
    return { status: 'disconnected', revoked: false };
  });

  /** After installing, the owner links the store to this business. */
  app.post('/v1/tenants/:tenantId/shopify/claim', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    const { claim } = z
      .object({ claim: z.string().min(10).max(2000) })
      .strict()
      .parse(req.body);
    await deps.requireMember(tenantId, req.user!.userId);
    const v = verifyToken<{ kind: string; shop: string }>(claim, deps.secret);
    if (!v || v.kind !== 'claim' || !normalizeShopDomain(v.shop))
      throw new HttpError(400, 'This link has expired. Install the app again from Shopify.');
    const [r] = await deps.sql<{ r: string }[]>`
      select app.shopify_install_claim(${v.shop}, ${tenantId}, ${req.user!.userId}) as r`;
    if (r?.r === 'forbidden') throw new HttpError(403, 'Only the owner can connect a store.');
    if (r?.r === 'taken')
      throw new HttpError(409, 'That store is already connected to another Noctiv account.');
    if (r?.r === 'missing')
      throw new HttpError(404, 'This install has expired. Install the app again from Shopify.');
    // Read the shop name and check the permissions, in the background.
    await withTenant(deps.sql, tenantId, (tx) =>
      enqueue(tx, { tenantId, queue: 'shopify.test', payload: {}, maxAttempts: 1 }),
    );
    return { ok: true, shopDomain: v.shop };
  });

  // ---------------------------------------------- Shopify → us (no user token)
  /**
   * The app URL Shopify opens after "Install". The install is a Shopify-initiated
   * flow: we verify the request is Shopify's and go straight to OAuth.
   */
  app.get<{ Querystring: Record<string, string> }>('/shopify/app', async (req, reply) => {
    const shop = req.query.shop ?? '';
    if (
      !normalizeShopDomain(shop) ||
      normalizeShopDomain(shop) !== shop ||
      !verifyQueryHmac(req.query, creds.clientSecret)
    )
      return reply.code(400).send({ error: 'invalid request' });
    const nonce = newNonce();
    const state = signToken({ kind: 'oauth', shop, nonce }, deps.secret, 600);
    return reply
      .code(302)
      .header(
        'set-cookie',
        `${COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/shopify; Max-Age=600${secureCookie}`,
      )
      .header(
        'location',
        authorizeUrl({
          shop,
          clientId: creds.clientId,
          redirectUri: shopifyCallbackUrl(deps.publicApiUrl),
          state,
        }),
      )
      .send();
  });

  app.get<{ Querystring: Record<string, string> }>('/shopify/callback', async (req, reply) => {
    const q = req.query;
    const clear = `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/shopify; Max-Age=0${secureCookie}`;
    reply.header('set-cookie', clear);
    const shop = q.shop ?? '';
    const state = verifyToken<{ kind: string; shop: string; nonce: string }>(
      q.state ?? '',
      deps.secret,
    );
    if (
      normalizeShopDomain(shop) !== shop ||
      !verifyQueryHmac(q, creds.clientSecret) ||
      !state ||
      state.kind !== 'oauth' ||
      state.shop !== shop ||
      state.nonce !== cookieOf(req, COOKIE)
    )
      return back(reply, { reason: 'state' });
    if (q.error || !q.code)
      return back(reply, { reason: q.error === 'access_denied' ? 'denied' : 'shopify' });
    try {
      const tokens = await client.exchangeCode(shop, creds, q.code);
      // Never keep a connection that could change the store, or that cannot read orders.
      checkScopes(tokens.scopes);
      const sealed = sealTokens(toStored(tokens), deps.credentialsPublicKey, shop);
      await deps.sql`
        select app.shopify_install_store(${shop}, ${sealed.ciphertext}, ${sealed.keyId}, ${tokens.scopes})`;
      const claim = signToken({ kind: 'claim', shop }, deps.secret, 1800);
      return back(reply, { claim });
    } catch (e) {
      const code: ShopifyErrorCode = e instanceof ShopifyError ? e.code : 'UNAVAILABLE';
      req.log.warn({ code }, 'shopify install failed');
      return back(reply, {
        reason: code === 'WRITE_SCOPES' || code === 'MISSING_SCOPE' ? 'scopes' : 'shopify',
      });
    }
  });

  // Webhooks: signed with the app secret over the exact bytes sent, so the body stays raw.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string', bodyLimit: 256 * 1024 },
      (_req, body, done) => done(null, body),
    );
    scope.post('/shopify/webhooks', async (req, reply) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      if (
        !verifyWebhookHmac(
          raw,
          req.headers['x-shopify-hmac-sha256'] as string | undefined,
          creds.clientSecret,
        )
      )
        return reply.code(401).send({ error: 'invalid signature' });
      const topic = String(req.headers['x-shopify-topic'] ?? '');
      const shop = normalizeShopDomain(String(req.headers['x-shopify-shop-domain'] ?? ''));
      if (!shop) return reply.code(400).send({ error: 'invalid shop' });
      if (topic === 'app/uninstalled')
        await deps.sql`select app.shopify_shop_removed(${shop}, 'uninstalled')`;
      else if (topic === 'shop/redact')
        await deps.sql`select app.shopify_shop_removed(${shop}, 'shop_redact')`;
      else if (topic === 'customers/redact' || topic === 'customers/data_request')
        await deps.sql`select app.shopify_privacy_request(${shop}, ${topic})`;
      return reply.code(200).send({ ok: true });
    });
  });
}
