import {
  addUsage,
  buildReplySubject,
  buildThreadingHeaders,
  detectInjection,
  emailBlock,
  generateJson,
  newNonce,
  resolveReplyRecipient,
  stripSignOff,
  untrustedEmailRule,
  type Classification,
  type DataOrigin,
  type TokenUsage,
} from '@noctiv/core';
import { enqueue, recordUsage, withTenant } from '@noctiv/db';
import {
  buildQuoteMappingPrompt,
  clarifyingQuestionText,
  decideQuoteSend,
  greetingName,
  labelItems,
  loadConfirmedItems,
  loadQuoteDocument,
  allocateQuoteNumber,
  QUOTE_LANGUAGES,
  quoteAcceptUrl,
  quoteCoverFor,
  QuoteMappingSchema,
  signQuoteToken,
  validateMapping,
  writeQuoteLines,
  type ValidatedMapping,
} from '@noctiv/quotes';
import type { TransactionSql } from 'postgres';
import { QUEUES } from '../queues.ts';
import { setLeadStage } from './leads.ts';
import type { Loaded, PipelineDeps, ProcessOutcome } from './process.ts';
import { generateGrounded, notifyOwner } from './process.ts';

export interface QuoteStepInput {
  classification: Classification;
  body: string;
  origin: DataOrigin;
  budgetState: 'ok' | 'draft_forced' | 'halted';
  usage: TokenUsage;
  llmCalls: number;
  embedTokens: number;
}

/** The quote step either answers the message or hands it back to the normal reply path. */
export type QuoteStepResult =
  { outcome: ProcessOutcome } | { outcome: null; usage: TokenUsage; llmCalls: number };

/**
 * Quotes (beta), PLAN.md §21.3: map the request to the confirmed price list
 * (the model names items and quantities only), validate in code, then
 * either draft a quote (totals in code, fixed cover text) or ask one
 * clarifying question and tell the owner. Nothing on the price list or
 * nothing recognisable → the normal reply path handles the message.
 *
 * Some items matched, some not (founder decision D4): the quote covers the
 * matched items; the rest is answered in the same e-mail by a normal
 * grounded reply when the knowledge base answers it, otherwise the owner
 * gets a one-line note. The clarifying question is only for requests where
 * nothing matched.
 */
