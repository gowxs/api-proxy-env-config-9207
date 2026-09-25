import { z } from 'zod';

export const CATEGORIES = [
  'sales_inquiry',
  /** Asks what specific products or services would cost (Quotes beta; else like sales_inquiry). */
  'quote_request',
  'product_question',
  'support',
  'complaint',
  'refund',
  'legal_contract',
  'discount_request',
  'newsletter',
  'invoice_receipt',
  'spam',
  'personal',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Never answered by AI: escalated with no draft (PLAN.md §11, Q16). */
export const HARD_ESCALATION_CATEGORIES: readonly Category[] = [
  'complaint',
  'refund',
  'legal_contract',
  'discount_request',
];

/** Not customer conversations: recorded, never answered. */
export const SKIP_CATEGORIES: readonly Category[] = ['newsletter', 'invoice_receipt', 'spam'];

const languageCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?:[a-z]{2}|und)$/, 'ISO 639-1 code or "und"');

export const ClassificationSchema = z.strictObject({
  category: z.enum(CATEGORIES),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'angry']),
  urgency: z.enum(['normal', 'urgent']),
  language: languageCode,
  summary: z.string().trim().max(400),
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const ACTIONS = ['auto_send', 'draft', 'escalate'] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * The only thing the model may produce for a reply (brief: strict JSON).
 * `sources` holds the labels ("S1", "S2", …) of the knowledge-base chunks
 * the prompt showed; code maps them back to chunk ids.
 */
export const GenerationSchema = z.strictObject({
  intent: z.string().trim().min(1).max(200),
  language: languageCode,
  reply: z.string().max(6000),
  sources: z.array(z.string().trim().max(20)).max(12),
  confidence: z.number().min(0).max(1),
  action: z.enum(ACTIONS),
  escalate_reason: z.string().trim().max(500).nullable(),
});
export type Generation = z.infer<typeof GenerationSchema>;

/** Grounding verifier output (PLAN.md Q6): runs only on auto-send candidates. */
export const VerifierSchema = z.strictObject({
  supported: z.boolean(),
  unsupported_claims: z.array(z.string().max(300)).max(20),
});
export type Verification = z.infer<typeof VerifierSchema>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Accepts a raw model string or an already-parsed object. Never throws. */
export function parseModelJson<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
  let data = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'not valid JSON' };
    }
  }
  const result = schema.safeParse(data);
  return result.success
    ? { ok: true, value: result.data }
    : {
        ok: false,
        error: result.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; '),
      };
}
