import { z } from 'zod';
import { findNumbers, numberSet } from '../claims/numbers.ts';
import { foldForMatching } from '../text/normalize.ts';

/**
 * Noctiv Assistant (PLAN.md §27): what the model may return, and the rules
 * that turn its suggestions into proposal cards. The model never changes
 * anything: a card is applied by the API only when the owner confirms, and
 * with the same validation as the page it belongs to. Settings, knowledge
 * notes, price items, documents (created as Ready), e-mails (sent through
 * Compose, always behind the confirmation dialog) and "mark as paid" — never
 * approving drafts or touching billing.
 */

export const ASSISTANT_LANGUAGES = ['en', 'de', 'lv', 'nl', 'fr', 'es'] as const;
export type AssistantLanguage = (typeof ASSISTANT_LANGUAGES)[number];

export const ASSISTANT_TOOLS = [
  'account_overview',
  'value_report',
  'open_quotes',
  'escalations',
  'knowledge_status',
  'price_list',
  'mailbox_check',
  'locale_defaults',
  'find_customer',
  'documents',
] as const;
export type AssistantTool = (typeof ASSISTANT_TOOLS)[number];

export const VALUE_PERIODS = ['this_week', 'last_week', 'this_month', 'last_month'] as const;

export const ASSISTANT_PROPOSAL_TYPES = [
  'settings',
  'knowledge_note',
  'price_items',
  'create_document',
  'send_email',
  'mark_paid',
] as const;
export type AssistantProposalType = (typeof ASSISTANT_PROPOSAL_TYPES)[number];

/** One step of the assistant: call a read-only tool, or answer (with optional proposals). */
export const AssistantStepSchema = z.strictObject({
  /** The language of the owner's latest message, when it is one of the six. */
  language: z.enum(ASSISTANT_LANGUAGES),
  tool: z.enum([...ASSISTANT_TOOLS, 'none']),
  tool_args: z.strictObject({
    period: z.enum(VALUE_PERIODS).nullable(),
    thread_id: z.string().max(40).nullable(),
    timezone: z.string().max(60).nullable(),
    /** find_customer: a name or e-mail address the owner used. */
    query: z.string().max(200).nullable(),
  }),
  reply: z.string().max(4000),
  proposals: z.array(
    z.strictObject({
      type: z.enum(ASSISTANT_PROPOSAL_TYPES),
      title: z.string().max(120),
      settings: z.array(z.strictObject({ key: z.string().max(40), value: z.string().max(1000) })),
      note_title: z.string().max(200),
      note_text: z.string().max(6000),
      /** price_items, and the lines of create_document ("qty" empty = 1). */
      items: z.array(
        z.strictObject({
          name: z.string().max(200),
          unit: z.string(),
          qty: z.string(),
          price: z.string(),
        }),
      ),
      /** create_document: "invoice" or "delivery_note". */
      doc_type: z.string().max(20),
      /** create_document / send_email: the customer's name or e-mail as the owner wrote it. */
      customer: z.string().max(200),
      /** create_document: the buyer's address, only as the owner wrote it ("" = the one on file). */
      customer_address: z.string().max(500),
      /** create_document: days until due as the owner said, or a date (YYYY-MM-DD). */
      due_in_days: z.string().max(10),
      due_date: z.string().max(10),
      /** send_email. */
      email_to: z.string().max(254),
      email_subject: z.string().max(200),
      email_body: z.string().max(5000),
      /** send_email: document numbers to attach, or "NEW" for the document card in this answer. */
      attach: z.array(z.string().max(40)),
      /** mark_paid: the document number. */
      document_number: z.string().max(40),
    }),
  ),
  suggestions: z.array(z.string().max(80)),
});
export type AssistantStep = z.infer<typeof AssistantStepSchema>;

/**
 * Array limits are applied here, not in the schema: Gemini's structured
 * output rejects this schema with maxItems on its arrays (HTTP 400).
 */
