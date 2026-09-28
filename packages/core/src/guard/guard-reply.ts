import { verifyClaims, type Claim } from '../claims/detect.ts';
import {
  asksForPrice,
  findSourceConflicts,
  pricesInExcerpts,
  type SourceConflict,
} from '../claims/source-checks.ts';
import {
  GenerationSchema,
  parseModelJson,
  type Classification,
  type Generation,
} from '../llm/schemas.ts';
import {
  buildReplySubject,
  buildThreadingHeaders,
  resolveReplyRecipient,
  type OriginalHeaders,
} from '../mail/reply-headers.ts';
import { decideAction, type PolicyDecision, type PolicyInput } from '../policy/decide.ts';
import { resolveSourceLabels, type LabelledChunk } from '../prompt/build.ts';
import type { Allowlist } from '../safety/allowlist.ts';
import { detectInjection, type InjectionCheck } from '../safety/injection.ts';
import { sanitizeReply, type Removal } from '../safety/sanitize-reply.ts';

export interface GuardInput {
  tenant: PolicyInput['tenant'] & { allowlist: Allowlist };
  inbound: OriginalHeaders & { bodyText: string; html?: string | null };
  classification: Classification;
  /** Raw model output (string or object); validated here. */
  modelOutput: unknown;
  /** Label map from buildGenerationPrompt. */
  labels: Map<string, LabelledChunk>;
  caps: PolicyInput['caps'];
  verifier?: PolicyInput['verifier'];
  /**
   * Hold a reply that leaves out a price the customer asked for and the
   * excerpts state. Off for follow-ups (a check-in, not an answer) and for the
   * part of a quote e-mail that a separate program prices.
   */
  checkPrice?: boolean;
}

export interface GuardedReply {
  decision: PolicyDecision;
  /** Built from the original headers only. */
  envelope: { to: string; subject: string; inReplyTo: string; references: string[] };
  /** Sanitized reply text (no signature yet), or null if nothing usable was generated. */
  replyText: string | null;
  generation: Generation | null;
  validationError: string | null;
  citedChunkIds: string[];
  removed: Removal[];
  claims: Claim[];
  unsupportedClaims: Claim[];
  injection: InjectionCheck;
  /** Reply-To points somewhere other than From (a hijack signal); blocks every automatic send. */
  replyToMismatch: boolean;
  /** Price and source-conflict checks, kept for the owner and the processing record. */
  sourceChecks: SourceChecks;
}

export interface SourceChecks {
  priceAsked: boolean;
  /** Amounts stated in the excerpts the model was shown. */
  excerptPrices: string[];
  /** Amounts in the reply that the cited excerpts back. */
  replyPrices: string[];
  priceOmitted: boolean;
  conflicts: SourceConflict[];
  /** What the model reported (labels resolved by the caller when shown). */
  modelConflicts: { fact: string; used: string; other: string[] }[];
}

/**
 * Everything between "the model returned something" and "code decides what to
 * do with it". Assumes the model may be fully compromised: its output can
 * only influence the body text, and that text is sanitized and checked
 * against the cited knowledge base before the policy engine decides.
 */
export function guardReply(input: GuardInput): GuardedReply {
  const injection = detectInjection({
    subject: input.inbound.subject,
    text: input.inbound.bodyText,
    html: input.inbound.html,
  });
  const recipient = resolveReplyRecipient(input.inbound);
  const threading = buildThreadingHeaders(input.inbound);
  const envelope = {
    to: recipient.to,
    subject: buildReplySubject(input.inbound.subject),
    inReplyTo: threading.inReplyTo,
    references: threading.references,
  };

  const parsed = parseModelJson(GenerationSchema, input.modelOutput);
  const generation = parsed.ok ? parsed.value : null;

  const sources = resolveSourceLabels(generation?.sources ?? [], input.labels);
  const sanitized = generation
    ? sanitizeReply(generation.reply, input.tenant.allowlist)
    : { text: '', removed: [] };
  const verification = generation
    ? verifyClaims(sanitized.text, {
        citedSources: sources.chunks.map((c) => c.content),
        inboundText: `${input.inbound.subject ?? ''}\n${input.inbound.bodyText}`,
      })
    : { claims: [], unsupported: [] };

  const inboundText = `${input.inbound.subject ?? ''}\n${input.inbound.bodyText}`;
  const excerpts = [...input.labels].map(([label, chunk]) => ({ label, chunk }));
  const priceAsked = asksForPrice(inboundText, input.classification.category);
  const excerptPrices = pricesInExcerpts(excerpts.map((e) => e.chunk.content));
  const replyPrices = verification.claims
    .filter((c) => c.kind === 'money' && !verification.unsupported.includes(c))
    .map((c) => c.text);
  const sourceChecks: SourceChecks = {
    priceAsked,
    excerptPrices,
    replyPrices,
    priceOmitted:
      input.checkPrice !== false &&
      priceAsked &&
      excerptPrices.length > 0 &&
      replyPrices.length === 0 &&
      sanitized.text.trim() !== '',
    conflicts: generation
      ? findSourceConflicts({ reply: sanitized.text, inboundText, excerpts })
      : [],
    modelConflicts: generation?.conflicts ?? [],
  };

  const decision = decideAction({
    tenant: { mode: input.tenant.mode, budgetState: input.tenant.budgetState },
    classification: input.classification,
    generation: generation ? { ...generation, reply: sanitized.text } : null,
    unknownSourceLabels: sources.unknown,
    citedSourceCount: sources.chunks.length,
    claimKinds: verification.claims.map((c) => c.kind),
    unsupportedClaimKinds: verification.unsupported.map((c) => c.kind),
    contentRemoved: sanitized.removed.length > 0,
    injectionSuspected: injection.suspected,
    replyToMismatch: recipient.replyToMismatch,
    caps: input.caps,
    verifier: input.verifier ?? 'not_run',
    sourceChecks: {
      priceOmitted: sourceChecks.priceOmitted,
      conflicts: sourceChecks.conflicts.map((c) => ({
        replyUsesPreferred: c.replyUsesPreferred,
        hasPreferred: Boolean(c.preferred),
      })),
      modelReportedConflicts: sourceChecks.modelConflicts.length,
    },
  });

  return {
    decision,
    envelope,
    replyText: decision.keepSuggestion && sanitized.text ? sanitized.text : null,
    generation,
    validationError: parsed.ok ? null : parsed.error,
    citedChunkIds: sources.chunks.map((c) => c.chunkId),
    removed: sanitized.removed,
    claims: verification.claims,
    unsupportedClaims: verification.unsupported,
    injection,
    replyToMismatch: recipient.replyToMismatch,
    sourceChecks,
  };
}