export async function draftQuote(
  deps: PipelineDeps,
  tenantId: string,
  l: Loaded,
  leadId: string,
  i: QuoteStepInput,
): Promise<QuoteStepResult> {
  const m = l.message;
  const items = await withTenant(deps.sql, tenantId, (tx) => loadConfirmedItems(tx));
  if (!items.length || !deps.quotes) return { outcome: null, usage: i.usage, llmCalls: i.llmCalls };

  const labels = labelItems(items.slice(0, 300));
  const nonce = newNonce();
  const prompt = buildQuoteMappingPrompt({
    emailBlock: emailBlock(nonce, { fromName: m.fromName, subject: m.subject, bodyText: i.body }),
    emailRule: untrustedEmailRule(nonce),
    labels,
  });
  const mapped = await generateJson(
    deps.llm,
    { tier: 'quality', origin: i.origin, ...prompt, maxOutputTokens: 1024 },
    QuoteMappingSchema,
  );
  const usage = addUsage(i.usage, mapped.usage);
  const llmCalls = i.llmCalls + mapped.attempts;
  if (!mapped.ok) return { outcome: null, usage, llmCalls };
  const mapping = validateMapping(mapped.value, labels, `${m.subject ?? ''}\n${i.body}`);
  if (!mapping.lines.length && !mapping.unmapped.length) return { outcome: null, usage, llmCalls };

  // The usual automatic-send guards, as for replies.
  const replyTo = m.replyTo ? [m.replyTo] : [];
  const recipient = resolveReplyRecipient({ from: m.from, replyTo });
  const threading = buildThreadingHeaders({
    messageId: m.messageIdHeader,
    references: m.references,
  });
  const envelope = { to: recipient.to, subject: buildReplySubject(m.subject), ...threading };
  const injection = detectInjection({
    subject: m.subject,
    text: i.body,
    html: m.htmlHiddenText ? '<div style="display:none">hidden</div>' : null,
  });
  const language = (QUOTE_LANGUAGES as readonly string[]).includes(i.classification.language)
    ? i.classification.language
    : null;

  // D4: the parts not on the price list get a grounded answer, if there is one.
  let rest: Rest | null = null;
  let step = { ...i, usage, llmCalls };
  if (mapping.lines.length && mapping.unmapped.length) {
    const g = await generateGrounded(deps, tenantId, l, {
      body: i.body,
      origin: i.origin,
      classification: i.classification,
      budgetState: i.budgetState,
      focus: mapping.unmapped.map((u) => u.customerText),
    });
    step = {
      ...step,
      usage: addUsage(step.usage, g.usage),
      llmCalls: step.llmCalls + g.llmCalls,
      embedTokens: step.embedTokens + g.embedTokens,
    };
    const d = g.guarded.decision;
    rest =
      g.guarded.replyText && d.action !== 'escalate' && !g.guarded.unsupportedClaims.length
        ? {
            text: stripSignOff(withoutGreeting(g.guarded.replyText)),
            chunkIds: g.guarded.citedChunkIds,
            // Anything but the tenant mode holding it: a person checks the whole e-mail.
            needsCheck:
              d.action !== 'auto_send' && d.reasons.some((r) => r !== 'tenant_draft_only'),
          }
        : { text: null, chunkIds: [], needsCheck: false };
  }

  return withTenant(deps.sql, tenantId, async (tx) => {
    const [caps] = await tx<{ sender: number; hour: number }[]>`
      select count(*) filter (where to_address = ${recipient.to} and created_at > now() - interval '24 hours')::int as sender,
             count(*) filter (where created_at > now() - interval '1 hour')::int as hour
      from public.outbound_emails where sent_via = 'auto'`;
    const guardReasons: string[] = [];
    if (i.budgetState !== 'ok') guardReasons.push('budget_limited');
    if (caps!.sender >= l.tenant.maxPerSender24h) guardReasons.push('sender_cap_reached');
    if (caps!.hour >= l.tenant.maxPerHour) guardReasons.push('tenant_hour_cap_reached');
    if (injection.suspected) guardReasons.push('injection_suspected');
    if (recipient.replyToMismatch) guardReasons.push('reply_to_mismatch');
    if (!language) guardReasons.push('unsupported_language');
    if (l.backlog) guardReasons.push('arrived_while_paused');

    const common = {
      tx,
      tenantId,
      l,
      leadId,
      envelope,
      mapping,
      i: step,
      usage: step.usage,
      llmCalls: step.llmCalls,
    };
    if (!mapping.lines.length)
      return { outcome: await clarify({ ...common, language, guardReasons }) };
    return {
      outcome: await quote({ ...common, language, guardReasons, rest, deps: deps.quotes! }),
    };
  });
}

/** D4: the answer for the parts a quote does not cover (text null: nothing to say). */
interface Rest {
  text: string | null;
  chunkIds: string[];
  needsCheck: boolean;
}

/** The quote cover already greets the customer; drop the reply's own greeting line. */
const GREETING =
  /^(hi|hello|hey|dear|good (morning|afternoon|evening)|hallo|guten tag|liebe[rs]?|sehr geehrte[rs]?|labdien|sveiki|labrīt|beste|geachte|goedendag|bonjour|bonsoir|cher|chère|hola|estimad[oa]|buenos días|buenas tardes)\b[^\n]{0,60}$/iu;
export function withoutGreeting(text: string): string {
  const lines = text.trim().split('\n');
  if (lines.length > 1 && GREETING.test(lines[0]!.trim())) lines.shift();
  return lines.join('\n').trim();
}

interface StepContext {
  tx: TransactionSql;
  tenantId: string;
  l: Loaded;
  leadId: string;
  envelope: { to: string; subject: string };
  mapping: ValidatedMapping;
  i: QuoteStepInput;
  usage: TokenUsage;
  llmCalls: number;
  language: string | null;
  guardReasons: string[];
}

