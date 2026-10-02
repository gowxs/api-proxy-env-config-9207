import { withTenant } from '@noctiv/db';
import {
  KEY_RE,
  normalizeStoreUrl,
  SECRET_RE,
  sealCredentials,
  WooError,
  WOO_ERROR_MESSAGES,
  type WooClient,
  type WooErrorCode,
} from '@noctiv/woocommerce';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { HttpError } from './http-error.ts';
import { runJob } from './run-job.ts';

const tenantParams = z.object({ tenantId: z.uuid() });

export interface WooRouteDeps extends AppDeps {
  woo: WooClient;
}

const MESSAGES: Record<string, string> = {
  ...WOO_ERROR_MESSAGES,
  NOT_CONNECTED: 'No WooCommerce store is connected.',
};

/**
 * WooCommerce order lookup: the merchant pastes the read-only REST key they created in
 * WooCommerce. The key is checked against the store, sealed (the API can never open it again),
 * and never logged: request bodies are not logged and no response or error repeats it.
 */
export function woocommerceRoutes(app: FastifyInstance, deps: WooRouteDeps): void {
  app.get('/v1/tenants/:tenantId/woocommerce', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    return withTenant(deps.sql, tenantId, async (tx) => {
      const [c] = await tx`
        select store_url, store_name, status, last_error_code, last_checked_at
        from public.woocommerce_connections`;
      const [t] = await tx<
        { days: number }[]
      >`select shopify_stale_days as days from public.tenants`;
      const [sh] = await tx`select 1 as x from public.shopify_connections`;
      return {
        configured: true,
        staleDays: t?.days ?? 14,
        shopifyConnected: Boolean(sh),
        connection: c
          ? {
              storeUrl: c.store_url,
              storeName: c.store_name,
              status: c.status,
              lastErrorCode: c.last_error_code,
              lastCheckedAt: c.last_checked_at,
            }
          : null,
      };
    });
  });

  /** Connect (or replace the key of) a store. */
  app.put('/v1/tenants/:tenantId/woocommerce', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    const body = z
      .object({
        storeUrl: z.string().min(1).max(300),
        consumerKey: z.string().trim().min(1).max(120),
        consumerSecret: z.string().trim().min(1).max(120),
      })
      .strict()
      .safeParse(req.body);
    await deps.requireMember(tenantId, req.user!.userId);
    if (!body.success) throw new HttpError(400, 'Fill in the store address, key and secret.');
    const { consumerKey, consumerSecret } = body.data;
    const url = normalizeStoreUrl(body.data.storeUrl);
    if ('problem' in url) throw new HttpError(422, MESSAGES[url.problem]!);
    if (!KEY_RE.test(consumerKey) || !SECRET_RE.test(consumerSecret))
      throw new HttpError(
        422,
        'The key should start with ck_ and the secret with cs_. Copy both from WooCommerce > Settings > Advanced > REST API.',
      );
    const shopify = await withTenant(
      deps.sql,
      tenantId,
      (tx) => tx`select 1 as x from public.shopify_connections`,
    );
    if (shopify.length)
      throw new HttpError(409, 'This business already has Shopify connected. Disconnect it first.');

    const creds = { consumerKey, consumerSecret };
    let storeName: string | null;
    try {
      storeName = (await deps.woo.ping(url.url, creds)).storeName;
    } catch (e) {
      const code: WooErrorCode = e instanceof WooError ? e.code : 'UNAVAILABLE';
      req.log.warn({ code }, 'woocommerce connect failed');
      throw new HttpError(422, MESSAGES[code] ?? MESSAGES.UNAVAILABLE!);
    }
    const sealed = sealCredentials(creds, deps.credentialsPublicKey, url.url);
    await withTenant(deps.sql, tenantId, async (tx) => {
      // Update, then insert: the API may write the sealed key but not read it back, which an upsert would need.
      const updated = await tx`
        update public.woocommerce_connections
        set store_url = ${url.url}, credentials_ciphertext = ${sealed.ciphertext},
            credentials_key_id = ${sealed.keyId}, store_name = ${storeName}, status = 'connected',
            last_error_code = null, last_checked_at = now()
        where tenant_id = ${tenantId}
        returning tenant_id`;
      if (!updated.length)
        await tx`
          insert into public.woocommerce_connections
            (tenant_id, store_url, credentials_ciphertext, credentials_key_id, store_name, status, last_checked_at)
          values (${tenantId}, ${url.url}, ${sealed.ciphertext}, ${sealed.keyId}, ${storeName}, 'connected', now())`;
      await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id)
               values (${tenantId}, 'owner', ${req.user!.userId}, 'woocommerce.connected', 'woocommerce_connection', ${tenantId})`;
    });
    return { status: 'ok', storeName, storeUrl: url.url };
  });

  app.post('/v1/tenants/:tenantId/woocommerce/test', async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    const r = await runJob(deps, tenantId, 'woocommerce.test');
    if (!r.done) return reply.code(202).send({ status: 'pending' });
    const res = r.result as { ok: boolean; storeName?: string | null; code?: string };
    return res.ok
      ? { status: 'ok', storeName: res.storeName ?? null }
      : {
          status: 'failed',
          code: res.code,
          message: MESSAGES[res.code ?? ''] ?? MESSAGES.UNAVAILABLE,
        };
  });

  /** "Disconnect and delete keys": the worker deletes the sealed pair; if it is slow the row is deleted here anyway. */
  app.delete('/v1/tenants/:tenantId/woocommerce', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    const r = await runJob(deps, tenantId, 'woocommerce.disconnect');
    if (r.done) return { status: 'disconnected' };
    await withTenant(deps.sql, tenantId, async (tx) => {
      const gone = await tx`delete from public.woocommerce_connections returning tenant_id`;
      if (gone.length)
        await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id)
                 values (${tenantId}, 'owner', ${req.user!.userId}, 'woocommerce.disconnected', 'woocommerce_connection', ${tenantId})`;
    });
    return { status: 'disconnected' };
  });
}
