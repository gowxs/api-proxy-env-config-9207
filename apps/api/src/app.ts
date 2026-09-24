import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import type { Logger } from '@noctiv/core';
import { withTenant } from '@noctiv/db';
import type { Sql } from 'postgres';
import { ZodError } from 'zod';
import { AuthError, type AuthUser, type VerifyToken } from './auth.ts';
import { registerRateLimits } from './rate-limit.ts';
import { actionRoutes } from './routes/actions.ts';
import { connectionRoutes } from './routes/connections.ts';
import { meRoutes } from './routes/me.ts';
import { HttpError, webRoutes } from './routes/web.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export class ForbiddenError extends Error {
  constructor() {
    super('forbidden');
  }
}

export interface AppDeps {
  logger: Logger;
  /** Returns true when the database answers; used by the readiness probe. */
  checkDatabase: () => Promise<boolean>;
  sql: Sql;
  verifyToken: VerifyToken;
  /** Worker's public sealing key: the API can encrypt mailbox passwords but never decrypt them. */
  credentialsPublicKey: string;
  connectionTestWaitMs: number;
  requireMember: (tenantId: string, userId: string) => Promise<void>;
  /** Shared with the worker: verifies Approve / Reject links. Without it those routes are off. */
  actionSecret?: string;
  /** Dashboard base URL, shown on action pages. */
  appUrl?: string;
  /** Signup gate: creating a business needs one of these codes (empty = open). */
  inviteCodes?: string[];
  /** Development only: extra routes (the dev login). */
  devRoutes?: (app: FastifyInstance) => void;
  /** Behind Caddy in production: take the client IP from X-Forwarded-For. */
  trustProxy?: boolean;
  /** Off only in tests that need many requests. */
  rateLimits?: boolean;
}

/** Membership check within the tenant's own RLS context. */
export function memberCheck(sql: Sql) {
  return async (tenantId: string, userId: string) => {
    const rows = await withTenant(
      sql,
      tenantId,
      (tx) => tx`select 1 from public.tenant_members where user_id = ${userId}`,
    );
    if (rows.length === 0) throw new ForbiddenError();
  };
}

export function buildApp(
  deps: Omit<AppDeps, 'requireMember'> & Partial<Pick<AppDeps, 'requireMember'>>,
) {
  const full: AppDeps = { ...deps, requireMember: deps.requireMember ?? memberCheck(deps.sql) };
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    bodyLimit: 1024 * 1024,
    // Signed action tokens are ~250 characters.
    routerOptions: { maxParamLength: 512 },
    trustProxy: deps.trustProxy ?? false,
  });

  if (deps.rateLimits !== false) registerRateLimits(app);

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const dbOk = await deps.checkDatabase().catch(() => false);
    return reply.code(dbOk ? 200 : 503).send({ status: dbOk ? 'ready' : 'unavailable' });
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/v1/')) return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new AuthError();
    req.user = await deps.verifyToken(token);
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof AuthError) return reply.code(401).send({ error: 'unauthorized' });
    if (error instanceof ForbiddenError) return reply.code(403).send({ error: 'forbidden' });
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.message });
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ error: 'invalid request', issues: error.issues.map((i) => i.path.join('.')) });
    reply.log.error(
      { err: { name: (error as Error).name, message: (error as Error).message } },
      'request failed',
    );
    return reply.code(500).send({ error: 'internal error' });
  });

  connectionRoutes(app, full);
  meRoutes(app, { ...full, inviteCodes: deps.inviteCodes ?? [] });
  webRoutes(app, full);
  deps.devRoutes?.(app);
  if (deps.actionSecret) {
    actionRoutes(app, {
      sql: deps.sql,
      actionSecret: deps.actionSecret,
      appUrl: deps.appUrl ?? 'https://app.noctiv.io',
    });
  }
  return app;
}
