import {
  addUsage,
  asksForPrice,
  ASSISTANT_HELP,
  AssistantEvidence,
  AssistantStepSchema,
  buildAssistantSystem,
  generateJson,
  limitStep,
  newNonce,
  normalizeProposal,
  originForTenantKnowledge,
  TrainingDataPolicyError,
  ZERO_USAGE,
  type AssistantLanguage,
  type AssistantStep,
  type EmbeddingProvider,
  type LlmProvider,
  type NormalizedProposal,
  type PromptPart,
  type TokenUsage,
  type Logger,
} from '@noctiv/core';
import { currentBudget, recordUsage, withTenant, type Job } from '@noctiv/db';
import type { Sql } from 'postgres';
import { normalizeActions, type ActionCard } from '../assistant/actions.ts';
import { retrieveKnowledge } from '@noctiv/kb';
import { runTool } from '../assistant/tools.ts';

export interface AssistantDeps {
  sql: Sql;
  llm: LlmProvider;
  /** knowledge_search: the same retrieval as replies; without it, full-text search only. */
  embeddings?: EmbeddingProvider;
  /** A mailbox connection test (the health check), for the mailbox_check tool. */
  checkMailbox: (
    tenantId: string,
    connectionId: string,
  ) => Promise<{ ok: boolean; code?: string | null }>;
  logger?: Logger;
  /** MX lookup for the mailbox tool and card (DNS by default; a stub in tests). */
  resolveMx?: (domain: string) => Promise<{ exchange: string }[]>;
  /** Bookings (beta): signs intake form links for send_email cards. */
  formLink?: (tenantId: string, formId: string, leadId: string | null) => string;
  /** app.noctiv.io (booking page addresses in the bookings tool). */
  appUrl?: string;
}

export type AssistantTurnResult =
  | { ok: true; messageId: string }
  | { ok: false; error: 'budget_halted' | 'free_tier_refused' | 'model_error' | 'invalid_output' };

/**
 * An answer that asks the owner to type services or prices (the Latvian session of
 * 2026-09-28: "Lūdzu, nosauciet pakalpojumus un cenas" five times) while the knowledge base
 * was never searched. Six languages; matched on the answer only.
 */
const ASKS_FOR_FACTS =
  /(nosauciet|norādiet|uzrakstiet|pastāstiet|iedodiet|tell me|name|list|provide|specify|send me|nennen|geben sie|teilen sie|noem|geef|indiquez|donnez|dites|indique|dime|díganos)[^.?!\n]{0,80}(pakalpojum|cen[ai]|cenas|prec|servic|price|product|leistung|preis|produkt|dienst|prijs|prix|tarif|produit|precio|servicio|producto)/iu;

/** Model calls per owner message: tool lookups plus the answer. */
const MAX_STEPS = 5;

const FALLBACK: Record<AssistantLanguage, string> = {
  en: 'I could not check every number in my answer, so here are the facts as they are:',
  de: 'Ich konnte nicht jede Zahl in meiner Antwort prüfen, deshalb hier die Fakten, wie sie sind:',
  lv: 'Es nevarēju pārbaudīt katru skaitli savā atbildē, tāpēc šeit ir fakti, kādi tie ir:',
  nl: 'Ik kon niet elk getal in mijn antwoord controleren, daarom hier de feiten zoals ze zijn:',
  fr: 'Je n’ai pas pu vérifier chaque chiffre de ma réponse ; voici donc les faits tels quels :',
  es: 'No pude comprobar cada número de mi respuesta; aquí están los datos tal cual:',
};
const UNSURE: Record<AssistantLanguage, string> = {
  en: 'Sorry, I could not answer that reliably. Could you ask it another way?',
  de: 'Das konnte ich leider nicht zuverlässig beantworten. Können Sie es anders fragen?',
  lv: 'Diemžēl es nevarēju uz to droši atbildēt. Vai varat pajautāt citādi?',
  nl: 'Sorry, daar kon ik geen betrouwbaar antwoord op geven. Kun je het anders vragen?',
  fr: 'Désolé, je n’ai pas pu répondre de façon fiable. Pouvez-vous reformuler ?',
  es: 'Lo siento, no pude responder con seguridad. ¿Puedes preguntarlo de otra forma?',
};

