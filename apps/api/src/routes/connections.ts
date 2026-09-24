import { randomUUID } from 'node:crypto';
import { enqueue, getJob, withTenant } from '@noctiv/db';
import {
  isUnsupportedProvider,
  MAIL_ERROR_MESSAGES,
  resolveSettings,
  sealMailboxPassword,
  type ConnectionTestResult,
  type MailServerSettings,
} from '@noctiv/mail';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';

export const CONNECTION_TEST_QUEUE = 'connection.test';

const serverSchema = {
  imap: z
    .object({
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      secure: z.boolean(),
    })
    .optional(),
  smtp: z
    .object({
      host: z.string().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      security: z.enum(['tls', 'starttls']),
    })
    .optional(),
};

const testBody = z.object({
  provider: z.enum(['gmail', 'google_workspace', 'yahoo', 'hostinger', 'outlook', 'generic']),
  emailAddress: z.email().max(254),
  username: z.string().min(1).max(254).optional(),
  password: z.string().min(1).max(512),
  displayName: z.string().max(200).optional(),
  ...serverSchema,
});

const saveBody = z.object({ testId: z.uuid() });
const tenantParams = z.object({ tenantId: z.uuid() });

interface TestJobPayload {
  connectionId: string;
  settings: MailServerSettings;
  displayName: string | null;
  sealed: string;
  keyId: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function connectionRoutes(app: FastifyInstance, deps: AppDeps): void {
  /**
   * Live test from the wizard. The password is sealed immediately with the
   * worker's public key (the API cannot decrypt it) and handed to the worker
   * through the job queue; the API waits briefly for the worker's verdict.
   */
  app.post('/v1/tenants/:tenantId/connections/test', async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const body = testBody.parse(req.body);
    await deps.requireMember(tenantId, req.user!.userId);

    if (isUnsupportedProvider(body.provider, body.emailAddress)) {
      return reply.send({
        status: 'failed',
        code: 'PROVIDER_UNSUPPORTED',
        stage: 'config',
        message: MAIL_ERROR_MESSAGES.PROVIDER_UNSUPPORTED,
      });
    }
    let settings: MailServerSettings;
    try {
      settings = resolveSettings(body);
    } catch {
      return reply
        .code(400)
        .send({ error: 'imap and smtp settings are required for this provider' });
    }
    const connectionId = randomUUID();
    const { ciphertext, keyId } = sealMailboxPassword(
      body.password,
      deps.credentialsPublicKey,
      tenantId,
      connectionId,
    );
    const payload: TestJobPayload = {
      connectionId,
      settings,
      displayName: body.displayName ?? null,
      sealed: ciphertext.toString('base64'),
      keyId,
    };
    const jobId = await withTenant(deps.sql, tenantId, (tx) =>
      enqueue(tx, {
        tenantId,
        queue: CONNECTION_TEST_QUEUE,
        payload: payload as never,
        maxAttempts: 1,
      }),
    );

    const deadline = Date.now() + deps.connectionTestWaitMs;
    while (Date.now() < deadline) {
      const job = await withTenant(deps.sql, tenantId, (tx) => getJob(tx, jobId!));
      if (job?.status === 'done') {
        const result = job.result as ConnectionTestResult;
        return reply.send(
          result.ok
            ? { status: 'ok', testId: jobId, sentAppendMode: result.sentAppendMode }
            : { status: 'failed', ...result },
        );
      }
      if (job?.status === 'dead' || job?.status === 'failed') {
        return reply.send({
          status: 'failed',
          code: 'UNKNOWN',
          stage: 'config',
          message: MAIL_ERROR_MESSAGES.UNKNOWN,
        });
      }
      await sleep(250);
    }
    return reply.code(202).send({ status: 'pending', testId: jobId });
  });

  /** Saves a mailbox that passed the live test; the sealed password comes from the test job. */
  app.post('/v1/tenants/:tenantId/connections', async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    const { testId } = saveBody.parse(req.body);
    const userId = req.user!.userId;
    await deps.requireMember(tenantId, userId);

    const outcome = await withTenant(deps.sql, tenantId, async (tx) => {
      const [job] = await tx<
        {
          queue: string;
          status: string;
          payload: TestJobPayload;
          result: ConnectionTestResult | null;
        }[]
      >`
        select queue, status, payload, result from public.jobs where id = ${testId}`;
      if (!job || job.queue !== CONNECTION_TEST_QUEUE) return { code: 404 as const };
      if (job.status !== 'done' || !job.result?.ok)
        return { code: 409 as const, error: 'connection test has not passed' };
      const p = job.payload;
      const r = job.result;
      const inserted = await tx`
        insert into public.email_connections
          (id, tenant_id, provider, email_address, display_name, imap_host, imap_port, imap_secure,
           smtp_host, smtp_port, smtp_security, username, credentials_ciphertext, credentials_key_id,
           status, last_checked_at, last_ok_at, inbox_uidvalidity, inbox_last_uid, sent_folder_path, sent_append_mode)
        values (${p.connectionId}, ${tenantId}, ${p.settings.provider}, ${p.settings.emailAddress}, ${p.displayName},
                ${p.settings.imap.host}, ${p.settings.imap.port}, ${p.settings.imap.secure},
                ${p.settings.smtp.host}, ${p.settings.smtp.port}, ${p.settings.smtp.security}, ${p.settings.username},
                ${Buffer.from(p.sealed, 'base64')}, ${p.keyId},
                'connected', now(), now(), ${r.uidValidity}, ${r.baselineUid}, ${r.sentFolder}, ${r.sentAppendMode})
        on conflict do nothing
        returning id`;
      if (inserted.length === 0)
        return { code: 409 as const, error: 'this mailbox is already connected' };
      await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id)
               values (${tenantId}, 'owner', ${userId}, 'connection.created', 'email_connection', ${p.connectionId})`;
      return { code: 201 as const, id: p.connectionId };
    });
    if (outcome.code !== 201)
      return reply.code(outcome.code).send({ error: outcome.error ?? 'not found' });
    return reply.code(201).send({ id: outcome.id, status: 'connected' });
  });

  app.get('/v1/tenants/:tenantId/connections', async (req) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    return withTenant(
      deps.sql,
      tenantId,
      (tx) => tx`
      select id, provider, email_address, display_name, status, last_error_code, last_checked_at, last_ok_at, is_test_mailbox
      from public.email_connections order by created_at`,
    );
  });
}