async function insertDraft(
  c: StepContext,
  kind: 'reply' | 'quote',
  body: string,
  autoSend: boolean,
  chunkIds: string[] = [],
): Promise<string> {
  const m = c.l.message;
  const [draft] = await c.tx<{ id: string }[]>`
    insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                               source_chunk_ids, status, decided_by, decided_at)
    values (${c.tenantId}, ${m.threadId}, ${m.id}, ${kind}, ${c.envelope.to}, ${c.envelope.subject}, ${body},
            ${chunkIds}::uuid[], ${autoSend ? 'approved' : 'pending_approval'}, ${autoSend ? 'auto' : null},
            ${autoSend ? new Date() : null})
    returning id`;
  if (autoSend) {
    await enqueue(c.tx, {
      tenantId: c.tenantId,
      queue: QUEUES.mailSend,
      payload: { draftId: draft!.id, sentVia: 'auto' },
      singletonKey: draft!.id,
    });
  }
  return draft!.id;
}

async function finish(c: StepContext, action: 'auto_send' | 'draft', reasons: string[]) {
  await c.tx`
    update public.message_processing
    set status = 'drafted', final_action = ${action}, downgrade_reasons = ${reasons},
        classification = ${c.tx.json(c.i.classification)},
        model_output = ${c.tx.json({
          quoteMapping: {
            lines: c.mapping.lines.map((x) => ({
              itemId: x.item.id,
              qty: x.qty,
              assumed: x.qtyAssumed,
            })),
            unmapped: c.mapping.unmapped.map((u) => u.reason),
          },
        })},
        confidence = null, retrieved_chunk_ids = '{}'::uuid[],
        tokens_in = ${c.usage.inputTokens}, tokens_out = ${c.usage.outputTokens + c.usage.thinkingTokens}, error = null
    where message_id = ${c.l.message.id}`;
  await recordUsage(c.tx, {
    tenantId: c.tenantId,
    usage: c.usage,
    llmCalls: c.llmCalls,
    embedTokens: c.i.embedTokens,
  });
}

/** Nothing could be matched: one clarifying question (fixed text), and the owner is told. */
async function clarify(c: StepContext): Promise<ProcessOutcome> {
  const text = clarifyingQuestionText({
    language: c.language,
    customerName: greetingName(c.l.message.fromName),
    unmapped: c.mapping.unmapped.length
      ? c.mapping.unmapped
      : [{ customerText: c.l.message.subject ?? 'your request', reason: 'not_on_price_list' }],
  });
  const reasons = [
    ...(c.l.tenant.mode === 'draft_only' ? ['tenant_draft_only'] : []),
    ...c.guardReasons,
  ];
  const autoSend = reasons.length === 0;
  const draftId = await insertDraft(c, 'reply', text, autoSend);
  const action = autoSend ? 'auto_send' : 'draft';
  await finish(c, action, ['quote_unmapped', ...reasons]);
  await setLeadStage(c.tx, c.tenantId, c.leadId, 'drafted', 'quote needs clarification');
  const full = c.l.tenant.notifyFullText;
  await c.tx`
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    values (${c.tenantId}, 'email_owner', 'quote_needs_you', ${`quote_needs_you:${c.l.message.id}`},
            ${c.tx.json({
              threadId: c.l.message.threadId,
              draftId,
              messageId: c.l.message.id,
              questionSent: autoSend,
              unmappedCount: c.mapping.unmapped.length,
              // The customer's words are e-mail content: only with full-text notifications.
              ...(full
                ? { unmapped: c.mapping.unmapped.map((u) => u.customerText).slice(0, 5) }
                : {}),
            })})
    on conflict (tenant_id, dedupe_key) do nothing`;
  return { status: autoSend ? 'auto_send' : 'drafted', reasons: ['quote_unmapped', ...reasons] };
}

/**
 * A quote with totals from the price list and the fixed cover reply, for the
 * matched lines. Unmatched parts (D4): the grounded answer is added below
 * the cover, or the owner gets a one-line note.
 */
