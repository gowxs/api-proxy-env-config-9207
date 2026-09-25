import { isSupportedLanguage, type SupportedLanguage } from '../claims/lexicon.ts';
import type { PolicyDecision, PolicyInput, TenantMode } from './decide.ts';

/**
 * Mode 3 ("fully automatic"): a message Noctiv cannot answer from the knowledge
 * base gets this fixed acknowledgement while the owner is asked to reply.
 * Fixed text, never model output: it states no price, date or promise beyond
 * "a person will get back to you today" (founder-approved wording).
 */
export const ACKNOWLEDGEMENTS: Record<SupportedLanguage, string> = {
  en: "Thanks — I'll check this and get back to you today.",
  de: 'Danke! Ich prüfe das und melde mich heute noch bei Ihnen.',
  nl: 'Bedankt! Ik zoek dit uit en kom er vandaag nog bij u op terug.',
  fr: "Merci ! Je vérifie cela et je reviens vers vous aujourd'hui.",
  es: '¡Gracias! Lo reviso y le respondo hoy mismo.',
  lv: 'Paldies! Es to pārbaudīšu un atbildēšu Jums vēl šodien.',
};

export type AcknowledgementBlock =
  | 'not_full_auto'
  | 'not_uncertain'
  | 'budget_limited'
  | 'sender_cap_reached'
  | 'tenant_hour_cap_reached'
  | 'unsupported_language'
  | 'injection_suspected'
  | 'reply_to_mismatch';

export type AcknowledgementDecision =
  | { send: true; language: SupportedLanguage; text: string }
  | { send: false; blocked: AcknowledgementBlock[] };

/**
 * Whether an escalated inbound message gets the acknowledgement. Only for
 * "could not be grounded" escalations in full_auto; never for hard-list cases
 * (complaints, refunds, legal, discounts, angry, urgent). The acknowledgement is
 * an automatic send, so every safety gate of an automatic reply applies to it.
 */
export function decideAcknowledgement(input: {
  mode: TenantMode;
  decision: Pick<PolicyDecision, 'action' | 'escalation'>;
  budgetState: PolicyInput['tenant']['budgetState'];
  /** Language of the customer's message (classification). */
  language: string;
  caps: PolicyInput['caps'];
  injectionSuspected: boolean;
  replyToMismatch: boolean;
}): AcknowledgementDecision {
  const blocked: AcknowledgementBlock[] = [];
  if (input.mode !== 'full_auto') blocked.push('not_full_auto');
  if (input.decision.action !== 'escalate' || input.decision.escalation !== 'uncertain')
    blocked.push('not_uncertain');
  if (input.budgetState !== 'ok') blocked.push('budget_limited');
  if (input.caps.senderRepliesLast24h >= input.caps.maxPerSender24h)
    blocked.push('sender_cap_reached');
  if (input.caps.tenantRepliesLastHour >= input.caps.maxPerHour)
    blocked.push('tenant_hour_cap_reached');
  const language = input.language.toLowerCase();
  if (!isSupportedLanguage(language)) blocked.push('unsupported_language');
  if (input.injectionSuspected) blocked.push('injection_suspected');
  if (input.replyToMismatch) blocked.push('reply_to_mismatch');
  if (blocked.length || !isSupportedLanguage(language)) return { send: false, blocked };
  return { send: true, language, text: ACKNOWLEDGEMENTS[language] };
}
