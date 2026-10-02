import {
  addUsage,
  buildAllowlist,
  buildGenerationPrompt,
  buildReplySubject,
  buildThreadingHeaders,
  buildVerifierPrompt,
  decideAcknowledgement,
  extractAllowlistEntries,
  generateJson,
  GenerationSchema,
  guardReply,
  resolveReplyRecipient,
  VerifierSchema,
  type Classification,
  type DataOrigin,
  type GuardedReply,
  type TokenUsage,
} from '@noctiv/core';
import { enqueue, recordUsage, withTenant } from '@noctiv/db';
import { loadAllowlist } from '@noctiv/kb';
import {
  asksForChange,
  decideOrder,
  factsForModel,
  mentionsChargeback,
  OrderLookupError,
  parseOrderRefs,
  summaryOf,
  type OrderDecision,
  type OrderFacts,
  type OrderLookupSummary,
  type OrderRecord,
} from '@noctiv/orders';
import { QUEUES } from '../queues.ts';
import { setLeadStage } from './leads.ts';
import {
  escalate,
  notifyOwner,
  writeProcessing,
  type GuardReport,
  type Loaded,
  type PipelineDeps,
  type ProcessOutcome,
} from './process.ts';

export interface OrderStepInput {
  classification: Classification;
  body: string;
  origin: DataOrigin;
  budgetState: 'ok' | 'draft_forced' | 'halted';
  usage: TokenUsage;
  llmCalls: number;
  embedTokens: number;
}

/** An order question: classified so, or any support-type message that names an order explicitly. */
export function isOrderEmail(c: Classification, subject: string | null, body: string): boolean {
  if (c.category === 'order_status') return true;
  return (
    ['support', 'product_question', 'other'].includes(c.category) &&
    parseOrderRefs(`${subject ?? ''}\n${body}`).explicit
  );
}

const ORDER_RULE =
  "9. This e-mail asks about an order. Excerpt [S1] is the verified order data from the shop's own system. " +
  'Answer the customer using only what [S1] says: the order number, the order date, the payment and shipping status, ' +
  'the carrier, the tracking number and link, the delivery date and the items that were sent. Say nothing else: ' +
  'no delivery estimate or promise that [S1] does not state, no apology for delay, no offer of a refund, return, ' +
  'discount or address change, nothing about any other order. If [S1] has no tracking number, link or delivery date, ' +
  'do not mention one. Always list S1 in "sources". Write only dates that appear in [S1] and copy tracking numbers and links exactly.';

const VERIFY_RULE =
  '9. The sender asked about an order but it could not be matched to one for this e-mail address. ' +
  'Write a short, polite reply asking for two things: the order number, and the e-mail address used at checkout. ' +
  'Do not say whether any order exists, do not mention any order details, status, date, product or amount, ' +
  'and do not promise anything. "sources" is []. Set action to "draft".';

/** Reply text for the owner's order card, per reason (English; shown in the app). */
export const ORDER_REASON_TEXT: Record<string, string> = {
  order_not_found: 'No order found for this order number or e-mail address',
  order_ambiguous: 'Several orders could match',
  order_identity_mismatch:
    'The sender is not the e-mail address on that order (nothing was shared)',
  order_cancelled_or_refunded: 'The order is cancelled or refunded',
  order_partially_fulfilled: 'The order is partly shipped or in an unusual state',
  order_fulfilled_no_tracking: 'The order is shipped but has no tracking',
  order_shipment_stale: 'No shipping update for a long time',
  order_change_request: 'The customer asks for a change, return or refund',
  order_chargeback: 'The customer mentions a chargeback or dispute',
  order_lookup_unavailable: 'The online store could not be asked',
};

async function caps(deps: PipelineDeps, tenantId: string, to: string) {
  return withTenant(deps.sql, tenantId, async (tx) => {
    const [c] = await tx<{ sender: number; hour: number }[]>`
      select count(*) filter (where to_address = ${to} and created_at > now() - interval '24 hours')::int as sender,
             count(*) filter (where created_at > now() - interval '1 hour')::int as hour
      from public.outbound_emails o where sent_via = 'auto'
        and not exists (select 1 from public.drafts bd where bd.id = o.draft_id and bd.kind = 'booking')`;
    return c!;
  });
}

