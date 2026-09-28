import { BOOKING_LANGUAGES, offerBlock, offerText, signReplyLink } from '@noctiv/bookings';
import {
  addUsage,
  buildReplySubject,
  buildThreadingHeaders,
  detectInjection,
  resolveReplyRecipient,
  stripSignOff,
  type Classification,
  type DataOrigin,
  type TokenUsage,
} from '@noctiv/core';
import { enqueue, recordUsage, withTenant } from '@noctiv/db';
import { greetingName } from '@noctiv/quotes';
import { bookingPage, nextFreeSlots } from '../bookings/data.ts';
import { QUEUES } from '../queues.ts';
import { setLeadStage } from './leads.ts';
import type { Loaded, PipelineDeps, ProcessOutcome } from './process.ts';
import { generateGrounded, notifyOwner } from './process.ts';
import { withoutGreeting } from './quote.ts';

export interface BookingStepInput {
  classification: Classification;
  body: string;
  origin: DataOrigin;
  budgetState: 'ok' | 'draft_forced' | 'halted';
  usage: TokenUsage;
  llmCalls: number;
  embedTokens: number;
}
export type BookingStepResult =
  { outcome: ProcessOutcome } | { outcome: null; usage: TokenUsage; llmCalls: number };

/**
 * Bookings (beta), PLAN.md §29.6: a customer asks to meet, call or come by.
 * The reply offers the next 3 free times and the booking page (fixed text,
 * times computed in code), with the grounded answer to anything else they
 * asked below it (the D4 pattern from Quotes). No free time, no booking page
 * or no link secret: the normal reply path handles the message.
 */
export async function draftBookingOffer(
  deps: PipelineDeps,
  tenantId: string,
  l: Loaded,
  leadId: string,
  i: BookingStepInput,
): Promise<BookingStepResult> {
  const b = deps.bookings;
  const pass = { outcome: null, usage: i.usage, llmCalls: i.llmCalls } as const;
  if (!b?.secret) return pass;
  const m = l.message;
  const language = (BOOKING_LANGUAGES as readonly string[]).includes(i.classification.language)
    ? i.classification.language
    : null;

  const found = await withTenant(deps.sql, tenantId, async (tx) => {
    const [t] = await tx<{ timezone: string }[]>`select timezone from public.tenants`;
    const page = await bookingPage(tx, b.appUrl);
    if (!page) return null;
    const { slots } = await nextFreeSlots(tx, t!.timezone, 3);
    return slots.length ? { page, slots, timeZone: t!.timezone } : null;
  });
  if (!found) return pass;

  // Anything else the customer asked: a grounded answer, only when it passes every check.
  let usage = i.usage;
  let llmCalls = i.llmCalls;
  let embedTokens = i.embedTokens;
  let rest: { text: string; chunkIds: string[]; needsCheck: boolean } | null = null;
  const g = await generateGrounded(deps, tenantId, l, {
    body: i.body,
    origin: i.origin,
    classification: i.classification,
    budgetState: i.budgetState,
  });
  usage = addUsage(usage, g.usage);
  llmCalls += g.llmCalls;
  embedTokens += g.embedTokens;
  const d = g.guarded.decision;
  if (
    g.guarded.replyText &&
    d.action !== 'escalate' &&
    !g.guarded.unsupportedClaims.length &&
    g.guarded.citedChunkIds.length
  ) {
    rest = {
      text: stripSignOff(withoutGreeting(g.guarded.replyText)),
      chunkIds: g.guarded.citedChunkIds,
      needsCheck: d.action !== 'auto_send' && d.reasons.some((r) => r !== 'tenant_draft_only'),
    };
  }

  const url = `${found.page.url}?r=${signReplyLink(
    { tenantId, leadId, threadId: m.threadId, language },
    b.secret,
  )}`;
  const block = offerBlock({
    language,
    timeZone: found.timeZone,
    slots: found.slots,
    bookingUrl: url,
  });
  const body = [
    offerText({ language, customerName: greetingName(m.fromName), block }),
    ...(rest?.text ? [rest.text] : []),
  ].join('\n\n');

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

  return withTenant(deps.sql, tenantId, async (tx) => {
    const [caps] = await tx<{ sender: number; hour: number }[]>`
      select count(*) filter (where to_address = ${recipient.to} and created_at > now() - interval '24 hours')::int as sender,
             count(*) filter (where created_at > now() - interval '1 hour')::int as hour
      from public.outbound_emails o where sent_via = 'auto'
        -- Booking confirmations (customer-initiated) do not count against reply caps.
        and not exists (select 1 from public.drafts bd where bd.id = o.draft_id and bd.kind = 'booking')`;
    const reasons: string[] = [];
    if (l.tenant.mode === 'draft_only') reasons.push('tenant_draft_only');
    if (i.budgetState !== 'ok') reasons.push('budget_limited');
    if (caps!.sender >= l.tenant.maxPerSender24h) reasons.push('sender_cap_reached');
    if (caps!.hour >= l.tenant.maxPerHour) reasons.push('tenant_hour_cap_reached');
    if (injection.suspected) reasons.push('injection_suspected');
    if (recipient.replyToMismatch) reasons.push('reply_to_mismatch');
    if (!language) reasons.push('unsupported_language');
    if (l.backlog) reasons.push('arrived_while_paused');
    if (rest?.needsCheck) reasons.push('partial_answer_check');
    const autoSend = reasons.length === 0;

    const [draft] = await tx<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                                 source_chunk_ids, status, decided_by, decided_at, booking_offer)
      values (${tenantId}, ${m.threadId}, ${m.id}, 'booking_offer', ${envelope.to}, ${envelope.subject}, ${body},
              ${rest?.chunkIds ?? []}::uuid[], ${autoSend ? 'approved' : 'pending_approval'},
              ${autoSend ? 'auto' : null}, ${autoSend ? new Date() : null},
              ${tx.json({
                block,
                language,
                url,
                starts: found.slots.map((s) => s.start.toISOString()),
              } as never)})
      returning id`;
    if (autoSend)
      await enqueue(tx, {
        tenantId,
        queue: QUEUES.mailSend,
        payload: { draftId: draft!.id, sentVia: 'auto' },
        singletonKey: draft!.id,
      });
    const action = autoSend ? 'auto_send' : 'draft';
    await tx`
      update public.message_processing
      set status = 'drafted', final_action = ${action}, downgrade_reasons = ${reasons},
          classification = ${tx.json(i.classification)},
          model_output = ${tx.json({ bookingOffer: { slots: found.slots.length, rest: Boolean(rest) } })},
          confidence = null, retrieved_chunk_ids = ${rest?.chunkIds ?? []}::uuid[],
          tokens_in = ${usage.inputTokens}, tokens_out = ${usage.outputTokens + usage.thinkingTokens}, error = null
      where message_id = ${m.id}`;
    await recordUsage(tx, { tenantId, usage, llmCalls, embedTokens });
    await setLeadStage(tx, tenantId, leadId, 'drafted', autoSend ? 'times offered' : 'times ready');
    if (!autoSend)
      await notifyOwner(tx, tenantId, `draft:${draft!.id}`, {
        kind: 'draft_ready',
        l,
        summary: i.classification.summary,
        action: 'draft',
        reasons,
        draftText: body,
        unverifiedSuggestion: false,
        ref: { draftId: draft!.id, messageId: m.id },
      });
    return { outcome: { status: autoSend ? 'auto_send' : 'drafted', reasons } };
  });
}