export function limitStep(s: AssistantStep): AssistantStep {
  return {
    ...s,
    proposals: s.proposals.slice(0, 3).map((p) => ({
      ...p,
      settings: p.settings.slice(0, 12),
      items: p.items.slice(0, 30),
      attach: p.attach.slice(0, 5),
    })),
    suggestions: s.suggestions.slice(0, 3),
  };
}

type Kind =
  | { kind: 'bool' }
  | { kind: 'int'; min: number; max: number }
  | { kind: 'rate' }
  | { kind: 'money' }
  | { kind: 'text'; max: number; min?: number }
  | { kind: 'enum'; values: readonly string[] }
  | { kind: 'timezone' }
  | { kind: 'currency' }
  | { kind: 'url' };

interface SettingDef {
  label: string;
  /** Changes what Noctiv sends on its own: the confirmation dialog is required. */
  sending: boolean;
  type: Kind;
}

const MODE_LABELS: Record<string, string> = {
  draft_only: 'Mode 1 (approve everything)',
  auto_send: 'Mode 2 (auto-reply to grounded questions)',
  full_auto: 'Mode 3 (fully automatic)',
};
const VAT_LABELS: Record<string, string> = {
  none: 'No VAT',
  exclusive: 'Prices exclude VAT',
  inclusive: 'Prices include VAT',
};

/** The settings the assistant may propose (API PATCH /v1/tenants/:id field names). */
export const ASSISTANT_SETTINGS: Record<string, SettingDef> = {
  name: { label: 'Business name', sending: false, type: { kind: 'text', max: 200, min: 1 } },
  websiteUrl: { label: 'Website', sending: false, type: { kind: 'url' } },
  timezone: { label: 'Time zone', sending: false, type: { kind: 'timezone' } },
  mode: {
    label: 'Reply mode',
    sending: true,
    type: { kind: 'enum', values: ['draft_only', 'auto_send', 'full_auto'] },
  },
  notifyFullText: {
    label: 'Full text in notification e-mails',
    sending: false,
    type: { kind: 'bool' },
  },
  followupAfterDays: {
    label: 'Follow up after (business days)',
    sending: true,
    type: { kind: 'int', min: 1, max: 30 },
  },
  followupMax: {
    label: 'Follow-ups per conversation',
    sending: true,
    type: { kind: 'int', min: 0, max: 2 },
  },
  maxRepliesPerHour: {
    label: 'Automatic replies per hour',
    sending: true,
    type: { kind: 'int', min: 1, max: 500 },
  },
  maxAiRepliesPerSender24h: {
    label: 'Automatic replies per customer per day',
    sending: true,
    type: { kind: 'int', min: 0, max: 2 },
  },
  replySignature: { label: 'Signature', sending: false, type: { kind: 'text', max: 1000 } },
  quotesEnabled: { label: 'Quotes (beta)', sending: true, type: { kind: 'bool' } },
  quotesCurrency: { label: 'Currency', sending: false, type: { kind: 'currency' } },
  quotesVatMode: {
    label: 'Prices and VAT',
    sending: false,
    type: { kind: 'enum', values: ['none', 'exclusive', 'inclusive'] },
  },
  quotesVatRate: { label: 'VAT rate (%)', sending: false, type: { kind: 'rate' } },
  quotesValidityDays: {
    label: 'Quotes valid for (days)',
    sending: false,
    type: { kind: 'int', min: 1, max: 365 },
  },
  quotesAutoSendLimit: {
    label: 'Automatic-send limit for quotes',
    sending: true,
    type: { kind: 'money' },
  },
  documentsEnabled: { label: 'Documents (beta)', sending: true, type: { kind: 'bool' } },
  autoInvoiceOnAccept: {
    label: 'Invoice when a quote is accepted',
    sending: true,
    type: { kind: 'bool' },
  },
  autoDeliveryNoteAfterPayment: {
    label: 'Delivery note after payment',
    sending: true,
    type: { kind: 'bool' },
  },
  sellerLegalName: { label: 'Legal name', sending: false, type: { kind: 'text', max: 200 } },
  sellerLegalAddress: { label: 'Legal address', sending: false, type: { kind: 'text', max: 500 } },
  sellerRegNo: { label: 'Registration number', sending: false, type: { kind: 'text', max: 40 } },
  sellerVatNo: { label: 'VAT number', sending: false, type: { kind: 'text', max: 30 } },
  sellerCountry: { label: 'Country', sending: false, type: { kind: 'text', max: 60 } },
  invoiceDueDays: {
    label: 'Invoices due after (days)',
    sending: false,
    type: { kind: 'int', min: 0, max: 365 },
  },
  weeklyReportEnabled: { label: 'Weekly summary e-mail', sending: false, type: { kind: 'bool' } },
  valueMinutesPerReply: {
    label: 'Minutes per reply (hours saved)',
    sending: false,
    type: { kind: 'int', min: 1, max: 60 },
  },
  valueMinutesPerFollowup: {
    label: 'Minutes per follow-up (hours saved)',
    sending: false,
    type: { kind: 'int', min: 0, max: 60 },
  },
};