const ACTION_TYPES = new Set([
  'create_document',
  'send_email',
  'mark_paid',
  'connect_mailbox',
  'create_quote',
]);

const NO_CARD: Record<AssistantLanguage, string> = {
  en: '(Some of this is not shown as a card: it is already set, or I could not use the values as given.)',
  de: '(Ein Teil davon erscheint nicht als Karte: Es ist bereits so eingestellt, oder ich konnte die Werte so nicht übernehmen.)',
  lv: '(Daļa no tā netiek rādīta kā kartīte: tas jau ir iestatīts, vai es nevarēju izmantot norādītās vērtības.)',
  nl: '(Een deel hiervan staat niet op een kaart: het is al zo ingesteld, of ik kon de waarden niet zo gebruiken.)',
  fr: '(Une partie n’apparaît pas sous forme de carte : c’est déjà réglé, ou je n’ai pas pu utiliser les valeurs telles quelles.)',
  es: '(Parte de esto no aparece como tarjeta: ya está configurado o no pude usar los valores tal como se dieron.)',
};

/** One line per earlier card, for the model: what it was and what the owner did. */
function describeCard(c: {
  type: string;
  title: string;
  payload: Record<string, unknown>;
  status: string;
  error: string | null;
  result?: Record<string, unknown> | null;
}): string {
  const p = c.payload;
  const what =
    c.type === 'settings'
      ? ((p.lines as [string, string][] | undefined) ?? []).map(([k, v]) => `${k}: ${v}`).join('; ')
      : c.type === 'knowledge_note'
        ? `knowledge note "${String(p.title ?? '')}"`
        : c.type === 'price_items'
          ? `price items: ${((p.items as { name: string }[] | undefined) ?? []).map((i) => i.name).join(', ')}`
          : c.type === 'create_document'
            ? `${String(p.docType)} with ${((p.lines as unknown[] | undefined) ?? []).length} line(s), due ${String(p.dueDate ?? '—')}`
            : c.type === 'send_email'
              ? `e-mail to ${String(p.to)}, subject "${String(p.subject ?? '')}"`
              : c.type === 'connect_mailbox'
                ? `connect form for ${String(p.email ?? p.label)}`
                : c.type === 'create_quote'
                  ? `quote to ${String(p.to)} with ${((p.lines as unknown[] | undefined) ?? []).length} line(s)`
                  : `mark ${String(p.number)} as paid`;
  const made =
    c.status === 'applied' && c.result?.number ? ` (created ${String(c.result.number)})` : '';
  const why = c.status === 'failed' && c.error ? ` (reason: ${c.error.slice(0, 200)})` : '';
  return `  [CARD (${c.status}): ${c.title} — ${what}${made}${why}]`;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/**
 * assistant.turn — Noctiv Assistant (PLAN.md §27). Answers the owner's latest
 * message: up to MAX_STEPS model calls, each either a read-only tool lookup
 * (tenant-scoped, run by code) or the answer with proposal cards. Numbers in
 * the answer must come from tool results, the help or the owner's messages;
 * proposals are validated by code and only applied when the owner confirms
 * (API). Costs count toward the daily AI budget; the free AI tier is refused
 * for real customer data, as for replies.
 */
export function assistantTurnHandler(deps: AssistantDeps) {
  return async (job: Job): Promise<AssistantTurnResult> => {
    const tenantId = job.tenantId;
    const { conversationId } = job.payload as { conversationId: string };
    const ctx = await withTenant(deps.sql, tenantId, async (tx) => {
      const [t] = await tx<Record<string, unknown>[]>`
        select name, website_url, timezone, mode, notify_full_text, followup_after_days, followup_max,
               max_replies_per_hour, max_ai_replies_per_sender_24h, reply_signature, quotes_enabled,
               quotes_currency, quotes_vat_mode, quotes_vat_rate::float8 as quotes_vat_rate,
               quotes_validity_days, quotes_auto_send_limit_cents, documents_enabled, auto_invoice_on_accept,
               auto_delivery_note_after_payment, seller_legal_name, seller_legal_address, seller_reg_no,
               seller_vat_no, seller_country, invoice_due_days, weekly_report_enabled,
               value_minutes_per_reply, value_minutes_per_followup, bookings_enabled
        from public.tenants where id = ${tenantId}`;
      const [conv] = await tx<{ locale: AssistantLanguage; purpose: 'app' | 'onboarding' }[]>`
        select locale, purpose from public.assistant_conversations where id = ${conversationId}`;
      const history = await tx<
        { id: string; role: 'owner' | 'assistant'; text: string; context_path: string | null }[]
      >`
        select id, role, text, context_path from (
          select id, role, text, context_path, created_at from public.assistant_messages
          where conversation_id = ${conversationId} order by created_at desc limit 16) h
        order by created_at`;
      // The cards already on screen and what the owner did with them.
      const cards = history.length
        ? await tx<
            {
              message_id: string;
              type: string;
              title: string;
              payload: Record<string, unknown>;
              status: string;
              error: string | null;
              result: Record<string, unknown> | null;
            }[]
          >`
            select message_id, type, title, payload, status, error, result from public.assistant_proposals
            where message_id in ${tx(history.map((m) => m.id))} order by created_at`
        : [];
      const mailboxes = await tx<{ is_test_mailbox: boolean }[]>`
        select is_test_mailbox from public.email_connections where status = 'connected'`;
      // An owner message that never got an answer (a failed turn) is not answered later.
      const answered = history.filter(
        (m, i) =>
          m.role === 'assistant' ||
          i === history.length - 1 ||
          history[i + 1]?.role === 'assistant',
      );
      return {
        t: t!,
        conv: conv!,
        history: answered,
        cards,
        budget: (await currentBudget(tx, tenantId)).state,
        origin: originForTenantKnowledge(
          mailboxes.map((m) => ({ isTestMailbox: m.is_test_mailbox })),
        ),
      };
    });
    if (ctx.budget === 'halted') return { ok: false, error: 'budget_halted' };
    if (deps.llm.trainingPolicy === 'may_train_on_data' && ctx.origin === 'customer_data')
      return { ok: false, error: 'free_tier_refused' };

    const t = ctx.t;
    const tz = String(t.timezone);
    const nonce = newNonce();
    const system = buildAssistantSystem({
      businessName: String(t.name),
      locale: ctx.conv.locale,
      purpose: ctx.conv.purpose,
      today: new Date().toLocaleDateString('en-GB', {
        timeZone: tz,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      }),
      timeZone: tz,
      nonce,
    });
    const evidence = new AssistantEvidence();
    evidence.add(ASSISTANT_HELP, 'help');
    for (const m of ctx.history) if (m.role === 'owner') evidence.add(m.text, 'owner');
    const latest = [...ctx.history].reverse().find((m) => m.role === 'owner');
    const threadHint = latest?.context_path?.match(
      /^\/(?:conversations|escalations)\/([^/?#]+)/,
    )?.[1];
    // The settings as they are now, so the model does not propose what is already set.
    const now = currentSettings(t);
    const settingsLine = `Current settings: ${SHOWN_SETTINGS.map(
      (k) =>
        `${k}=${typeof now[k] === 'string' && /^\d+\.\d+$/.test(now[k]) ? Number(now[k]) : String(now[k])}`,
    ).join('; ')}`;
    evidence.add(settingsLine, 'tool');
    const conversation = [
      settingsLine,
      `<<<CONVERSATION_${nonce}>>>`,
      ...ctx.history.flatMap((m) => [
        `${m.role === 'owner' ? 'OWNER' : 'ASSISTANT'}: ${m.text}`,
        ...ctx.cards.filter((c) => c.message_id === m.id).map(describeCard),
      ]),
      `<<<END_CONVERSATION_${nonce}>>>`,
      latest?.context_path ? `The owner is on the page ${latest.context_path}.` : '',
      threadHint && UUID.test(threadHint) ? `Conversation id of that page: ${threadHint}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const parts: PromptPart[] = [{ kind: 'instruction', text: conversation }];
    const facts: string[] = [];
    const toolsUsed: string[] = [];
    let usage: TokenUsage = ZERO_USAGE;
    let calls = 0;
    let final: AssistantStep | null = null;
    let language: AssistantLanguage = ctx.conv.locale;
    let retriedNumbers = false;
    let nudgedToKnowledge = false;
    let actionCards: ActionCard[] = [];
    const latestOwnerText = ctx.history.filter((m) => m.role === 'owner').at(-1)?.text ?? '';
    const ownerText = ctx.history
      .filter((m) => m.role === 'owner')
      .map((m) => m.text)
      .join('\n');

    for (let step = 0; step < MAX_STEPS && !final; step++) {
      const lastStep = step === MAX_STEPS - 1;
      let r;
      try {
        r = await generateJson(
          deps.llm,
          {
            tier: 'quality',
            origin: ctx.origin,
            system,
            parts: lastStep
              ? [...parts, { kind: 'instruction', text: 'Answer now (tool "none").' }]
              : parts,
            maxOutputTokens: 2000,
          },
          AssistantStepSchema,
        );
      } catch (e) {
        if (e instanceof TrainingDataPolicyError) return { ok: false, error: 'free_tier_refused' };
        // The error only: never the prompt or the owner's text.
        deps.logger?.warn(
          {
            tenantId,
            step,
            err: e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 500) : 'error',
          },
          'assistant model call failed',
        );
        await record(deps, tenantId, usage, calls);
        return { ok: false, error: 'model_error' };
      }
      usage = addUsage(usage, r.usage);
      calls += r.attempts;
      if (!r.ok) {
        await record(deps, tenantId, usage, calls);
        return { ok: false, error: 'invalid_output' };
      }
      const s = limitStep(r.value);
      language = s.language;
      if (s.tool !== 'none' && !lastStep) {
        const lines = await withTenant(deps.sql, tenantId, (tx) =>
          runTool(s.tool as Exclude<AssistantStep['tool'], 'none'>, s.tool_args, {
            tx,
            tenantId,
            timeZone: tz,
            nonce,
            checkMailbox: (id) => deps.checkMailbox(tenantId, id),
            ...(deps.resolveMx ? { resolveMx: deps.resolveMx } : {}),
            ...(deps.appUrl ? { appUrl: deps.appUrl } : {}),
            knowledge: {
              add: (e, content) => evidence.addKnowledge(e, content),
              get: (label) => evidence.knowledge(label),
            },
            ...(deps.embeddings
              ? {
                  searchKnowledge: async (query: string) =>
                    (
                      await retrieveKnowledge(
                        { sql: deps.sql, embeddings: deps.embeddings! },
                        {
                          tenantId,
                          query,
                          origin: ctx.origin,
                          limit: 6,
                          // The owner asks for prices or an offer: the priced notes come too.
                          priceQuestion: asksForPrice(latestOwnerText),
                        },
                      )
                    ).chunks,
                }
              : {}),
          }),
        );
        toolsUsed.push(s.tool);
        facts.push(...lines);
        for (const l of lines) evidence.add(l, 'tool');
        parts.push({
          kind: 'kb_context',
          text: [
            `<<<TOOL_RESULT_${nonce} ${s.tool}>>>`,
            ...lines,
            `<<<END_TOOL_RESULT_${nonce}>>>`,
          ].join('\n'),
        });
        continue;
      }
      // Document, e-mail and payment cards are checked against this business's data first:
      // what they state (totals, due dates) may then be said in the answer.
      const actions = await withTenant(deps.sql, tenantId, (tx) =>
        normalizeActions(
          s.proposals.filter((p) => ACTION_TYPES.has(p.type)),
          {
            tx,
            evidence,
            ownerText,
            language: s.language,
            ...(deps.resolveMx ? { resolveMx: deps.resolveMx } : {}),
            ...(deps.formLink
              ? {
                  formLink: (formId: string, leadId: string | null) =>
                    deps.formLink!(tenantId, formId, leadId),
                }
              : {}),
          },
        ),
      );
      actionCards = actions.cards;
      if (actions.dropped.length)
        deps.logger?.info({ tenantId, dropped: actions.dropped }, 'assistant proposals dropped');
      // Look it up instead of asking: once per turn, when the knowledge base has something.
      if (
        !nudgedToKnowledge &&
        !lastStep &&
        ASKS_FOR_FACTS.test(s.reply) &&
        !toolsUsed.some((t) => t === 'knowledge_search' || t === 'knowledge_read')
      ) {
        nudgedToKnowledge = true;
        const [kb] = await withTenant(
          deps.sql,
          tenantId,
          (tx) =>
            tx<
              { n: number }[]
            >`select count(*)::int as n from public.kb_sources where status = 'ready'`,
        );
        if (kb!.n > 0) {
          parts.push({
            kind: 'instruction',
            text: 'Do not ask the owner for services or prices before looking: call knowledge_search (and price_list) first, then answer from what they return.',
          });
          continue;
        }
      }
      const unsupported = evidence.unsupportedIn(s.reply);
      if (unsupported.length && !retriedNumbers && !lastStep) {
        retriedNumbers = true;
        parts.push({
          kind: 'instruction',
          text: `Your answer contained numbers that are in no tool result, the help or the owner's messages: ${unsupported.slice(0, 8).join(', ')}. Use a tool to look them up, or answer without them.`,
        });
        continue;
      }
      final = unsupported.length
        ? {
            ...s,
            reply: facts.length
              ? [FALLBACK[language], ...facts.map((f) => `• ${f}`)].join('\n')
              : UNSURE[language],
          }
        : s;
    }
    if (!final) {
      await record(deps, tenantId, usage, calls);
      return { ok: false, error: 'invalid_output' };
    }

    const settingsCards = final.proposals
      .filter((p) => !ACTION_TYPES.has(p.type))
      .map((p) =>
        normalizeProposal(p, {
          current: currentSettings(t),
          evidence,
          currency: String(t.quotes_currency),
          isTimezone,
        }),
      )
      .filter((p): p is NormalizedProposal => p !== null);
    const proposals: ActionCard[] = [...settingsCards, ...actionCards];
    // Excerpt labels (K1, …) are for the model and the cards; the owner reads the source's name.
    let reply =
      final.reply
        .replace(/\s*\(\s*\[?K\d{1,3}\]?(?:\s*,\s*\[?K\d{1,3}\]?)*\s*\)|\s*\[K\d{1,3}\]/g, '')
        .trim() || UNSURE[language];
    // The model proposed something that did not pass the checks: no card appears.
    if (final.proposals.length > proposals.length) reply = `${reply}\n\n${NO_CARD[language]}`;

    const messageId = await withTenant(deps.sql, tenantId, async (tx) => {
      const [m] = await tx<{ id: string }[]>`
        insert into public.assistant_messages (tenant_id, conversation_id, role, text, suggestions, tools_used)
        values (${tenantId}, ${conversationId}, 'assistant', ${reply.slice(0, 8000)},
                ${tx.json(
                  final.suggestions
                    .map((x) => x.trim())
                    .filter(Boolean)
                    .slice(0, 3),
                )}, ${toolsUsed})
        returning id`;
      let documentCardId: string | null = null;
      for (const p of proposals) {
        // An e-mail that attaches the document card above: linked by that card's id.
        const payload: Record<string, unknown> =
          p.type === 'send_email' && p.attachNew
            ? { ...p.payload, attachProposalId: documentCardId }
            : p.payload;
        const [row] = await tx<{ id: string }[]>`
          insert into public.assistant_proposals (tenant_id, conversation_id, message_id, type, title, payload,
                                                  requires_confirmation)
          values (${tenantId}, ${conversationId}, ${m!.id}, ${p.type}, ${p.title}, ${tx.json(payload as never)},
                  ${p.requiresConfirmation})
          returning id`;
        if (p.type === 'create_document') documentCardId = row!.id;
        await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
                 values (${tenantId}, 'system', 'assistant.proposed', 'assistant_proposal', ${row!.id},
                         ${tx.json({
                           type: p.type,
                           keys:
                             p.type === 'settings'
                               ? Object.keys((p.payload.changes ?? {}) as object)
                               : [],
                           requiresConfirmation: p.requiresConfirmation,
                         })})`;
      }
      if (toolsUsed.includes('mailbox_check'))
        await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
                 values (${tenantId}, 'system', 'assistant.mailbox_check', 'assistant_message', ${m!.id}, '{}'::jsonb)`;
      if (language !== ctx.conv.locale)
        await tx`update public.assistant_conversations set locale = ${language} where id = ${conversationId}`;
      else
        await tx`update public.assistant_conversations set updated_at = now() where id = ${conversationId}`;
      await recordUsage(tx, { tenantId, usage, llmCalls: calls });
      return m!.id;
    });
    return { ok: true, messageId };
  };
}

async function record(deps: AssistantDeps, tenantId: string, usage: TokenUsage, calls: number) {
  if (!calls) return;
  await withTenant(deps.sql, tenantId, (tx) =>
    recordUsage(tx, { tenantId, usage, llmCalls: calls }),
  );
}

function isTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz.includes('/') || tz === 'UTC';
  } catch {
    return false;
  }
}

