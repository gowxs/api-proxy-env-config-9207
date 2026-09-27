import { enqueue, withTenant } from '@noctiv/db';
import type { FastifyInstance } from 'fastify';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';
import { HttpError } from './http-error.ts';

/** Queue name shared with the worker (apps/worker/src/queues.ts). */
const ASSISTANT_QUEUE = 'assistant.turn';

const LOCALES = ['en', 'de', 'lv', 'nl', 'fr', 'es'] as const;
const tenantParams = z.object({ tenantId: z.uuid() });
const proposalParams = z.object({ tenantId: z.uuid(), id: z.uuid() });
const purpose = z.enum(['app', 'onboarding']).default('app');

const messageBody = z
  .object({
    text: z.string().trim().min(1).max(2000),
    locale: z.enum(LOCALES).default('en'),
    purpose,
    conversationId: z.uuid().nullable().optional(),
    contextPath: z.string().max(200).nullable().optional(),
  })
  .strict();

const ERRORS: Record<string, string> = {
  budget_halted: 'The daily AI budget is used up. The assistant is back tomorrow.',
  free_tier_refused:
    'The assistant is not available on the current AI plan yet. Everything else works as usual; set up manually for now.',
  model_error: 'The assistant could not answer right now. Try again in a moment.',
  invalid_output: 'The assistant could not answer that. Try asking another way.',
};

/** Owner messages per business and day: the assistant is a helper, not a chat service. */
const DAILY_MESSAGES = 200;

/** How long the send request waits for the answer before the app polls for it. */
const WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Row {
  id: string;
  role: 'owner' | 'assistant';
  text: string;
  suggestions: string[];
  created_at: Date;
}
interface ProposalRow {
  id: string;
  message_id: string;
  type: string;
  title: string;
  payload: Record<string, unknown>;
  requires_confirmation: boolean;
  status: string;
  error: string | null;
}

async function withProposals(tx: TransactionSql, rows: Row[]) {
  if (!rows.length) return [];
  const ps = await tx<ProposalRow[]>`
    select id, message_id, type, title, payload, requires_confirmation, status, error
    from public.assistant_proposals where message_id in ${tx(rows.map((r) => r.id))}
    order by created_at`;
  return rows.map((r) => ({
    ...r,
    proposals: ps.filter((p) => p.message_id === r.id).map(({ message_id: _m, ...p }) => p),
  }));
}

/**
 * Noctiv Assistant (beta), PLAN.md §27. The worker answers (read-only tools
 * and the model); the API stores the owner's messages and applies a proposal
 * only when the owner confirms it — through the same routes and validation
 * as the Settings, Knowledge and Price list pages, with the owner's own
 * authorisation. Sending-related changes need the confirmation dialog.
 */
