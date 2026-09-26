import {
  addUsage,
  buildClassificationPrompt,
  buildGenerationPrompt,
  buildVerifierPrompt,
  checkLoop,
  ClassificationSchema,
  decideAcknowledgement,
  generateJson,
  GenerationSchema,
  guardReply,
  hardEscalationReasons,
  mayCallModel,
  originForMailbox,
  ownerNotificationPayload,
  resolveReplyRecipient,
  SKIP_CATEGORIES,
  stripQuotedText,
  VerifierSchema,
  ZERO_USAGE,
  type Classification,
  type EmbeddingProvider,
  type GuardedReply,
  type HeaderMap,
  type LlmProvider,
  type Logger,
  type TenantMode,
  type TokenUsage,
} from '@noctiv/core';
import { currentBudget, enqueue, recordUsage, withTenant } from '@noctiv/db';
import { loadAllowlist, retrieveKnowledge } from '@noctiv/kb';
import type { Sql, TransactionSql } from 'postgres';
import { QUEUES } from '../queues.ts';
import { setLeadStage } from './leads.ts';
import { bankDomainFor } from '@noctiv/documents';
import { handleBankEmail } from './bank.ts';
import { draftQuote } from './quote.ts';

export interface PipelineDeps {
  sql: Sql;
  llm: LlmProvider;
  embeddings: EmbeddingProvider;
  logger?: Logger;
  /** Quotes (beta): signs the customer's accept link. Without it quote requests get normal replies. */
  quotes?: { secret: string; publicApiUrl: string };
}

export type ProcessOutcome =
  | { status: 'already_processed' }
  | { status: 'skipped'; reason: string }
  | { status: 'drafted' | 'auto_send' | 'escalated'; reasons: string[] };

export interface Loaded {
  processingStatus: string;
  message: {
    id: string;
    connectionId: string;
    threadId: string;
    messageIdHeader: string;
    references: string[];
    from: string;
    fromName: string | null;
    replyTo: string | null;
    subject: string | null;
    bodyText: string | null;
    loopHeaders: HeaderMap;
    htmlHiddenText: boolean;
  };
  isTestMailbox: boolean;
  ownAddresses: string[];
  tenant: {
    name: string;
    mode: TenantMode;
    notifyFullText: boolean;
    maxPerSender24h: number;
    maxPerHour: number;
    quotesEnabled: boolean;
    documentsEnabled: boolean;
  };
  thread: { status: string };
  /** Sender domains the owner confirmed as their bank's notifications. */
  bankDomains: string[];
  /** In the trial or subscribed (app.billing_entitled). */
  entitled: boolean;
  /** Arrived while service was stopped; handled in approve-everything mode. */
  backlog: boolean;
}