export const MODE_RANK: Record<string, number> = { draft_only: 0, auto_send: 1, full_auto: 2 };

/** "12", "12.5", "12,50", "1 200,00", "€ 4.90" → cents; null if not a plain amount. */
export function parseAmountToCents(raw: string): number | null {
  const s = raw.replace(/[€$£\s]|eur|gbp|usd/gi, '').replace(/'/g, '');
  if (!/^\d{1,3}([.,\u00a0 ]?\d{3})*([.,]\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(s)) return null;
  const m = /^(.*?)(?:[.,](\d{1,2}))?$/.exec(s)!;
  const whole = m[1]!.replace(/[.,\u00a0 ]/g, '');
  const cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  const v = Number(whole) * 100 + cents;
  return Number.isSafeInteger(v) && v >= 0 && v <= 100_000_000_00 ? v : null;
}

/** Numbers the assistant may use: from the owner's messages, tool results and the help. */
export class AssistantEvidence {
  readonly #all = new Set<string>();
  readonly #owner = new Set<string>();
  add(text: string, from: 'owner' | 'tool' | 'help') {
    for (const n of numberSet(foldForMatching(text))) {
      this.#all.add(n);
      if (from === 'owner') this.#owner.add(n);
    }
  }
  /** Every number in `text` has a reading the evidence backs. */
  unsupportedIn(text: string): string[] {
    return findNumbers(foldForMatching(text))
      .filter((n) => !n.readings.some((r) => this.#all.has(r)))
      .map((n) => n.raw);
  }
  has(value: number, ownerOnly = false): boolean {
    const set = ownerOnly ? this.#owner : this.#all;
    return set.has(String(value));
  }
}

export interface NormalizedProposal {
  type: AssistantProposalType;
  title: string;
  payload: Record<string, unknown>;
  requiresConfirmation: boolean;
}

export interface ProposalContext {
  /** Current values, by the same keys (for "old → new" and to skip no-ops). */
  current: Record<string, unknown>;
  evidence: AssistantEvidence;
  currency: string;
  isTimezone: (tz: string) => boolean;
}

const show = (key: string, v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  if (key === 'mode') return MODE_LABELS[String(v)] ?? String(v);
  if (key === 'quotesVatMode') return VAT_LABELS[String(v)] ?? String(v);
  if (typeof v === 'boolean') return v ? 'On' : 'Off';
  return String(v);
};

/**
 * One setting value from the model's text form, checked like the API would.
 * Numbers must come from the conversation or tool results (never invented).
 */
function parseSetting(key: string, raw: string, ctx: ProposalContext): unknown | undefined {
  const def = ASSISTANT_SETTINGS[key];
  if (!def) return undefined;
  const v = raw.trim();
  const t = def.type;
  switch (t.kind) {
    case 'bool':
      return /^(true|on|yes|1)$/i.test(v)
        ? true
        : /^(false|off|no|0)$/i.test(v)
          ? false
          : undefined;
    case 'int': {
      if (!/^\d{1,4}$/.test(v)) return undefined;
      const n = Number(v);
      return n >= t.min && n <= t.max && ctx.evidence.has(n) ? n : undefined;
    }
    case 'rate': {
      const n = Number(v.replace(',', '.').replace('%', ''));
      return Number.isFinite(n) && n >= 0 && n < 100 && ctx.evidence.has(n) ? n : undefined;
    }
    case 'money': {
      const c = parseAmountToCents(v);
      return c !== null && ctx.evidence.has(c / 100) ? (c / 100).toFixed(2) : undefined;
    }
    case 'text': {
      if (v.length > t.max || v.length < (t.min ?? 0)) return undefined;
      // Free text may not smuggle in numbers nobody said (a VAT or reg. number, a signature line).
      return ctx.evidence.unsupportedIn(v).length ? undefined : v;
    }
    case 'enum':
      return t.values.includes(v) ? v : undefined;
    case 'timezone':
      return ctx.isTimezone(v) ? v : undefined;
    case 'currency':
      return /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : undefined;
    case 'url':
      try {
        const u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
      } catch {
        return undefined;
      }
  }
}

/** Turns one model proposal into a card, or null when nothing valid is left. */
export function normalizeProposal(
  p: AssistantStep['proposals'][number],
  ctx: ProposalContext,
): NormalizedProposal | null {
  const title = p.title.trim().slice(0, 120) || 'Proposed change';
  if (p.type === 'settings') {
    const changes: Record<string, unknown> = {};
    const lines: [string, string][] = [];
    // Values the model proposed that are already set: shown, so the card matches its text.
    const unchanged: [string, string][] = [];
    for (const { key, value } of p.settings) {
      const parsed = parseSetting(key, value, ctx);
      if (parsed === undefined || key in changes) continue;
      const cur = ctx.current[key];
      if (cur !== undefined && String(cur) === String(parsed)) {
        if (!unchanged.some(([l]) => l === ASSISTANT_SETTINGS[key]!.label))
          unchanged.push([ASSISTANT_SETTINGS[key]!.label, `${show(key, cur)} (already set)`]);
        continue;
      }
      changes[key] = parsed;
      const def = ASSISTANT_SETTINGS[key]!;
      lines.push([
        def.label,
        cur === undefined ? show(key, parsed) : `${show(key, cur)} → ${show(key, parsed)}`,
      ]);
    }
    if (!lines.length) return null;
    const keys = Object.keys(changes);
    const modeDown =
      typeof changes.mode === 'string' &&
      MODE_RANK[changes.mode]! <= (MODE_RANK[String(ctx.current.mode)] ?? 0);
    const requiresConfirmation = keys.some(
      (k) => ASSISTANT_SETTINGS[k]!.sending && !(k === 'mode' && modeDown),
    );
    return {
      type: 'settings',
      title,
      payload: { changes, lines: [...lines, ...unchanged] },
      requiresConfirmation,
    };
  }
  if (p.type === 'knowledge_note') {
    const noteTitle = p.note_title.trim().slice(0, 200);
    const text = p.note_text.trim();
    // A note becomes facts customers are told: every number must be the owner's own.
    if (!noteTitle || text.length < 10) return null;
    const invented = findNumbers(foldForMatching(`${noteTitle}\n${text}`)).filter(
      (n) => !n.readings.some((r) => ctx.evidence.has(Number(r), true)),
    );
    if (invented.length) return null;
    return {
      type: 'knowledge_note',
      title,
      payload: { title: noteTitle, text },
      requiresConfirmation: false,
    };
  }
  // Documents, e-mails and payments need the business's data: checked in the worker (actions.ts).
  if (p.type !== 'price_items') return null;
  const items = p.items
    .map((i) => ({
      name: i.name.trim(),
      unit: i.unit.trim() || 'pcs',
      cents: parseAmountToCents(i.price),
    }))
    .filter(
      (i) =>
        i.name &&
        i.cents !== null &&
        i.cents > 0 &&
        // Prices only as the owner wrote them.
        ctx.evidence.has(i.cents / 100, true),
    )
    .map((i) => ({ name: i.name, unit: i.unit, unitPriceCents: i.cents!, currency: ctx.currency }));
  if (!items.length) return null;
  return { type: 'price_items', title, payload: { items }, requiresConfirmation: false };
}