/**
 * Order lookup (WISMO, Shopify or WooCommerce). Deterministic code finds the order, checks the
 * sender is its customer, and decides: answer, or hand to the owner. The model
 * only words an answer from the minimal facts, and the same claim checks as any
 * reply hold it to them. Read-only: nothing is ever written to the store.
 */
export async function answerOrderEmail(
  deps: PipelineDeps,
  tenantId: string,
  l: Loaded,
  leadId: string,
  i: OrderStepInput,
): Promise<{ outcome: ProcessOutcome }> {
  const orders = deps.orders!;
  const m = l.message;
  const now = new Date();
  const text = `${m.subject ?? ''}\n${i.body}`;
  const refs = parseOrderRefs(text);
  const replyTo = m.replyTo ? [m.replyTo] : [];
  const recipient = resolveReplyRecipient({ from: m.from, replyTo });
  const threading = buildThreadingHeaders({
    messageId: m.messageIdHeader,
    references: m.references,
  });
  const envelope = { to: recipient.to, subject: buildReplySubject(m.subject), ...threading };
  const language = i.classification.language;
  let usage = i.usage;
  let llmCalls = i.llmCalls;

  const inbound = {
    from: m.from,
    replyTo,
    subject: m.subject,
    messageId: m.messageIdHeader,
    references: m.references,
    bodyText: i.body,
    html: m.htmlHiddenText
      ? '<div style="display:none">hidden text detected at fetch time</div>'
      : null,
  };
  const capsNow = await caps(deps, tenantId, recipient.to);
  const guardCaps = {
    senderRepliesLast24h: capsNow.sender,
    maxPerSender24h: l.tenant.maxPerSender24h,
    tenantRepliesLastHour: capsNow.hour,
    maxPerHour: l.tenant.maxPerHour,
  };
  const allowlist = await withTenant(deps.sql, tenantId, (tx) => loadAllowlist(tx));
  let platform: OrderLookupSummary['platform'] | undefined = undefined;

  /** Wording only: the model gets the facts (or none) and writes in the customer's language. */
  async function word(
    excerpt: string | null,
    rule: string,
    extraLinks: string[],
  ): Promise<{ guarded: GuardedReply; excerpts: string[] } | null> {
    const prompt = buildGenerationPrompt({
      businessName: l.tenant.name,
      email: { fromName: m.fromName, subject: m.subject, bodyText: i.body },
      chunks: excerpt ? [{ id: 'order', content: excerpt }] : [],
      inboundLanguage: language,
      replyStyle: l.tenant.replyStyle,
      extraRules: [rule],
    });
    const gen = await generateJson(
      deps.llm,
      {
        tier: 'quality',
        origin: i.origin,
        system: prompt.system,
        parts: prompt.parts,
        maxOutputTokens: 1024,
      },
      GenerationSchema,
    );
    usage = addUsage(usage, gen.usage);
    llmCalls += gen.attempts;
    const extra = buildAllowlist(extraLinks.flatMap((u) => extractAllowlistEntries(u)));
    const allow = {
      urls: new Set([...allowlist.urls, ...extra.urls]),
      domains: new Set([...allowlist.domains, ...extra.domains]),
      emails: new Set([...allowlist.emails, ...extra.emails]),
    };
    const input = {
      tenant: { mode: l.tenant.mode, budgetState: i.budgetState, allowlist: allow },
      inbound,
      classification: i.classification,
      modelOutput: gen.ok ? gen.value : gen.raw,
      labels: prompt.labels,
      checkPrice: false,
      caps: guardCaps,
    };
    let guarded = guardReply({ ...input, verifier: 'not_run' });
    if (excerpt && guarded.decision.eligibleForVerification && guarded.replyText) {
      const v = await generateJson(
        deps.llm,
        {
          tier: 'fast',
          origin: i.origin,
          ...buildVerifierPrompt({ reply: guarded.replyText, excerpts: [excerpt] }),
          maxOutputTokens: 512,
        },
        VerifierSchema,
      );
      usage = addUsage(usage, v.usage);
      llmCalls += v.attempts;
      guarded = guardReply({
        ...input,
        verifier:
          v.ok && v.value.supported && v.value.unsupported_claims.length === 0
            ? 'passed'
            : 'failed',
      });
    }
    return { guarded, excerpts: excerpt ? [excerpt] : [] };
  }

  const report = (facts: OrderFacts, g: GuardedReply): GuardReport =>
    ({
      excerpts: [
        {
          label: 'S1',
          chunkId: null,
          type: 'order',
          title: `${platform === 'woocommerce' ? 'WooCommerce' : 'Shopify'} order ${facts.orderName}`,
          url: null,
          updatedAt: now.toISOString(),
          score: 1,
          cited: true,
        },
      ],
      claims: g.claims.map((c) => ({
        kind: c.kind,
        text: c.text,
        supported: !g.unsupportedClaims.includes(c),
      })),
      price: { asked: false, inExcerpts: [], inReply: [], omitted: false },
      conflicts: [],
      modelConflicts: [],
      decision: g.decision,
    }) as unknown as GuardReport;

  /** The owner gets it. Never a guess; for the customer at most a request for the order number and checkout e-mail. */
  async function handOver(
    reason: string,
    o: { facts?: OrderFacts; requested?: string; suggest?: boolean; hard?: boolean },
  ): Promise<{ outcome: ProcessOutcome }> {
    const lookup: OrderLookupSummary = o.facts
      ? summaryOf(o.facts, now, { result: 'escalated', reason, platform })
      : {
          result: 'escalated',
          reason,
          ...(o.requested ? { orderName: `#${o.requested}` } : {}),
          checkedAt: now.toISOString(),
        };
    let suggestion: { text: string; envelope: typeof envelope } | undefined;
    if (o.suggest && !o.hard) {
      const w = await word(null, VERIFY_RULE, []);
      const g = w?.guarded;
      if (
        g?.replyText &&
        !g.unsupportedClaims.length &&
        !g.injection.suspected &&
        g.claims.length === 0
      )
        suggestion = { text: g.replyText, envelope };
    }
    const ack = o.hard
      ? { send: false as const }
      : decideAcknowledgement({
          mode: l.tenant.mode,
          decision: { action: 'escalate', escalation: 'uncertain' },
          budgetState: i.budgetState,
          language,
          caps: guardCaps,
          injectionSuspected: false,
          replyToMismatch: recipient.replyToMismatch,
        });
    return {
      outcome: await escalate(
        deps,
        tenantId,
        l,
        leadId,
        {
          category: o.hard ? 'hard_list' : 'uncertain',
          reasons: ack.send ? [reason, 'acknowledgement_sent'] : [reason],
          summary: i.classification.summary,
          classification: i.classification,
          orderLookup: lookup,
          ...(suggestion ? { suggestion } : {}),
          ...(ack.send ? { acknowledgement: { text: ack.text, envelope } } : {}),
        },
        usage,
        llmCalls,
        i.embedTokens,
        null,
      ),
    };
  }

  // Things an order lookup never answers: a person does.
  if (mentionsChargeback(text)) return handOver('order_chargeback', { hard: true });
  if (asksForChange(text)) return handOver('order_change_request', { hard: true });

  // Ask the shop (read-only), only what is needed: the one number, or the sender's address.
  const found = await orders.providerFor(tenantId);
  if ('error' in found) return handOver('order_lookup_unavailable', {});
  const { provider } = found;
  platform = provider.platform;
  let byNumber: OrderRecord[] = [];
  let byEmail: OrderRecord[] = [];
  try {
    if (refs.numbers.length === 1) byNumber = await provider.findByNumber(refs.numbers[0]!);
    else if (refs.numbers.length === 0) byEmail = await provider.findByEmail(m.from.toLowerCase());
  } catch (e) {
    const code = e instanceof OrderLookupError ? e.code : 'UNAVAILABLE';
    if (code === 'AUTH' || code === 'SCOPE')
      await orders.markBroken(tenantId, code, provider.platform);
    return handOver('order_lookup_unavailable', {});
  }

  const decision: OrderDecision = decideOrder({
    numbers: refs.numbers,
    sender: m.from,
    byNumber,
    byEmail,
    now,
    staleDays: l.tenant.orderStaleDays,
  });
  // Access log for protected customer data: every time an order was read, with the outcome and no personal data.
  await withTenant(
    deps.sql,
    tenantId,
    (tx) => tx`
      insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
      values (${tenantId}, 'system', ${`${provider.platform}.order_lookup`}, 'message', ${m.id},
              ${tx.json({
                by: refs.numbers.length === 1 ? 'number' : 'email',
                matches: byNumber.length + byEmail.length,
                outcome: decision.kind === 'reply' ? 'answered' : decision.reason,
              })})`,
  );
  if (decision.kind === 'escalate')
    return handOver(decision.reason, {
      ...(decision.facts ? { facts: decision.facts } : {}),
      ...(refs.numbers.length === 1 ? { requested: refs.numbers[0]! } : {}),
      suggest: decision.suggestVerification,
    });

  // Verified and answerable: the model words it.
  const facts = decision.facts;
  const w = await word(
    factsForModel(facts),
    ORDER_RULE,
    facts.shipments.flatMap((s) => (s.trackingUrl ? [s.trackingUrl] : [])),
  );
  const guarded = w!.guarded;
  const lookup = summaryOf(facts, now, { result: 'found', platform });
  let d = guarded.decision;
  if (d.action === 'auto_send' && !decision.simple)
    d = {
      ...d,
      action: 'draft',
      reasons: [
        ...d.reasons,
        'order_needs_check',
        ...decision.notSimple,
      ] as unknown as typeof d.reasons,
    };

  if (d.action === 'escalate') {
    const ack = decideAcknowledgement({
      mode: l.tenant.mode,
      decision: d,
      budgetState: i.budgetState,
      language,
      caps: guardCaps,
      injectionSuspected: guarded.injection.suspected,
      replyToMismatch: guarded.replyToMismatch,
    });
    return {
      outcome: await escalate(
        deps,
        tenantId,
        l,
        leadId,
        {
          category: d.escalation ?? 'uncertain',
          reasons: ack.send ? [...d.reasons, 'acknowledgement_sent'] : d.reasons,
          summary: i.classification.summary,
          classification: i.classification,
          orderLookup: lookup,
          guardReport: report(facts, guarded),
          ...(ack.send ? { acknowledgement: { text: ack.text, envelope: guarded.envelope } } : {}),
        },
        usage,
        llmCalls,
        i.embedTokens,
        guarded,
      ),
    };
  }

  const autoSend = d.action === 'auto_send';
  await withTenant(deps.sql, tenantId, async (tx) => {
    const [draft] = await tx<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                                 source_chunk_ids, status, decided_by, decided_at)
      values (${tenantId}, ${m.threadId}, ${m.id}, 'reply', ${guarded.envelope.to}, ${guarded.envelope.subject},
              ${guarded.replyText}, ${[]}::uuid[], ${autoSend ? 'approved' : 'pending_approval'},
              ${autoSend ? 'auto' : null}, ${autoSend ? new Date() : null})
      returning id`;
    await writeProcessing(
      tx,
      m.id,
      'drafted',
      d.action,
      d.reasons,
      i.classification,
      guarded,
      [],
      usage,
      report(facts, guarded),
      lookup,
    );
    await recordUsage(tx, { tenantId, usage, llmCalls, embedTokens: i.embedTokens });
    await setLeadStage(
      tx,
      tenantId,
      leadId,
      'drafted',
      autoSend ? 'auto reply approved' : 'draft ready',
    );
    if (autoSend)
      await enqueue(tx, {
        tenantId,
        queue: QUEUES.mailSend,
        payload: { draftId: draft!.id, sentVia: 'auto' },
        singletonKey: draft!.id,
      });
    else
      await notifyOwner(tx, tenantId, `draft:${draft!.id}`, {
        kind: 'draft_ready',
        l,
        summary: i.classification.summary,
        action: d.action,
        reasons: d.reasons,
        draftText: guarded.replyText,
        unverifiedSuggestion: false,
        ref: { draftId: draft!.id, messageId: m.id },
      });
  });
  return { outcome: { status: autoSend ? 'auto_send' : 'drafted', reasons: d.reasons } };
}