async function load(tx: TransactionSql, messageId: string): Promise<Loaded | undefined> {
  const [row] = await tx<
    {
      processing_status: string;
      id: string;
      connection_id: string;
      thread_id: string;
      message_id_header: string;
      reference_ids: string[];
      from_address: string;
      from_name: string | null;
      reply_to: string | null;
      subject: string | null;
      body_text: string | null;
      loop_headers: HeaderMap;
      html_hidden_text: boolean;
      is_test_mailbox: boolean;
      tenant_name: string;
      mode: TenantMode;
      notify_full_text: boolean;
      max_ai_replies_per_sender_24h: number;
      max_replies_per_hour: number;
      quotes_enabled: boolean;
      documents_enabled: boolean;
      thread_status: string;
      entitled: boolean;
      backlog: boolean;
    }[]
  >`
    select mp.status as processing_status, m.id, m.connection_id, m.thread_id, m.message_id_header, m.reference_ids,
           m.from_address, m.from_name, m.reply_to, m.subject, m.body_text, m.loop_headers, m.html_hidden_text,
           c.is_test_mailbox, t.name as tenant_name, t.mode, t.notify_full_text,
           t.max_ai_replies_per_sender_24h, t.max_replies_per_hour, t.quotes_enabled, t.documents_enabled,
           th.status as thread_status,
           app.billing_entitled(t.billing_status, t.trial_ends_at) as entitled,
           coalesce(m.received_at < t.billing_resumed_at, false) as backlog
    from public.message_processing mp
    join public.messages m on m.id = mp.message_id
    join public.email_connections c on c.id = m.connection_id
    join public.tenants t on t.id = m.tenant_id
    join public.threads th on th.id = m.thread_id
    where mp.message_id = ${messageId}
    for update of mp`;
  if (!row) return undefined;
  const own = await tx<
    { email_address: string }[]
  >`select email_address from public.email_connections`;
  const banks = await tx<{ domain: string }[]>`select domain from public.bank_senders`;
  return {
    processingStatus: row.processing_status,
    message: {
      id: row.id,
      connectionId: row.connection_id,
      threadId: row.thread_id,
      messageIdHeader: row.message_id_header,
      references: row.reference_ids,
      from: row.from_address,
      fromName: row.from_name,
      replyTo: row.reply_to,
      subject: row.subject,
      bodyText: row.body_text,
      loopHeaders: row.loop_headers,
      htmlHiddenText: row.html_hidden_text,
    },
    isTestMailbox: row.is_test_mailbox,
    ownAddresses: own.map((o) => o.email_address),
    tenant: {
      name: row.tenant_name,
      // Mail that arrived while service was stopped (no subscription) is only drafted.
      mode: row.backlog ? 'draft_only' : row.mode,
      notifyFullText: row.notify_full_text,
      maxPerSender24h: row.max_ai_replies_per_sender_24h,
      maxPerHour: row.max_replies_per_hour,
      quotesEnabled: row.quotes_enabled,
      documentsEnabled: row.documents_enabled,
    },
    bankDomains: banks.map((b) => b.domain),
    thread: { status: row.thread_status },
    entitled: row.entitled,
    backlog: row.backlog,
  };
}

/** Lead per reply address; a customer answer to our reply stops follow-ups (brief §5). */
async function trackLead(
  tx: TransactionSql,
  tenantId: string,
  l: Loaded,
  recipient: string,
): Promise<string> {
  const [lead] = await tx<{ id: string; created: boolean }[]>`
    insert into public.leads (tenant_id, email, name)
    values (${tenantId}, ${recipient}, ${l.message.fromName})
    on conflict (tenant_id, email) do update set last_activity_at = now()
    returning id, (xmax = 0) as created`;
  const leadId = lead!.id;
  if (lead!.created) {
    await tx`insert into public.lead_events (tenant_id, lead_id, to_stage, actor, reason)
             values (${tenantId}, ${leadId}, 'received', 'system', 'first message')`;
  }
  await tx`update public.threads set lead_id = coalesce(lead_id, ${leadId}) where id = ${l.message.threadId}`;
  // The customer wrote again: a follow-up still waiting to go out is obsolete.
  await tx`update public.drafts set status = 'superseded'
           where thread_id = ${l.message.threadId} and kind = 'followup' and status in ('pending_approval', 'approved')`;
  if (l.thread.status === 'awaiting_customer') {
    await tx`update public.threads set status = 'customer_replied', next_followup_at = null, followup_stop_reason = 'customer_replied'
             where id = ${l.message.threadId}`;
    await setLeadStage(tx, tenantId, leadId, 'replied', 'customer replied');
  }
  return leadId;
}

async function finishSkipped(
  tx: TransactionSql,
  messageId: string,
  reason: string,
  classification?: Classification,
) {
  await tx`update public.message_processing
           set status = 'skipped', skip_reason = ${reason}, final_action = 'skip',
               classification = ${classification ? tx.json(classification) : null}
           where message_id = ${messageId}`;
}

/**
 * mail.process (PLAN.md §4.2): loop filter → lead → budget → classify →
 * hard-list escalation → retrieve → generate → guards (→ verifier) →
 * draft / auto-send / escalation, with owner notifications queued.
 * Idempotent: a message whose processing record is no longer 'queued' is left alone.
 */
