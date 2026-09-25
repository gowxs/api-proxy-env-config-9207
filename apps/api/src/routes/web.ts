import { budgetStateFor, TENANT_MODES, type TenantMode } from '@noctiv/core';
import { enqueue, withTenant } from '@noctiv/db';
import {
  BlockedUrlError,
  createFileSource,
  createNoteSource,
  createWebsiteSource,
  UploadRejectedError,
} from '@noctiv/kb';
import { MAIL_ERROR_MESSAGES, type MailErrorCode } from '@noctiv/mail';
import type { FastifyInstance } from 'fastify';
import type { TransactionSql } from 'postgres';
import { z } from 'zod';
import type { AppDeps } from '../app.ts';

/** Queue names shared with the worker (apps/worker/src/queues.ts). */
const MAIL_SEND_QUEUE = 'mail.send';
const KB_INGEST_QUEUE = 'kb.ingest';

const tenantParams = z.object({ tenantId: z.uuid() });
const idParams = z.object({ tenantId: z.uuid(), id: z.uuid() });

export const isTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const LEAD_STAGES = [
  'received',
  'drafted',
  'sent',
  'followed_up',
  'replied',
  'converted',
  'escalated',
] as const;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** 1 approve everything, 2 auto-reply to grounded questions, 3 fully automatic. */
const modeRank = (m: TenantMode) => TENANT_MODES.indexOf(m);

const settingsBody = z
  .object({
    name: z.string().trim().min(1).max(200),
    websiteUrl: z.url().max(500).nullable(),
    timezone: z.string().refine(isTimezone, 'unknown time zone'),
    mode: z.enum(TENANT_MODES),
    /**
     * Required, and true, to move to a more automatic mode (1 → 2, 1 → 3, 2 → 3):
     * the explicit confirmation in the UI. Moving back needs none.
     */
    confirmAutoSend: z.literal(true).optional(),
    notifyFullText: z.boolean(),
    followupAfterDays: z.number().int().min(1).max(30),
    followupMax: z.number().int().min(0).max(2),
    maxRepliesPerHour: z.number().int().min(1).max(500),
    maxAiRepliesPerSender24h: z.number().int().min(0).max(2),
    retentionDays: z.number().int().min(1).max(3650),
    replySignature: z.string().max(1000).nullable(),
    onboardingCompleted: z.literal(true),
  })
  .partial()
  .strict();

const draftBody = z.object({ body: z.string().trim().min(1).max(20_000) }).strict();
const approveBody = z.object({ body: z.string().trim().min(1).max(20_000).optional() }).strict();
const leadBody = z
  .object({
    stage: z.enum(LEAD_STAGES),
    name: z.string().trim().max(200).nullable(),
    notes: z.string().max(5_000).nullable(),
  })
  .partial()
  .strict();

/**
 * Dashboard endpoints (step 12). Every route checks membership, then works
 * inside the tenant's RLS context. The browser never talks to the database.
 */