async function quote(
  c: StepContext & { deps: NonNullable<PipelineDeps['quotes']>; rest: Rest | null },
): Promise<ProcessOutcome> {
  const { tx, tenantId, l } = c;
  const number = await allocateQuoteNumber(tx, tenantId);
  const [t] = await tx<
    {
      valid_until: Date;
      currency: string;
      vat_mode: 'none' | 'exclusive' | 'inclusive';
      vat_rate: number;
      limit_cents: number;
    }[]
  >`
    select (now() at time zone timezone)::date + quotes_validity_days as valid_until,
              quotes_currency as currency, quotes_vat_mode as vat_mode,
              quotes_vat_rate::float8 as vat_rate, quotes_auto_send_limit_cents as limit_cents
    from public.tenants where id = ${tenantId}`;
  const [q] = await tx<{ id: string }[]>`
    insert into public.quotes (tenant_id, number, thread_id, lead_id, source_message_id, status, language,
                               customer_name, customer_email, currency, vat_mode, vat_rate,
                               subtotal_cents, vat_cents, total_cents, valid_until)
    values (${tenantId}, ${number}, ${l.message.threadId}, ${c.leadId}, ${l.message.id}, 'pending_approval',
            ${c.language ?? 'en'}, ${l.message.fromName?.slice(0, 200) ?? null}, ${c.envelope.to},
            ${t!.currency}, ${t!.vat_mode}, ${t!.vat_rate}, 0, 0, 0, ${t!.valid_until})
    returning id`;
  const totals = await writeQuoteLines(
    tx,
    { tenantId, quoteId: q!.id, vatMode: t!.vat_mode, vatRate: t!.vat_rate },
    c.mapping.lines.map((x) => ({ item: x.item, qty: x.qty, customerText: x.customerText })),
  );
  const decision = decideQuoteSend({
    mode: l.tenant.mode,
    mapping: c.mapping,
    totalCents: totals.totalCents,
    limitCents: t!.limit_cents,
    guardReasons: [...c.guardReasons, ...(c.rest?.needsCheck ? ['partial_answer_check'] : [])],
    unmappedHandled: c.rest !== null,
  });
  const doc = (await loadQuoteDocument(tx, q!.id))!;
  const token = signQuoteToken(
    { tenantId, quoteId: q!.id, validUntil: doc.validUntil },
    c.deps.secret,
  );
  const cover = [
    quoteCoverFor(doc, quoteAcceptUrl(c.deps.publicApiUrl, token)),
    ...(c.rest?.text ? [c.rest.text] : []),
  ].join('\n\n');
  const autoSend = decision.action === 'auto_send';
  const draftId = await insertDraft(c, 'quote', cover, autoSend, c.rest?.chunkIds ?? []);
  await tx`update public.quotes set draft_id = ${draftId}, hold_reasons = ${decision.reasons}
           where id = ${q!.id}`;
  await finish(c, decision.action, decision.reasons);
  await setLeadStage(
    tx,
    tenantId,
    c.leadId,
    'drafted',
    autoSend ? 'quote approved' : 'quote ready',
  );
  if (!autoSend) {
    await notifyOwner(tx, tenantId, `draft:${draftId}`, {
      kind: 'draft_ready',
      l,
      summary: c.i.classification.summary,
      action: 'draft',
      reasons: decision.reasons,
      draftText: cover,
      unverifiedSuggestion: false,
      ref: { draftId, messageId: l.message.id, quoteId: q!.id },
    });
  }
  if (c.rest && !c.rest.text) {
    // D4: the knowledge base does not answer the rest — one line for the owner.
    const full = l.tenant.notifyFullText;
    await tx`
      insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
      values (${tenantId}, 'email_owner', 'quote_needs_you', ${`quote_needs_you:${l.message.id}`},
              ${tx.json({
                threadId: l.message.threadId,
                draftId,
                messageId: l.message.id,
                quoteId: q!.id,
                partial: true,
                quoteSent: autoSend,
                unmappedCount: c.mapping.unmapped.length,
                ...(full
                  ? { unmapped: c.mapping.unmapped.map((u) => u.customerText).slice(0, 5) }
                  : {}),
              })})
      on conflict (tenant_id, dedupe_key) do nothing`;
  }
  return { status: autoSend ? 'auto_send' : 'drafted', reasons: decision.reasons };
}
