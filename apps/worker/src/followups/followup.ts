import {
  addUsage,
  buildFollowupPrompt,
  buildVerifierPrompt,
  ClassificationSchema,
  generateJson,
  GenerationSchema,
  guardReply,
  isWithinBusinessWindow,
  mayCallModel,
  nextFollowupAt,
  originForMailbox,
  ownerNotificationPayload,
  stripQuotedText,
  VerifierSchema,
  ZERO_USAGE,
  type TenantMode,
  type TokenUsage,
} from '@noctiv/core';
import { currentBudget, enqueue, recordUsage, withTenant } from '@noctiv/db';
import { loadAllowlist, retrieveKnowledge } from '@noctiv/kb';
import type { Sql, TransactionSql } from 'postgres';
import type { PipelineDeps } from '../pipeline/process.ts';
import { QUEUES } from '../queues.ts';

export type FollowupOutcome =
  | { status: 'skipped'; reason: string }
  | { status: 'stopped'; reason: string }
  | { status: 'rescheduled'; at: string }
  | { status: 'drafted' | 'auto_send'; reasons: string[] }
  | { status: 'discarded'; reason: string };

/**
 * followups.scan (every 15 min): one follow-up job per due thread. The
 * cross-tenant query returns identifiers only; each job re-checks everything
 * in the tenant's RLS context.
 */
export async function scanFollowups(sql: Sql, limit = 200): Promise<number> {
  const due = await sql<{ tenant_id: string; thread_id: string }[]>`
    select tenant_id, thread_id from app.due_followups(${limit})`;
  let queued = 0;
  for (const d of due) {
    const id = await withTenant(sql, d.tenant_id, (tx) =>
      enqueue(tx, {
        tenantId: d.tenant_id,
        queue: QUEUES.followup,
        payload: { threadId: d.thread_id },
        singletonKey: `followup:${d.thread_id}`,
        maxAttempts: 3,
      }),
    );
    if (id) queued++;
  }
  return queued;
}

interface ThreadState {
  status: string;
  next_followup_at: Date | null;
  followups_sent: number;
  last_outbound_at: Date | null;
  lead_stage: string | null;
  tenant_name: string;
  mode: TenantMode;
  timezone: string;
  followup_max: number;
  tenant_status: string;
  notify_full_text: boolean;
  max_ai_replies_per_sender_24h: number;
  max_replies_per_hour: number;
  conn_status: string;
  is_test_mailbox: boolean;
}

async function lockThread(tx: TransactionSql, threadId: string) {
  const [t] = await tx<ThreadState[]>`
    select th.status, th.next_followup_at, th.followups_sent, th.last_outbound_at, l.stage as lead_stage,
           t.name as tenant_name, t.mode, t.timezone, t.followup_max, t.status as tenant_status, t.notify_full_text,
           t.max_ai_replies_per_sender_24h, t.max_replies_per_hour, c.status as conn_status, c.is_test_mailbox
    from public.threads th
    join public.tenants t on t.id = th.tenant_id
    join public.email_connections c on c.id = th.connection_id
    left join public.leads l on l.id = th.lead_id
    where th.id = ${threadId}
    for update of th`;
  return t;
}

const customerAnsweredSince = async (tx: TransactionSql, threadId: string, since: Date | null) =>
  (
    await tx`select 1 from public.messages where thread_id = ${threadId} and direction = 'inbound'
             and received_at > ${since ?? new Date(0)} limit 1`
  ).length > 0;

async function stop(tx: TransactionSql, threadId: string, reason: string) {
  await tx`update public.threads set next_followup_at = null, followup_stop_reason = ${reason} where id = ${threadId}`;
}

/** Why a thread must not get a follow-up now (null = go ahead). */
async function check(
  tx: TransactionSql,
  threadId: string,
  t: ThreadState | undefined,
  now: Date,
): Promise<FollowupOutcome | null> {
  if (!t) return { status: 'skipped', reason: 'thread_missing' };
  if (t.status !== 'awaiting_customer') return { status: 'skipped', reason: 'not_awaiting' };
  if (!t.next_followup_at || t.next_followup_at > now)
    return { status: 'skipped', reason: 'not_due' };
  if (t.tenant_status !== 'active') return { status: 'skipped', reason: 'tenant_inactive' };
  if (t.conn_status !== 'connected') return { status: 'skipped', reason: 'mailbox_not_connected' };
  const stopWith = async (reason: string): Promise<FollowupOutcome> => {
    await stop(tx, threadId, reason);
    return { status: 'stopped', reason };
  };
  if (t.followups_sent >= t.followup_max) return stopWith('max_reached');
  if (t.lead_stage === 'converted' || t.lead_stage === 'escalated')
    return stopWith(`lead_${t.lead_stage}`);
  if (await customerAnsweredSince(tx, threadId, t.last_outbound_at))
    return stopWith('customer_replied');
  const pending = await tx`
    select 1 from public.drafts where thread_id = ${threadId} and kind = 'followup'
      and status in ('pending_approval', 'approved') limit 1`;
  if (pending.length) return { status: 'skipped', reason: 'draft_pending' };
  if (!isWithinBusinessWindow(now, t.timezone)) {
    const at = nextFollowupAt(now, 0, t.timezone);
    await tx`update public.threads set next_followup_at = ${at} where id = ${threadId}`;
    return { status: 'rescheduled', at: at.toISOString() };
  }
  return null;
}