export function webRoutes(app: FastifyInstance, deps: AppDeps): void {
  const tenantTx = async <T>(
    req: { params: unknown; user?: { userId: string } },
    fn: (tx: TransactionSql, tenantId: string) => Promise<T>,
  ): Promise<T> => {
    const { tenantId } = tenantParams.parse(req.params);
    await deps.requireMember(tenantId, req.user!.userId);
    return withTenant(deps.sql, tenantId, (tx) => fn(tx, tenantId));
  };
  const audit = (
    tx: TransactionSql,
    tenantId: string,
    userId: string,
    action: string,
    targetType: string,
    targetId: string | null,
    metadata: Record<string, unknown> = {},
  ) => tx`insert into public.audit_log (tenant_id, actor, actor_user_id, action, target_type, target_id, metadata)
          values (${tenantId}, 'owner', ${userId}, ${action}, ${targetType}, ${targetId}, ${tx.json(metadata as never)})`;

  // ---------------------------------------------------------------- tenant
  app.get('/v1/tenants/:tenantId', (req) =>
    tenantTx(req, async (tx) => {
      const [t] = await tx`
        select id, name, website_url, timezone, mode, notify_full_text, budget_state, daily_token_budget,
               max_replies_per_hour, max_ai_replies_per_sender_24h, followup_after_days, followup_max,
               retention_days, reply_signature, onboarding_completed_at, created_at
        from public.tenants`;
      return t;
    }),
  );

  app.patch('/v1/tenants/:tenantId', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = settingsBody.parse(req.body);
      const [cur] = await tx<{ mode: TenantMode }[]>`select mode from public.tenants for update`;
      if (b.mode && modeRank(b.mode) > modeRank(cur!.mode)) {
        if (b.confirmAutoSend !== true)
          throw new HttpError(400, 'switching to automatic sending needs explicit confirmation');
        const conn =
          await tx`select 1 from public.email_connections where status = 'connected' limit 1`;
        if (!conn.length)
          throw new HttpError(409, 'connect a mailbox before enabling automatic sending');
      }
      const cols: Record<string, unknown> = {};
      if (b.name !== undefined) cols.name = b.name;
      if (b.websiteUrl !== undefined) cols.website_url = b.websiteUrl;
      if (b.timezone !== undefined) cols.timezone = b.timezone;
      if (b.mode !== undefined) cols.mode = b.mode;
      if (b.notifyFullText !== undefined) cols.notify_full_text = b.notifyFullText;
      if (b.followupAfterDays !== undefined) cols.followup_after_days = b.followupAfterDays;
      if (b.followupMax !== undefined) cols.followup_max = b.followupMax;
      if (b.maxRepliesPerHour !== undefined) cols.max_replies_per_hour = b.maxRepliesPerHour;
      if (b.maxAiRepliesPerSender24h !== undefined)
        cols.max_ai_replies_per_sender_24h = b.maxAiRepliesPerSender24h;
      if (b.retentionDays !== undefined) cols.retention_days = b.retentionDays;
      if (b.replySignature !== undefined) cols.reply_signature = b.replySignature?.trim() || null;
      if (b.onboardingCompleted) cols.onboarding_completed_at = new Date();
      if (Object.keys(cols).length) {
        await tx`update public.tenants set ${tx(cols)} where id = ${tenantId}`;
        await audit(tx, tenantId, req.user!.userId, 'settings.updated', 'tenant', tenantId, {
          fields: Object.keys(cols),
          ...(b.mode && b.mode !== cur!.mode ? { mode: b.mode } : {}),
        });
      }
      return { ok: true };
    }),
  );

  // ------------------------------------------------------------- dashboard
  app.get('/v1/tenants/:tenantId/dashboard', (req) =>
    tenantTx(req, async (tx) => {
      const [t] = await tx<
        {
          timezone: string;
          mode: string;
          budget_state: string;
          daily_token_budget: number;
        }[]
      >`select timezone, mode, budget_state, daily_token_budget from public.tenants`;
      const tz = t!.timezone;
      const connections = await tx<
        {
          id: string;
          email_address: string;
          provider: string;
          status: string;
          last_error_code: string | null;
          last_checked_at: Date | null;
          last_ok_at: Date | null;
          is_test_mailbox: boolean;
        }[]
      >`select id, email_address, provider, status, last_error_code, last_checked_at, last_ok_at, is_test_mailbox
        from public.email_connections order by created_at`;
      const [today] = await tx<
        {
          received: number;
          skipped: number;
          auto_sent: number;
          approved_sent: number;
          escalated: number;
        }[]
      >`
        with day as (select (now() at time zone ${tz})::date as d)
        select
          (select count(*) from public.messages m, day where m.direction = 'inbound'
             and (m.received_at at time zone ${tz})::date = day.d)::int as received,
          (select count(*) from public.message_processing p, day where p.status = 'skipped'
             and (p.created_at at time zone ${tz})::date = day.d)::int as skipped,
          (select count(*) from public.outbound_emails o, day where o.status = 'sent' and o.sent_via = 'auto'
             and (o.sent_at at time zone ${tz})::date = day.d)::int as auto_sent,
          (select count(*) from public.outbound_emails o, day where o.status = 'sent' and o.sent_via = 'owner_approval'
             and (o.sent_at at time zone ${tz})::date = day.d)::int as approved_sent,
          (select count(*) from public.escalations e, day
             where (e.created_at at time zone ${tz})::date = day.d)::int as escalated`;
      const [open] = await tx<{ awaiting_approval: number; open_escalations: number }[]>`
        select (select count(*) from public.drafts where status = 'pending_approval')::int as awaiting_approval,
               (select count(*) from public.escalations where resolved_at is null)::int as open_escalations`;
      const [usage] = await tx<{ tokens: string; llm_calls: number; cost: string }[]>`
        select coalesce(tokens_in + tokens_out + embed_tokens, 0)::text as tokens, llm_calls,
               est_cost_micro_eur::text as cost
        from public.usage_daily where day = (now() at time zone 'utc')::date`;
      const kb = await tx<{ status: string; n: number }[]>`
        select status, count(*)::int as n from public.kb_sources group by status`;
      return {
        mode: t!.mode,
        timezone: tz,
        connections: connections.map((c) => ({
          ...c,
          error_message: c.last_error_code
            ? (MAIL_ERROR_MESSAGES[c.last_error_code as MailErrorCode] ??
              MAIL_ERROR_MESSAGES.UNKNOWN)
            : null,
        })),
        today,
        open,
        budget: {
          // Computed from today's usage: the stored state lags until the next model call.
          state: budgetStateFor(Number(usage?.tokens ?? 0), t!.daily_token_budget),
          dailyTokens: t!.daily_token_budget,
          usedTokens: Number(usage?.tokens ?? 0),
          llmCalls: usage?.llm_calls ?? 0,
          estCostEur: Number(usage?.cost ?? 0) / 1_000_000,
        },
        knowledge: Object.fromEntries(kb.map((k) => [k.status, k.n])),
      };
    }),
  );

  // --------------------------------------------------------- conversations
  app.get('/v1/tenants/:tenantId/conversations', (req) =>
    tenantTx(req, async (tx) => {
      const q = z
        .object({ filter: z.enum(['needs_action', 'all']).default('all') })
        .parse(req.query);
      return tx`
        select th.id, th.subject, th.status, th.last_inbound_at, th.last_outbound_at, th.followups_sent,
               th.next_followup_at, th.followup_stop_reason, th.created_at,
               l.email as customer_email, l.name as customer_name, l.stage as lead_stage,
               (select count(*) from public.drafts d where d.thread_id = th.id and d.status in ('pending_approval', 'suggestion'))::int as pending_drafts,
               (select count(*) from public.escalations e where e.thread_id = th.id and e.resolved_at is null)::int as open_escalations,
               (select left(m.body_text, 160) from public.messages m where m.thread_id = th.id and m.direction = 'inbound'
                  order by m.received_at desc limit 1) as preview
        from public.threads th
        left join public.leads l on l.id = th.lead_id
        where ${
          q.filter === 'needs_action'
            ? tx`exists (select 1 from public.drafts d where d.thread_id = th.id and d.status in ('pending_approval', 'suggestion'))
                 or exists (select 1 from public.escalations e where e.thread_id = th.id and e.resolved_at is null)`
            : tx`true`
        }
        order by coalesce(th.last_inbound_at, th.created_at) desc
        limit 100`;
    }),
  );

  app.get('/v1/tenants/:tenantId/conversations/:id', (req) =>
    tenantTx(req, async (tx) => {
      const { id } = idParams.parse(req.params);
      const [thread] = await tx`
        select th.id, th.subject, th.status, th.followups_sent, th.next_followup_at, th.followup_stop_reason,
               th.last_inbound_at, th.last_outbound_at, th.lead_id, l.email as customer_email, l.name as customer_name,
               l.stage as lead_stage, c.email_address as mailbox
        from public.threads th
        left join public.leads l on l.id = th.lead_id
        join public.email_connections c on c.id = th.connection_id
        where th.id = ${id}`;
      if (!thread) throw new HttpError(404, 'not found');
      const messages = await tx`
        select m.id, m.direction, m.from_address, m.from_name, m.to_addresses, m.subject, m.body_text, m.received_at,
               m.body_purged_at, p.status as processing_status, p.final_action, p.downgrade_reasons, p.skip_reason,
               p.classification->>'summary' as summary
        from public.messages m left join public.message_processing p on p.message_id = m.id
        where m.thread_id = ${id} order by m.received_at`;
      const drafts = await tx`
        select id, kind, status, to_address, subject, body, edited, decided_by, decided_at, created_at, source_message_id
        from public.drafts where thread_id = ${id} order by created_at`;
      const escalations = await tx`
        select id, category, reason, summary, suggestion_draft_id, resolved_at, created_at
        from public.escalations where thread_id = ${id} order by created_at`;
      return { thread, messages, drafts, escalations };
    }),
  );

  /** Where a draft or escalation lives (links in owner emails point here). */
  app.get('/v1/tenants/:tenantId/drafts/:id', (req) =>
    tenantTx(req, async (tx) => {
      const { id } = idParams.parse(req.params);
      const [d] = await tx`select id, thread_id, status from public.drafts where id = ${id}`;
      if (!d) throw new HttpError(404, 'not found');
      return d;
    }),
  );
  app.get('/v1/tenants/:tenantId/escalations/:id', (req) =>
    tenantTx(req, async (tx) => {
      const { id } = idParams.parse(req.params);
      const [e] =
        await tx`select id, thread_id, resolved_at from public.escalations where id = ${id}`;
      if (!e) throw new HttpError(404, 'not found');
      return e;
    }),
  );

  const lockDecidable = async (tx: TransactionSql, id: string) => {
    const [d] = await tx<{ id: string; status: string }[]>`
      select id, status from public.drafts where id = ${id} for update`;
    if (!d) throw new HttpError(404, 'not found');
    if (d.status !== 'pending_approval' && d.status !== 'suggestion')
      throw new HttpError(409, `already decided (${d.status})`);
    return d;
  };

  app.patch('/v1/tenants/:tenantId/drafts/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const { body } = draftBody.parse(req.body);
      await lockDecidable(tx, id);
      await tx`update public.drafts set body = ${body}, edited = true where id = ${id}`;
      await audit(tx, tenantId, req.user!.userId, 'draft.edited', 'draft', id);
      return { ok: true };
    }),
  );

  app.post('/v1/tenants/:tenantId/drafts/:id/approve', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const { body } = approveBody.parse(req.body ?? {});
      const d = await lockDecidable(tx, id);
      if (body !== undefined)
        await tx`update public.drafts set body = ${body}, edited = true where id = ${id}`;
      await tx`update public.drafts set status = 'approved', decided_by = 'owner', decided_at = now() where id = ${id}`;
      if (d.status === 'suggestion') {
        // Sending the (checked) suggestion answers the escalation.
        await tx`update public.escalations set resolved_at = now(), resolved_by = 'owner'
                 where suggestion_draft_id = ${id} and resolved_at is null`;
      }
      await enqueue(tx, {
        tenantId,
        queue: MAIL_SEND_QUEUE,
        payload: { draftId: id, sentVia: 'owner_approval' },
        singletonKey: id,
      });
      await audit(tx, tenantId, req.user!.userId, 'draft.approved', 'draft', id, {
        via: 'dashboard',
        edited: body !== undefined,
      });
      return { ok: true, status: 'approved' };
    }),
  );

  app.post('/v1/tenants/:tenantId/drafts/:id/reject', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      await lockDecidable(tx, id);
      await tx`update public.drafts set status = 'rejected', decided_by = 'owner', decided_at = now() where id = ${id}`;
      await audit(tx, tenantId, req.user!.userId, 'draft.rejected', 'draft', id, {
        via: 'dashboard',
      });
      return { ok: true, status: 'rejected' };
    }),
  );

  app.post('/v1/tenants/:tenantId/escalations/:id/resolve', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const rows = await tx`update public.escalations set resolved_at = now(), resolved_by = 'owner'
                            where id = ${id} and resolved_at is null returning id`;
      if (!rows.length) throw new HttpError(409, 'already resolved or not found');
      await audit(tx, tenantId, req.user!.userId, 'escalation.resolved', 'escalation', id);
      return { ok: true };
    }),
  );

  // ----------------------------------------------------------------- leads
  app.get('/v1/tenants/:tenantId/leads', (req) =>
    tenantTx(req, async (tx) => {
      const q = z.object({ stage: z.enum(LEAD_STAGES).optional() }).parse(req.query);
      const leads = await tx`
        select l.id, l.email, l.name, l.stage, l.stage_changed_at, l.last_activity_at, l.notes, l.first_seen_at,
               (select th.id from public.threads th where th.lead_id = l.id order by th.created_at desc limit 1) as thread_id
        from public.leads l
        where ${q.stage ? tx`l.stage = ${q.stage}` : tx`true`}
        order by l.last_activity_at desc limit 200`;
      const counts = await tx<{ stage: string; n: number }[]>`
        select stage, count(*)::int as n from public.leads group by stage`;
      return { leads, counts: Object.fromEntries(counts.map((c) => [c.stage, c.n])) };
    }),
  );

  app.patch('/v1/tenants/:tenantId/leads/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const b = leadBody.parse(req.body);
      const [lead] = await tx<
        { stage: string }[]
      >`select stage from public.leads where id = ${id} for update`;
      if (!lead) throw new HttpError(404, 'not found');
      if (b.name !== undefined)
        await tx`update public.leads set name = ${b.name || null} where id = ${id}`;
      if (b.notes !== undefined)
        await tx`update public.leads set notes = ${b.notes || null} where id = ${id}`;
      if (b.stage && b.stage !== lead.stage) {
        await tx`update public.leads set stage = ${b.stage}, stage_changed_at = now() where id = ${id}`;
        await tx`insert into public.lead_events (tenant_id, lead_id, from_stage, to_stage, actor, actor_user_id, reason)
                 values (${tenantId}, ${id}, ${lead.stage}, ${b.stage}, 'owner', ${req.user!.userId}, 'changed in dashboard')`;
      }
      return { ok: true };
    }),
  );

  // -------------------------------------------------------- knowledge base
  app.get('/v1/tenants/:tenantId/kb/sources', (req) =>
    tenantTx(
      req,
      (tx) => tx`
        select id, type, title, url, status, error, created_at, updated_at
        from public.kb_sources order by created_at desc`,
    ),
  );

  const kbCreate = async (fn: () => Promise<string>) => {
    try {
      return { id: await fn(), status: 'pending' };
    } catch (e) {
      if (e instanceof BlockedUrlError)
        throw new HttpError(400, `This address can't be used (${e.reason}).`);
      if (e instanceof UploadRejectedError) throw new HttpError(400, UPLOAD_MESSAGES[e.reason]);
      throw e;
    }
  };

  app.post('/v1/tenants/:tenantId/kb/website', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { url } = z.object({ url: z.string().trim().min(4).max(500) }).parse(req.body);
      const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      return kbCreate(() => createWebsiteSource(tx, { tenantId, url: full }));
    }),
  );

  app.post('/v1/tenants/:tenantId/kb/notes', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = z
        .object({
          title: z.string().trim().min(1).max(200),
          text: z.string().trim().min(1).max(50_000),
        })
        .parse(req.body);
      return kbCreate(() => createNoteSource(tx, { tenantId, title: b.title, text: b.text }));
    }),
  );

  // Files arrive base64-encoded in JSON (≤ 10 MB decoded); no multipart parser needed.
  app.post('/v1/tenants/:tenantId/kb/files', { bodyLimit: 15 * 1024 * 1024 }, (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const b = z
        .object({
          fileName: z.string().trim().min(1).max(255),
          contentBase64: z
            .string()
            .min(1)
            .max(14 * 1024 * 1024),
        })
        .parse(req.body);
      const bytes = Buffer.from(b.contentBase64, 'base64');
      return kbCreate(() => createFileSource(tx, { tenantId, fileName: b.fileName, bytes }));
    }),
  );

  app.post('/v1/tenants/:tenantId/kb/sources/:id/refresh', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const [s] = await tx<{ type: string }[]>`select type from public.kb_sources where id = ${id}`;
      if (!s) throw new HttpError(404, 'not found');
      if (s.type === 'file')
        throw new HttpError(409, 'Files are not kept after reading; upload it again.');
      await tx`update public.kb_sources set status = 'pending', error = null where id = ${id}`;
      await enqueue(tx, {
        tenantId,
        queue: KB_INGEST_QUEUE,
        payload: { sourceId: id },
        singletonKey: id,
      });
      return { ok: true };
    }),
  );

  app.delete('/v1/tenants/:tenantId/kb/sources/:id', (req) =>
    tenantTx(req, async (tx, tenantId) => {
      const { id } = idParams.parse(req.params);
      const rows = await tx`delete from public.kb_sources where id = ${id} returning id`;
      if (!rows.length) throw new HttpError(404, 'not found');
      await audit(tx, tenantId, req.user!.userId, 'kb.source_deleted', 'kb_source', id);
      return { ok: true };
    }),
  );
}

const UPLOAD_MESSAGES: Record<UploadRejectedError['reason'], string> = {
  too_large: 'The file is larger than 10 MB.',
  empty: 'The file is empty.',
  unsupported_type: 'Only PDF, Word (.docx) and plain text files can be used.',
  not_utf8_text: 'The text file could not be read. Save it as UTF-8 and try again.',
};