/** Current values under the API field names, for "old → new" on the cards. */
/** Settings the model sees on every turn (the rest via tools). */
const SHOWN_SETTINGS = [
  'timezone',
  'quotesCurrency',
  'quotesVatRate',
  'quotesVatMode',
  'mode',
  'followupAfterDays',
  'followupMax',
  'quotesEnabled',
  'documentsEnabled',
  'weeklyReportEnabled',
  'bookingsEnabled',
];

function currentSettings(t: Record<string, unknown>): Record<string, unknown> {
  return {
    name: t.name,
    websiteUrl: t.website_url ?? undefined,
    timezone: t.timezone,
    mode: t.mode,
    notifyFullText: t.notify_full_text,
    followupAfterDays: t.followup_after_days,
    followupMax: t.followup_max,
    maxRepliesPerHour: t.max_replies_per_hour,
    maxAiRepliesPerSender24h: t.max_ai_replies_per_sender_24h,
    replySignature: t.reply_signature ?? undefined,
    quotesEnabled: t.quotes_enabled,
    quotesCurrency: t.quotes_currency,
    quotesVatMode: t.quotes_vat_mode,
    quotesVatRate: t.quotes_vat_rate,
    quotesValidityDays: t.quotes_validity_days,
    quotesAutoSendLimit: (Number(t.quotes_auto_send_limit_cents) / 100).toFixed(2),
    documentsEnabled: t.documents_enabled,
    autoInvoiceOnAccept: t.auto_invoice_on_accept,
    autoDeliveryNoteAfterPayment: t.auto_delivery_note_after_payment,
    sellerLegalName: t.seller_legal_name ?? undefined,
    sellerLegalAddress: t.seller_legal_address ?? undefined,
    sellerRegNo: t.seller_reg_no ?? undefined,
    sellerVatNo: t.seller_vat_no ?? undefined,
    sellerCountry: t.seller_country ?? undefined,
    invoiceDueDays: t.invoice_due_days,
    weeklyReportEnabled: t.weekly_report_enabled,
    bookingsEnabled: t.bookings_enabled,
    valueMinutesPerReply: t.value_minutes_per_reply,
    valueMinutesPerFollowup: t.value_minutes_per_followup,
  };
}
