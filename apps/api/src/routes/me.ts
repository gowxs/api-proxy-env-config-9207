import { randomUUID } from 'node:crypto';
import { withTenant } from '@noctiv/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { HttpError, isTimezone } from './web.ts';

const createBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    websiteUrl: z.url().max(500).nullable().optional(),
    timezone: z.string().refine(isTimezone, 'unknown time zone'),
    inviteCode: z.string().trim().max(100).optional(),
  })
  .strict();

/** Standard VAT rate and currency by time zone, for new businesses (QA 2026-09-26). */
const LOCAL_DEFAULTS: Record<string, { currency: string; vatRate: number }> = {
  'Europe/London': { currency: 'GBP', vatRate: 20 },
  'Europe/Dublin': { currency: 'EUR', vatRate: 23 },
  'Europe/Berlin': { currency: 'EUR', vatRate: 19 },
  'Europe/Vienna': { currency: 'EUR', vatRate: 20 },
  'Europe/Paris': { currency: 'EUR', vatRate: 20 },
  'Europe/Amsterdam': { currency: 'EUR', vatRate: 21 },
  'Europe/Brussels': { currency: 'EUR', vatRate: 21 },
  'Europe/Madrid': { currency: 'EUR', vatRate: 21 },
  'Europe/Rome': { currency: 'EUR', vatRate: 22 },
  'Europe/Riga': { currency: 'EUR', vatRate: 21 },
  'Europe/Vilnius': { currency: 'EUR', vatRate: 21 },
  'Europe/Tallinn': { currency: 'EUR', vatRate: 24 },
  'Europe/Helsinki': { currency: 'EUR', vatRate: 25.5 },
};

export interface MeDeps extends AppDeps {
  /** Phase 1 signup gate (PLAN.md Q12): creating an account needs one of these codes. Empty = open (dev). */
  inviteCodes: string[];
}

export function meRoutes(app: FastifyInstance, deps: MeDeps): void {
  app.get('/v1/me', async (req) => {
    const user = req.user!;
    const tenants = await deps.sql<{ tenant_id: string; name: string }[]>`
      select tenant_id, name from app.user_tenants(${user.userId})`;
    const withState = await Promise.all(
      tenants.map((t) =>
        withTenant(deps.sql, t.tenant_id, async (tx) => {
          const [s] = await tx<
            {
              onboarding_completed_at: Date | null;
              website_url: string | null;
              mailboxes: number;
              kb_sources: number;
            }[]
          >`
            select t.onboarding_completed_at, t.website_url,
                   (select count(*) from public.email_connections)::int as mailboxes,
                   (select count(*) from public.kb_sources)::int as kb_sources
            from public.tenants t`;
          return { id: t.tenant_id, name: t.name, ...s };
        }),
      ),
    );
    return {
      userId: user.userId,
      email: user.email ?? null,
      inviteRequired: deps.inviteCodes.length > 0,
      tenants: withState,
    };
  });

  /**
   * "Delete all data" (GDPR hard delete). The owner types the business name;
   * the tenant stops at once and the worker erases everything.
   */
  app.delete('/v1/tenants/:tenantId', async (req, reply) => {
    const { tenantId } = z.object({ tenantId: z.uuid() }).parse(req.params);
    const { confirmName } = z
      .object({ confirmName: z.string() })
      .strict()
      .parse(req.body ?? {});
    await deps.requireMember(tenantId, req.user!.userId);
    const [t] = await withTenant(
      deps.sql,
      tenantId,
      (tx) =>
        tx<{ name: string; paddle_subscription_id: string | null; billing_status: string }[]>`
          select name, paddle_subscription_id, billing_status from public.tenants`,
    );
    if (!t || confirmName.trim() !== t.name.trim())
      throw new HttpError(400, 'Type the business name exactly as shown to confirm.');
    const [r] = await deps.sql<{ ok: boolean }[]>`
      select app.request_tenant_deletion(${tenantId}, ${req.user!.userId}) as ok`;
    if (!r?.ok) throw new HttpError(403, 'Only an owner can delete the account.');
    // No more charges for a deleted business.
    if (t.paddle_subscription_id && t.billing_status !== 'canceled') {
      if (!deps.paddle) {
        req.log.error(
          { tenantId },
          'deleted tenant has a subscription but Paddle is not configured',
        );
      } else {
        await deps.paddle
          .cancelNow(t.paddle_subscription_id)
          .catch((err: Error) =>
            req.log.error(
              { tenantId, err: { message: err.message } },
              'cancel subscription after deletion failed; cancel it in the Paddle dashboard',
            ),
          );
      }
    }
    return reply.code(202).send({ status: 'deleting' });
  });

  /** Onboarding step 1: the business. New accounts always start in draft-only mode. */
  app.post('/v1/tenants', async (req, reply) => {
    const user = req.user!;
    const b = createBody.parse(req.body);
    if (deps.inviteCodes.length && !deps.inviteCodes.includes(b.inviteCode ?? ''))
      throw new HttpError(
        403,
        'That invite code is not valid. Noctiv is invite-only during early access: ask us for a code at contact@noctiv.io.',
      );
    const existing = await deps.sql`select 1 from app.user_tenants(${user.userId})`;
    if (existing.length) throw new HttpError(409, 'You already have a business account.');
    const id = randomUUID();
    await withTenant(deps.sql, id, async (tx) => {
      // Currency and standard VAT rate of the business's country, guessed from its
      // time zone (the owner can change both in Quotes → Setup).
      const local = LOCAL_DEFAULTS[b.timezone];
      await tx`insert into public.tenants (id, name, website_url, timezone, quotes_currency, quotes_vat_rate)
               values (${id}, ${b.name}, ${b.websiteUrl ?? null}, ${b.timezone},
                       ${local?.currency ?? 'EUR'}, ${local?.vatRate ?? 21})`;
      await tx`insert into public.tenant_members (tenant_id, user_id, role) values (${id}, ${user.userId}, 'owner')`;
      await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id)
               values (${id}, 'owner', ${user.userId}, 'tenant.created', 'tenant', ${id})`;
    });
    return reply.code(201).send({ id, mode: 'draft_only' });
  });
}