/**
 * followup.generate(threadId) — PLAN.md §4.6 with founder decision Q7.
 * A short check-in is generated from the conversation and the knowledge
 * base, then goes through exactly the same guards and policy engine as a
 * reply: auto-sent only when everything passes, otherwise drafted for the
 * owner; a follow-up the policy would escalate is not sent at all and the
 * thread's follow-ups stop.
 */
export async function generateFollowup(
  deps: PipelineDeps,
  tenantId: string,
  threadId: string,
  now = new Date(),
): Promise<FollowupOutcome> {
  const prep = await withTenant(deps.sql, tenantId, async (tx) => {
    const t = await lockThread(tx, threadId);
    const blocked = await check(tx, threadId, t, now);
    if (blocked) return { blocked };
    const [customer] = await tx<
      {
        from_address: string;
        from_name: string | null;
        reply_to: string | null;
        subject: string | null;
        body_text: string | null;
        message_id_header: string;
        reference_ids: string[];
        classification: unknown;
      }[]
    >`
      select m.from_address, m.from_name, m.reply_to, m.subject, m.body_text, m.message_id_header, m.reference_ids,
             mp.classification
      from public.messages m left join public.message_processing mp on mp.message_id = m.id
      where m.thread_id = ${threadId} and m.direction = 'inbound'
      order by m.received_at desc limit 1`;
    const [ours] = await tx<{ body_text: string | null }[]>`
      select body_text from public.messages
      where thread_id = ${threadId} and direction = 'outbound' order by received_at desc limit 1`;
    if (!customer?.body_text || !ours?.body_text) {
      await stop(tx, threadId, 'context_missing');
      return { blocked: { status: 'stopped', reason: 'context_missing' } as FollowupOutcome };
    }
    const classification = ClassificationSchema.safeParse(customer.classification);
    if (!classification.success) {
      await stop(tx, threadId, 'no_classification');
      return { blocked: { status: 'stopped', reason: 'no_classification' } as FollowupOutcome };
    }
    const budget = await currentBudget(tx, tenantId);
    if (!mayCallModel(budget.state)) {
      return { blocked: { status: 'skipped', reason: 'budget_halted' } as FollowupOutcome };
    }
    const origin = originForMailbox({ isTestMailbox: t!.is_test_mailbox });
    if (deps.llm.trainingPolicy === 'may_train_on_data' && origin === 'customer_data') {
      await stop(tx, threadId, 'free_tier_refused');
      return { blocked: { status: 'stopped', reason: 'free_tier_refused' } as FollowupOutcome };
    }
    return {
      t: t!,
      customer,
      ourLastReply: ours.body_text,
      classification: classification.data,
      budgetState: budget.state,
      origin,
    };
  });
  if ('blocked' in prep) return prep.blocked as FollowupOutcome;
  const { t, customer, classification, origin } = prep;

  let usage: TokenUsage = ZERO_USAGE;
  let llmCalls = 0;
  const body = stripQuotedText(customer.body_text!);
  const knowledge = await retrieveKnowledge(
    { sql: deps.sql, embeddings: deps.embeddings },
    { tenantId, query: `${customer.subject ?? ''}\n${body}`, origin },
  );
  const embedTokens = knowledge.usage.inputTokens;
  const followupNumber = t.followups_sent + 1;
  const prompt = buildFollowupPrompt({
    businessName: t.tenant_name,
    customer: { fromName: customer.from_name, subject: customer.subject, bodyText: body },
    ourLastReply: prep.ourLastReply,
    chunks: knowledge.chunks.map((c) => ({ id: c.id, content: c.content })),
    language: classification.language,
    followupNumber,
  });
  const gen = await generateJson(
    deps.llm,
    { tier: 'quality', origin, system: prompt.system, parts: prompt.parts, maxOutputTokens: 1024 },
    GenerationSchema,
  );
  usage = addUsage(usage, gen.usage);
  llmCalls += gen.attempts;

  const replyTo = customer.reply_to ? [customer.reply_to] : [];
  const context = await withTenant(deps.sql, tenantId, async (tx) => {
    const [caps] = await tx<{ sender: number; hour: number }[]>`
      select count(*) filter (where to_address = ${customer.reply_to ?? customer.from_address} and created_at > now() - interval '24 hours')::int as sender,
             count(*) filter (where created_at > now() - interval '1 hour')::int as hour
      from public.outbound_emails where sent_via = 'auto' and status <> 'failed'`;
    return { caps: caps!, allowlist: await loadAllowlist(tx) };
  });
  const guardInput = {
    tenant: { mode: t.mode, budgetState: prep.budgetState, allowlist: context.allowlist },
    inbound: {
      from: customer.from_address,
      replyTo,
      subject: customer.subject,
      messageId: customer.message_id_header,
      references: customer.reference_ids,
      bodyText: body,
    },
    classification,
    modelOutput: gen.ok ? gen.value : gen.raw,
    labels: prompt.labels,
    caps: {
      senderRepliesLast24h: context.caps.sender,
      maxPerSender24h: t.max_ai_replies_per_sender_24h,
      tenantRepliesLastHour: context.caps.hour,
      maxPerHour: t.max_replies_per_hour,
    },
  };
  let guarded = guardReply({ ...guardInput, verifier: 'not_run' });
  if (guarded.decision.eligibleForVerification && guarded.replyText) {
    const cited = knowledge.chunks
      .filter((c) => guarded.citedChunkIds.includes(c.id))
      .map((c) => c.content);
    const v = await generateJson(
      deps.llm,
      {
        tier: 'fast',
        origin,
        ...buildVerifierPrompt({ reply: guarded.replyText, excerpts: cited }),
        maxOutputTokens: 512,
      },
      VerifierSchema,
    );
    usage = addUsage(usage, v.usage);
    llmCalls += v.attempts;
    guarded = guardReply({
      ...guardInput,
      verifier:
        v.ok && v.value.supported && v.value.unsupported_claims.length === 0 ? 'passed' : 'failed',
    });
  }
  const d = guarded.decision;

  return withTenant(deps.sql, tenantId, async (tx): Promise<FollowupOutcome> => {
    await recordUsage(tx, { tenantId, usage, llmCalls, embedTokens });
    // The customer may have answered while the model was working.
    const again = await lockThread(tx, threadId);
    if (
      !again ||
      again.status !== 'awaiting_customer' ||
      again.followups_sent !== t.followups_sent ||
      (await customerAnsweredSince(tx, threadId, again.last_outbound_at))
    ) {
      return { status: 'discarded', reason: 'thread_changed' };
    }
    const audit = (action: string, extra: Record<string, unknown> = {}) =>
      tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
         values (${tenantId}, 'system', ${action}, 'thread', ${threadId},
                 ${tx.json({ followupNumber, decision: d.action, reasons: d.reasons, ...extra } as never)})`;

    if (d.action === 'escalate' || !guarded.replyText) {
      // A follow-up that needs a human is simply not sent: nobody is waiting for it.
      await stop(tx, threadId, 'policy_escalate');
      await audit('followup.stopped');
      return { status: 'stopped', reason: 'policy_escalate' };
    }
    const autoSend = d.action === 'auto_send';
    const [draft] = await tx<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, source_chunk_ids,
                                 status, decided_by, decided_at)
      values (${tenantId}, ${threadId}, null, 'followup', ${guarded.envelope.to}, ${guarded.envelope.subject},
              ${guarded.replyText}, ${guarded.citedChunkIds}::uuid[], ${autoSend ? 'approved' : 'pending_approval'},
              ${autoSend ? 'auto' : null}, ${autoSend ? new Date() : null})
      returning id`;
    // Paused until this follow-up is sent (mail.send schedules the next one) or rejected.
    await tx`update public.threads set next_followup_at = null where id = ${threadId}`;
    if (autoSend) {
      await enqueue(tx, {
        tenantId,
        queue: QUEUES.mailSend,
        payload: { draftId: draft!.id, sentVia: 'auto' },
        singletonKey: draft!.id,
      });
    } else {
      const payload = {
        ...ownerNotificationPayload({
          fullText: t.notify_full_text,
          kind: 'draft_ready',
          senderAddress: customer.from_address,
          senderName: customer.from_name,
          subject: customer.subject,
          summary: `Follow-up ${followupNumber} of ${t.followup_max}: the customer has not answered our reply yet.`,
          action: 'draft',
          reasons: d.reasons,
          draftText: guarded.replyText,
          unverifiedSuggestion: false,
        }),
        draftId: draft!.id,
        threadId,
      };
      await tx`
        insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
        values (${tenantId}, 'email_owner', 'draft_ready', ${`draft:${draft!.id}`}, ${tx.json(payload as never)})
        on conflict (tenant_id, dedupe_key) do nothing`;
    }
    await audit('followup.generated', { draftId: draft!.id });
    return { status: autoSend ? 'auto_send' : 'drafted', reasons: d.reasons };
  });
}