export function assistantRoutes(app: FastifyInstance, deps: AppDeps) {
  const member = async (req: { params: unknown; user?: { userId: string } }) => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    return tenantId;
  };

  /** The owner's latest conversation (per purpose) with its messages and proposals. */
  app.get('/v1/tenants/:tenantId/assistant', async (req) => {
    const tenantId = await member(req);
    const q = z.object({ purpose }).parse(req.query);
    return withTenant(deps.sql, tenantId, async (tx) => {
      const [c] = await tx<{ id: string; locale: string; purpose: string }[]>`
        select id, locale, purpose from public.assistant_conversations
        where user_id = ${req.user!.userId} and purpose = ${q.purpose}
        order by updated_at desc limit 1`;
      if (!c) return { conversation: null, messages: [] };
      const rows = await tx<Row[]>`
        select id, role, text, suggestions, created_at from (
          select id, role, text, suggestions, created_at from public.assistant_messages
          where conversation_id = ${c.id} order by created_at desc limit 100) m
        order by created_at`;
      return { conversation: c, messages: await withProposals(tx, rows) };
    });
  });

  app.post('/v1/tenants/:tenantId/assistant/new', async (req) => {
    const tenantId = await member(req);
    const b = z.object({ purpose, locale: z.enum(LOCALES).optional() }).parse(req.body ?? {});
    const [c] = await withTenant(
      deps.sql,
      tenantId,
      (tx) => tx<{ id: string }[]>`
        insert into public.assistant_conversations (tenant_id, user_id, locale, purpose)
        values (${tenantId}, ${req.user!.userId}, ${b.locale ?? 'en'}, ${b.purpose}) returning id`,
    );
    return { conversationId: c!.id };
  });

  app.post('/v1/tenants/:tenantId/assistant/messages', async (req, reply) => {
    const tenantId = await member(req);
    const b = messageBody.parse(req.body);
    const userId = req.user!.userId;
    const started = await withTenant(deps.sql, tenantId, async (tx) => {
      const [count] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.assistant_messages
        where role = 'owner' and created_at > now() - interval '1 day'`;
      if (count!.n >= DAILY_MESSAGES)
        throw new HttpError(429, 'That is enough for today: the assistant is back tomorrow.');
      let conv = b.conversationId
        ? (
            await tx<{ id: string; locale: string; purpose: string }[]>`
              select id, locale, purpose from public.assistant_conversations
              where id = ${b.conversationId} and user_id = ${userId}`
          )[0]
        : undefined;
      if (b.conversationId && !conv) throw new HttpError(404, 'Conversation not found.');
      conv ??= (
        await tx<{ id: string; locale: string; purpose: string }[]>`
          insert into public.assistant_conversations (tenant_id, user_id, locale, purpose)
          values (${tenantId}, ${userId}, ${b.locale}, ${b.purpose}) returning id, locale, purpose`
      )[0]!;
      const [m] = await tx<Row[]>`
        insert into public.assistant_messages (tenant_id, conversation_id, role, text, context_path)
        values (${tenantId}, ${conv.id}, 'owner', ${b.text}, ${b.contextPath ?? null})
        returning id, role, text, suggestions, created_at`;
      const jobId = await enqueue(tx, {
        tenantId,
        queue: ASSISTANT_QUEUE,
        payload: { conversationId: conv.id },
        maxAttempts: 1,
      });
      return { conv, owner: { ...m!, proposals: [] }, jobId: jobId! };
    });
    // A quick answer comes back on this request; a slow one (several model calls) is
    // fetched with GET .../assistant/turns/:jobId, so no proxy timeout cuts it off.
    const deadline = Date.now() + (deps.assistantWaitMs ?? WAIT_MS);
    for (;;) {
      const r = await turnResult(tenantId, userId, started.jobId);
      if (r.kind !== 'pending' || Date.now() >= deadline) {
        if (r.kind === 'pending')
          return reply.code(202).send({
            pending: true,
            jobId: started.jobId,
            conversation: started.conv,
            messages: [started.owner],
          });
        if (r.kind === 'error')
          return reply.code(422).send({ ...r.body, ownerMessage: started.owner });
        return { ...r.body, messages: [started.owner, ...r.body.messages] };
      }
      await sleep(400);
    }
  });

  /** A turn that took longer than the send request waited. */
  app.get('/v1/tenants/:tenantId/assistant/turns/:jobId', async (req, reply) => {
    const { tenantId, jobId } = z.object({ tenantId: z.uuid(), jobId: z.uuid() }).parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    const r = await turnResult(tenantId, req.user!.userId, jobId);
    if (r.kind === 'pending') return reply.code(202).send({ pending: true, jobId });
    if (r.kind === 'error') return reply.code(422).send(r.body);
    return r.body;
  });

  type Turn =
    | { kind: 'pending' }
    | { kind: 'error'; body: { error: string; code: string } }
    | { kind: 'done'; body: { conversation: unknown; messages: unknown[] } };
  const turnResult = (tenantId: string, userId: string, jobId: string): Promise<Turn> =>
    withTenant(deps.sql, tenantId, async (tx) => {
      const [job] = await tx<
        { queue: string; status: string; result: unknown; payload: { conversationId?: string } }[]
      >`select queue, status, result, payload from public.jobs where id = ${jobId}`;
      const conversationId = job?.payload?.conversationId;
      const [conv] =
        job?.queue === ASSISTANT_QUEUE && conversationId
          ? await tx<{ id: string; locale: string; purpose: string }[]>`
              select id, locale, purpose from public.assistant_conversations
              where id = ${conversationId} and user_id = ${userId}`
          : [];
      if (!job || !conv) throw new HttpError(404, 'Not found.');
      if (job.status === 'dead' || job.status === 'failed')
        return { kind: 'error', body: { error: ERRORS.model_error!, code: 'model_error' } };
      if (job.status !== 'done') return { kind: 'pending' };
      const r = job.result as { ok: boolean; error?: string; messageId?: string };
      if (!r.ok) {
        const code = r.error && ERRORS[r.error] ? r.error : 'model_error';
        return { kind: 'error', body: { error: ERRORS[code]!, code } };
      }
      const rows = await tx<Row[]>`
        select id, role, text, suggestions, created_at from public.assistant_messages
        where id = ${r.messageId!}`;
      return {
        kind: 'done',
        body: { conversation: conv, messages: await withProposals(tx, rows) },
      };
    });

  const decided = async (tenantId: string, id: string) =>
    withTenant(deps.sql, tenantId, async (tx) => {
      const [p] = await tx<ProposalRow[]>`
        select id, message_id, type, title, payload, requires_confirmation, status, error
        from public.assistant_proposals where id = ${id}`;
      const { message_id: _m, ...rest } = p!;
      return { proposal: rest };
    });

  app.post('/v1/tenants/:tenantId/assistant/proposals/:id/dismiss', async (req) => {
    const { tenantId, id } = proposalParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    await withTenant(deps.sql, tenantId, async (tx) => {
      const r = await tx`update public.assistant_proposals
                         set status = 'dismissed', decided_by = ${req.user!.userId}, decided_at = now()
                         where id = ${id} and status = 'proposed' returning id`;
      if (!r.length) throw new HttpError(409, 'This proposal was already decided.');
      await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id)
               values (${tenantId}, 'owner', ${req.user!.userId}, 'assistant.dismissed', 'assistant_proposal', ${id})`;
    });
    return decided(tenantId, id);
  });

  /**
   * Confirm: applied through the same routes as the pages (inject, with the
   * owner's own token), so validation, side effects and audit are identical.
   */
  app.post('/v1/tenants/:tenantId/assistant/proposals/:id/apply', async (req, reply) => {
    const { tenantId, id } = proposalParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    const b = z
      .object({ confirmSending: z.boolean().optional() })
      .strict()
      .parse(req.body ?? {});
    const p = await withTenant(deps.sql, tenantId, async (tx) => {
      const [row] = await tx<ProposalRow[]>`
        select id, message_id, type, title, payload, requires_confirmation, status, error
        from public.assistant_proposals where id = ${id} for update`;
      return row;
    });
    if (!p) throw new HttpError(404, 'Proposal not found.');
    if (p.status !== 'proposed') throw new HttpError(409, 'This proposal was already decided.');
    if (p.requires_confirmation && b.confirmSending !== true)
      return reply.code(409).send({
        error: 'This changes what Noctiv sends on its own: confirm it in the dialog first.',
        needsConfirmation: true,
      });

    const call = (method: 'PATCH' | 'POST', url: string, payload: object) =>
      app.inject({
        method,
        url,
        headers: {
          authorization: req.headers.authorization ?? '',
          'content-type': 'application/json',
        },
        payload: JSON.stringify(payload),
      });
    const base = `/v1/tenants/${tenantId}`;
    let error: string | null = null;
    if (p.type === 'settings') {
      const changes = { ...(p.payload.changes as Record<string, unknown>) };
      if (changes.mode) changes.confirmAutoSend = true;
      const res = await call('PATCH', base, changes);
      if (res.statusCode >= 400) error = errorText(res.body);
    } else if (p.type === 'knowledge_note') {
      const res = await call('POST', `${base}/kb/notes`, {
        title: p.payload.title,
        text: p.payload.text,
      });
      if (res.statusCode >= 400) error = errorText(res.body);
    } else {
      const items = p.payload.items as { name: string; unit: string; unitPriceCents: number }[];
      for (const i of items) {
        const res = await call('POST', `${base}/price-items`, {
          name: i.name,
          unit: i.unit,
          unitPrice: (i.unitPriceCents / 100).toFixed(2),
        });
        if (res.statusCode >= 400) {
          error = `${i.name}: ${errorText(res.body)}`;
          break;
        }
      }
    }
    await withTenant(deps.sql, tenantId, async (tx) => {
      await tx`update public.assistant_proposals
               set status = ${error ? 'failed' : 'applied'}, error = ${error?.slice(0, 500) ?? null},
                   decided_by = ${req.user!.userId}, decided_at = now()
               where id = ${id}`;
      await tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
               values (${tenantId}, 'owner', ${req.user!.userId},
                       ${error ? 'assistant.apply_failed' : 'assistant.applied'}, 'assistant_proposal', ${id},
                       ${tx.json({ type: p.type, confirmedSending: b.confirmSending === true })})`;
    });
    return decided(tenantId, id);
  });
}

function errorText(body: string): string {
  try {
    const j = JSON.parse(body) as { error?: string; message?: string };
    return j.error ?? j.message ?? 'Could not apply the change.';
  } catch {
    return 'Could not apply the change.';
  }
}