export async function processMessage(
  deps: PipelineDeps,
  tenantId: string,
  messageId: string,
): Promise<ProcessOutcome> {
  const l = await withTenant(deps.sql, tenantId, async (tx) => {
    const loaded = await load(tx, messageId);
    if (
      !loaded ||
      (loaded.processingStatus !== 'queued' && loaded.processingStatus !== 'processing')
    )
      return undefined;
    await tx`update public.message_processing set status = 'processing' where message_id = ${messageId}`;
    return loaded;
  });
  if (!l) return { status: 'already_processed' };
  const m = l.message;
  const replyTo = m.replyTo ? [m.replyTo] : [];
  const body = m.bodyText === null ? null : stripQuotedText(m.bodyText);

  // 0. The business's own bank: payments are read, nothing is answered, no lead.
  //    (Before the loop filter: bank notifications come from no-reply senders.)
  const bankDomain = bankDomainFor(m.from, l.bankDomains);
  if (bankDomain) return handleBankEmail(deps, tenantId, l, bankDomain);

  // 1. Never-reply rules (no model call, no lead).
  if (body !== null) {
    const loop = checkLoop({
      headers: m.loopHeaders,
      from: m.from,
      replyTo,
      ownAddresses: l.ownAddresses,
      bodyText: body,
    });
    if (loop.skip) {
      await withTenant(deps.sql, tenantId, (tx) => finishSkipped(tx, m.id, loop.reason));
      return { status: 'skipped', reason: loop.reason };
    }
  }

  // No subscription after the trial: nothing is read by the model or answered.
  if (!l.entitled) {
    await withTenant(deps.sql, tenantId, (tx) => finishSkipped(tx, m.id, 'billing_inactive'));
    return { status: 'skipped', reason: 'billing_inactive' };
  }

  const recipient = resolveReplyRecipient({ from: m.from, replyTo });
  const leadId = await withTenant(deps.sql, tenantId, (tx) =>
    trackLead(tx, tenantId, l, recipient.to.toLowerCase()),
  );

  // 2. Budget and the free-tier lock.
  const budget = await withTenant(deps.sql, tenantId, (tx) => currentBudget(tx, tenantId));
  if (!mayCallModel(budget.state)) {
    await withTenant(deps.sql, tenantId, (tx) => finishSkipped(tx, m.id, 'budget_halted'));
    return { status: 'skipped', reason: 'budget_halted' };
  }
  const origin = originForMailbox({ isTestMailbox: l.isTestMailbox });
  if (deps.llm.trainingPolicy === 'may_train_on_data' && origin === 'customer_data') {
    await withTenant(deps.sql, tenantId, (tx) => finishSkipped(tx, m.id, 'free_tier_refused'));
    return { status: 'skipped', reason: 'free_tier_refused' };
  }

  let usage: TokenUsage = ZERO_USAGE;
  let llmCalls = 0;
  let embedTokens = 0;

  // A message too large to read is handed to the owner.
  if (body === null) {
    return escalate(
      deps,
      tenantId,
      l,
      leadId,
      {
        category: 'uncertain',
        reasons: ['unreadable_message'],
        summary: 'A very large message could not be read automatically.',
      },
      usage,
      llmCalls,
      embedTokens,
      null,
    );
  }

  // 3. Classify.
  const email = { fromName: m.fromName, subject: m.subject, bodyText: body };
  const cls = await generateJson(
    deps.llm,
    { tier: 'fast', origin, ...buildClassificationPrompt(email), maxOutputTokens: 1024 },
    ClassificationSchema,
  );
  usage = addUsage(usage, cls.usage);
  llmCalls += cls.attempts;
  if (!cls.ok) {
    return escalate(
      deps,
      tenantId,
      l,
      leadId,
      {
        category: 'uncertain',
        reasons: ['invalid_output'],
        summary: 'The message could not be classified automatically.',
      },
      usage,
      llmCalls,
      embedTokens,
      null,
    );
  }
  const classification = cls.value;
  if ((SKIP_CATEGORIES as readonly string[]).includes(classification.category)) {
    await withTenant(deps.sql, tenantId, async (tx) => {
      await finishSkipped(tx, m.id, `class:${classification.category}`, classification);
      await recordUsage(tx, { tenantId, usage, llmCalls });
    });
    return { status: 'skipped', reason: `class:${classification.category}` };
  }

  // 4. Hard escalation list: humans write these; no draft is generated (Q16).
  const hard = hardEscalationReasons(classification);
  if (hard.length) {
    return escalate(
      deps,
      tenantId,
      l,
      leadId,
      { category: 'hard_list', reasons: hard, summary: classification.summary, classification },
      usage,
      llmCalls,
      embedTokens,
      null,
    );
  }

  // 4b. Quotes (beta): a price request for items on the confirmed price list gets a quote.
  //     With quotes off, quote_request is handled exactly like sales_inquiry.
  if (classification.category === 'quote_request' && l.tenant.quotesEnabled && deps.quotes) {
    const q = await draftQuote(deps, tenantId, l, leadId, {
      classification,
      body,
      origin,
      budgetState: budget.state,
      usage,
      llmCalls,
      embedTokens,
    });
    if (q.outcome) return q.outcome;
    usage = q.usage;
    llmCalls = q.llmCalls;
  }

  // 5. Retrieve, generate, guard.
  const knowledge = await retrieveKnowledge(
    { sql: deps.sql, embeddings: deps.embeddings },
    { tenantId, query: `${m.subject ?? ''}\n${body}`, origin },
  );
  embedTokens += knowledge.usage.inputTokens;
  const prompt = buildGenerationPrompt({
    businessName: l.tenant.name,
    email,
    chunks: knowledge.chunks.map((c) => ({ id: c.id, content: c.content })),
    inboundLanguage: classification.language,
  });
  const gen = await generateJson(
    deps.llm,
    { tier: 'quality', origin, system: prompt.system, parts: prompt.parts, maxOutputTokens: 2048 },
    GenerationSchema,
  );
  usage = addUsage(usage, gen.usage);
  llmCalls += gen.attempts;

  const context = await withTenant(deps.sql, tenantId, async (tx) => {
    const [caps] = await tx<{ sender: number; hour: number }[]>`
      select count(*) filter (where to_address = ${recipient.to} and created_at > now() - interval '24 hours')::int as sender,
             count(*) filter (where created_at > now() - interval '1 hour')::int as hour
      from public.outbound_emails where sent_via = 'auto'`;
    return { caps: caps!, allowlist: await loadAllowlist(tx) };
  });
  const guardInput = {
    tenant: { mode: l.tenant.mode, budgetState: budget.state, allowlist: context.allowlist },
    inbound: {
      from: m.from,
      replyTo,
      subject: m.subject,
      messageId: m.messageIdHeader,
      references: m.references,
      bodyText: body,
      // HTML is not stored; the fetch-time signal stands in for it.
      html: m.htmlHiddenText
        ? '<div style="display:none">hidden text detected at fetch time</div>'
        : null,
    },
    classification,
    modelOutput: gen.ok ? gen.value : gen.raw,
    labels: prompt.labels,
    caps: {
      senderRepliesLast24h: context.caps.sender,
      maxPerSender24h: l.tenant.maxPerSender24h,
      tenantRepliesLastHour: context.caps.hour,
      maxPerHour: l.tenant.maxPerHour,
    },
  };
  let guarded = guardReply({ ...guardInput, verifier: 'not_run' });

  // 6. Grounding verifier, only for replies that would otherwise be auto-sent (Q6).
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

  const d = l.backlog
    ? {
        ...guarded.decision,
        reasons: guarded.decision.reasons.map((r) =>
          r === 'tenant_draft_only' ? ('arrived_while_paused' as const) : r,
        ),
      }
    : guarded.decision;
  if (d.action === 'escalate') {
    // Mode 3: a message that could not be grounded also gets a fixed acknowledgement.
    const ack = decideAcknowledgement({
      mode: l.tenant.mode,
      decision: d,
      budgetState: budget.state,
      language: classification.language,
      caps: guardInput.caps,
      injectionSuspected: guarded.injection.suspected,
      replyToMismatch: guarded.replyToMismatch,
    });
    return escalate(
      deps,
      tenantId,
      l,
      leadId,
      {
        category: d.escalation ?? 'uncertain',
        reasons: ack.send ? [...d.reasons, 'acknowledgement_sent'] : d.reasons,
        summary: classification.summary,
        classification,
        ...(ack.send ? { acknowledgement: { text: ack.text, envelope: guarded.envelope } } : {}),
      },
      usage,
      llmCalls,
      embedTokens,
      guarded,
    );
  }

  // 7. Draft for approval, or approved for auto-send.
  await withTenant(deps.sql, tenantId, async (tx) => {
    const autoSend = d.action === 'auto_send';
    const [draft] = await tx<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, source_chunk_ids,
                                 status, decided_by, decided_at)
      values (${tenantId}, ${m.threadId}, ${m.id}, 'reply', ${guarded.envelope.to}, ${guarded.envelope.subject}, ${guarded.replyText},
              ${guarded.citedChunkIds}::uuid[], ${autoSend ? 'approved' : 'pending_approval'},
              ${autoSend ? 'auto' : null}, ${autoSend ? new Date() : null})
      returning id`;
    await writeProcessing(
      tx,
      m.id,
      'drafted',
      d.action,
      d.reasons,
      classification,
      guarded,
      knowledge.chunks.map((c) => c.id),
      usage,
    );
    await recordUsage(tx, { tenantId, usage, llmCalls, embedTokens });
    await setLeadStage(
      tx,
      tenantId,
      leadId,
      'drafted',
      autoSend ? 'auto reply approved' : 'draft ready',
    );
    if (autoSend) {
      await enqueue(tx, {
        tenantId,
        queue: QUEUES.mailSend,
        payload: { draftId: draft!.id, sentVia: 'auto' },
        singletonKey: draft!.id,
      });
    } else {
      await notifyOwner(tx, tenantId, `draft:${draft!.id}`, {
        kind: 'draft_ready',
        l,
        summary: classification.summary,
        action: d.action,
        reasons: d.reasons,
        draftText: guarded.replyText,
        unverifiedSuggestion: false,
        ref: { draftId: draft!.id, messageId: m.id },
      });
    }
  });
  return { status: d.action === 'auto_send' ? 'auto_send' : 'drafted', reasons: d.reasons };
}

async function writeProcessing(
  tx: TransactionSql,
  messageId: string,
  status: 'drafted' | 'escalated',
  finalAction: string,
  reasons: string[],
  classification: Classification | null,
  guarded: GuardedReply | null,
  retrieved: string[],
  usage: TokenUsage,
) {
  await tx`
    update public.message_processing
    set status = ${status}, final_action = ${finalAction}, downgrade_reasons = ${reasons},
        classification = ${classification ? tx.json(classification) : null},
        model_output = ${guarded?.generation ? tx.json(guarded.generation) : guarded ? tx.json({ invalid: true, error: guarded.validationError }) : null},
        confidence = ${guarded?.generation?.confidence ?? null},
        retrieved_chunk_ids = ${retrieved}::uuid[],
        tokens_in = ${usage.inputTokens}, tokens_out = ${usage.outputTokens + usage.thinkingTokens}, error = null
    where message_id = ${messageId}`;
}

export async function notifyOwner(
  tx: TransactionSql,
  tenantId: string,
  dedupeKey: string,
  n: {
    kind: 'draft_ready' | 'escalation';
    l: Loaded;
    summary: string;
    action: 'auto_send' | 'draft' | 'escalate';
    reasons: string[];
    draftText: string | null;
    unverifiedSuggestion: boolean;
    ref: Record<string, string>;
    /** Mode 3: the acknowledgement that was sent to the customer. */
    acknowledgement?: string;
  },
) {
  const payload = {
    ...ownerNotificationPayload({
      fullText: n.l.tenant.notifyFullText,
      kind: n.kind,
      senderAddress: n.l.message.from,
      senderName: n.l.message.fromName,
      subject: n.l.message.subject,
      summary: n.summary,
      action: n.action,
      reasons: n.reasons,
      draftText: n.draftText,
      unverifiedSuggestion: n.unverifiedSuggestion,
    }),
    ...n.ref,
    ...(n.acknowledgement ? { acknowledgement: n.acknowledgement } : {}),
  };
  await tx`
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    values (${tenantId}, 'email_owner', ${n.kind}, ${dedupeKey}, ${tx.json(payload as never)})
    on conflict (tenant_id, dedupe_key) do nothing`;
}

/**
 * Escalation: the owner gets "I could not answer this — please reply
 * manually". Hard-list cases carry no draft; uncertain ones keep the
 * generated reply as an "AI suggestion, unverified" (Q16).
 */
async function escalate(
  deps: PipelineDeps,
  tenantId: string,
  l: Loaded,
  leadId: string,
  e: {
    category: 'hard_list' | 'uncertain';
    reasons: string[];
    summary: string;
    classification?: Classification;
    /** Mode 3: fixed text sent to the customer while the owner answers. */
    acknowledgement?: { text: string; envelope: GuardedReply['envelope'] };
  },
  usage: TokenUsage,
  llmCalls: number,
  embedTokens: number,
  guarded: GuardedReply | null,
): Promise<ProcessOutcome> {
  const m = l.message;
  await withTenant(deps.sql, tenantId, async (tx) => {
    let suggestionId: string | null = null;
    const suggestion =
      e.category === 'uncertain' && guarded?.decision.keepSuggestion ? guarded.replyText : null;
    if (suggestion && guarded) {
      const [draft] = await tx<{ id: string }[]>`
        insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, source_chunk_ids, status)
        values (${tenantId}, ${m.threadId}, ${m.id}, 'reply', ${guarded.envelope.to}, ${guarded.envelope.subject}, ${suggestion},
                ${guarded.citedChunkIds}::uuid[], 'suggestion')
        returning id`;
      suggestionId = draft!.id;
    }
    const [esc] = await tx<{ id: string }[]>`
      insert into public.escalations (tenant_id, message_id, thread_id, category, reason, summary, suggestion_draft_id)
      values (${tenantId}, ${m.id}, ${m.threadId}, ${e.category}, ${e.reasons.join(', ')}, ${e.summary}, ${suggestionId})
      returning id`;
    await tx`update public.threads set status = 'escalated' where id = ${m.threadId}`;
    if (e.acknowledgement) {
      const a = e.acknowledgement;
      const [ackDraft] = await tx<{ id: string }[]>`
        insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                                   status, decided_by, decided_at)
        values (${tenantId}, ${m.threadId}, ${m.id}, 'acknowledgement', ${a.envelope.to}, ${a.envelope.subject}, ${a.text},
                'approved', 'auto', now())
        returning id`;
      await enqueue(tx, {
        tenantId,
        queue: QUEUES.mailSend,
        payload: { draftId: ackDraft!.id, sentVia: 'auto' },
        singletonKey: ackDraft!.id,
      });
    }
    await writeProcessing(
      tx,
      m.id,
      'escalated',
      'escalate',
      e.reasons,
      e.classification ?? null,
      guarded,
      [],
      usage,
    );
    await recordUsage(tx, { tenantId, usage, llmCalls, embedTokens });
    await setLeadStage(tx, tenantId, leadId, 'escalated', e.reasons[0] ?? 'escalated');
    await notifyOwner(tx, tenantId, `escalation:${esc!.id}`, {
      kind: 'escalation',
      l,
      summary: e.summary,
      action: 'escalate',
      reasons: e.reasons,
      draftText: suggestion,
      unverifiedSuggestion: Boolean(suggestion),
      ...(e.acknowledgement ? { acknowledgement: e.acknowledgement.text } : {}),
      ref: {
        escalationId: esc!.id,
        messageId: m.id,
        ...(suggestionId ? { draftId: suggestionId } : {}),
      },
    });
  });
  return { status: 'escalated', reasons: e.reasons };
}
