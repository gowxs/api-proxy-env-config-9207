import { enqueue, getJob, withTenant } from '@noctiv/db';
import { documentJson, listDocuments } from '@noctiv/documents';
import type { FastifyInstance } from 'fastify';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { HttpError } from './http-error.ts';

/** Queue names shared with the worker (apps/worker/src/queues.ts). */
const MAIL_SEND_QUEUE = 'mail.send';
const COMPOSE_ASSIST_QUEUE = 'compose.assist';

const tenantParams = z.object({ tenantId: z.uuid() });

const composeBody = z
  .object({
    to: z.string().trim().toLowerCase().max(254).pipe(z.email()),
    subject: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(20_000),
    documentIds: z.array(z.uuid()).max(5).default([]),
  })
  .strict();

const assistBody = z
  .object({
    notes: z.string().trim().min(3).max(2000),
    subject: z.string().trim().max(200).nullable().optional(),
    to: z.string().trim().max(254).nullable().optional(),
  })
  .strict();

const ASSIST_ERRORS: Record<string, string> = {
  budget_halted: 'The daily AI budget is used up. Write the e-mail yourself or try tomorrow.',
  free_tier_refused:
    'Writing with AI needs the paid AI provider for real mailboxes. Write the e-mail yourself.',
  model_error: 'The AI could not write a draft right now. Try again in a moment.',
  invalid_output: 'The AI could not write a usable draft. Try again or write it yourself.',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Inbox → New e-mail (PLAN.md §22.13). The owner writes (optionally with AI
 * help from the knowledge base) and sends from the business mailbox; the
 * e-mail starts a new conversation, with a lead for the address, and may
 * carry ready documents as PDFs. The owner's own e-mail: no mode rules.
 */
export function composeRoutes(app: FastifyInstance, deps: AppDeps) {
  const tenantTx = async <T>(
    req: { params: unknown; user?: { userId: string } },
    fn: (tx: TransactionSql, tenantId: string) => Promise<T>,
  ): Promise<T> => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    return withTenant(deps.sql, tenantId, (tx) => fn(tx, tenantId));
  };

  /** What the form needs: the sending mailbox and the documents that can be attached. */
  app.get('/v1/tenants/:tenantId/compose', (req) =>
    tenantTx(req, async (tx) => {
      const [conn] = await tx<{ email_address: string; display_name: string | null }[]>`
        select email_address, display_name from public.email_connections
        where status = 'connected' order by created_at limit 1`;
      const ready = (await listDocuments(tx, {})).filter((d) => d.status === 'issued');
      return {
        from: conn ? { address: conn.email_address, name: conn.display_name } : null,
        documents: ready.map(documentJson),
      };
    }),
  );

  app.post('/v1/tenants/:tenantId/compose', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = composeBody.parse(req.body);
      const [conn] = await tx<{ id: string; email_address: string }[]>`
        select id, email_address from public.email_connections
        where status = 'connected' order by created_at limit 1`;
      if (!conn) throw new HttpError(409, 'Connect a mailbox first: e-mails are sent from it.');
      const own =
        await tx`select 1 from public.email_connections where lower(email_address) = ${b.to}`;
      if (own.length) throw new HttpError(400, 'That is your own mailbox address.');
      const docIds = [...new Set(b.documentIds)];
      if (docIds.length) {
        const docs = await tx<{ id: string; status: string; draft_id: string | null }[]>`
          select id, status, draft_id from public.documents where id in ${tx(docIds)} for update`;
        if (docs.length !== docIds.length) throw new HttpError(404, 'A document was not found.');
        if (docs.some((d) => d.status !== 'issued'))
          throw new HttpError(409, 'Only ready documents can be attached.');
        const pending = docs.filter((d) => d.draft_id);
        if (pending.length) {
          const busy = await tx`
            select 1 from public.drafts
            where id in ${tx(pending.map((d) => d.draft_id!))} and status in ('pending_approval', 'approved')`;
          if (busy.length)
            throw new HttpError(409, 'A document is already on its way in another e-mail.');
        }
      }

      const [lead] = await tx<{ id: string; created: boolean }[]>`
        insert into public.leads (tenant_id, email) values (${tenantId}, ${b.to})
        on conflict (tenant_id, email) do update set stage = leads.stage
        returning id, (xmax = 0) as created`;
      if (lead!.created)
        await tx`insert into public.lead_events (tenant_id, lead_id, to_stage, actor, actor_user_id, reason)
                 values (${tenantId}, ${lead!.id}, 'received', 'owner', ${req.user!.userId}, 'new e-mail from the inbox')`;
      const [thread] = await tx<{ id: string }[]>`
        insert into public.threads (tenant_id, connection_id, lead_id, subject)
        values (${tenantId}, ${conn.id}, ${lead!.id}, ${b.subject})
        returning id`;
      const [draft] = await tx<{ id: string }[]>`
        insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                                   status, decided_by, decided_at)
        values (${tenantId}, ${thread!.id}, null, 'compose', ${b.to}, ${b.subject}, ${b.body},
                'approved', 'owner', now())
        returning id`;
      if (docIds.length)
        await tx`update public.documents
                 set draft_id = ${draft!.id}, thread_id = coalesce(thread_id, ${thread!.id}),
                     lead_id = coalesce(lead_id, ${lead!.id})
                 where id in ${tx(docIds)}`;
      await enqueue(tx, {
        tenantId,
        queue: MAIL_SEND_QUEUE,
        payload: { draftId: draft!.id, sentVia: 'owner_approval' },
        singletonKey: draft!.id,
      });
      await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
               values (${tenantId}, 'owner', ${req.user!.userId}, 'email.composed', 'draft', ${draft!.id},
                       ${tx.json({ threadId: thread!.id, documents: docIds.length })})`;
      return { threadId: thread!.id, draftId: draft!.id };
    }),
  );

  /** "Write with AI": the worker drafts from the owner's notes and the knowledge base. */
  app.post('/v1/tenants/:tenantId/compose/assist', async (req, reply) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    const b = assistBody.parse(req.body);
    const jobId = await withTenant(deps.sql, tenantId, (tx) =>
      enqueue(tx, {
        tenantId,
        queue: COMPOSE_ASSIST_QUEUE,
        payload: { notes: b.notes, subject: b.subject ?? null, to: b.to ?? null },
        maxAttempts: 1,
      }),
    );
    const deadline = Date.now() + Math.max(deps.connectionTestWaitMs, 20_000);
    while (Date.now() < deadline) {
      const job = await withTenant(deps.sql, tenantId, (tx) => getJob(tx, jobId!));
      if (job?.status === 'done') {
        const r = job.result as { ok: boolean; error?: string } & Record<string, unknown>;
        if (!r.ok)
          return reply
            .code(422)
            .send({ error: ASSIST_ERRORS[r.error ?? ''] ?? ASSIST_ERRORS.model_error });
        return reply.send(r);
      }
      if (job?.status === 'dead' || job?.status === 'failed')
        return reply.code(422).send({ error: ASSIST_ERRORS.model_error });
      await sleep(300);
    }
    return reply.code(504).send({ error: 'The AI is taking too long. Try again in a moment.' });
  });
}
