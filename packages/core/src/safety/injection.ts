import { foldForMatching, hasInvisible, wordRegex } from '../text/normalize.ts';

export type InjectionSignal =
  | 'instruction_override'
  | 'role_marker'
  | 'boundary_spoof'
  | 'exfiltration_request'
  | 'cc_request'
  | 'hidden_html_text'
  | 'invisible_characters'
  | 'encoded_payload'
  | 'ai_addressed';

export interface InjectionCheck {
  suspected: boolean;
  signals: InjectionSignal[];
}

const OVERRIDE_PHRASES = [
  // en
  '(?:ignore|disregard|forget|override|bypass)\\s+(?:all\\s+|any\\s+|the\\s+|your\\s+)*(?:previous|prior|above|earlier|preceding|system|original)?\\s*(?:instructions?|prompts?|rules?|guidelines?|directions?)',
  'new\\s+(?:instructions?|rules?|policy|system\\s+prompt)',
  'system\\s+prompt',
  '(?:you\\s+are\\s+now|from\\s+now\\s+on\\s+you|act\\s+as|pretend\\s+(?:to\\s+be|you\\s+are)|developer\\s+mode|jailbreak|dan\\s+mode)',
  '(?:set|change)\\s+(?:the\\s+)?(?:action|confidence|subject|recipient)',
  // de
  '(?:ignorier\\p{L}*|vergiss|missachte\\p{L}*)\\s+(?:alle\\s+|die\\s+)*(?:vorherigen\\s+|bisherigen\\s+|obigen\\s+)?(?:anweisungen|instruktionen|regeln)',
  'neue\\s+anweisungen?',
  // nl
  '(?:negeer|vergeet)\\s+(?:alle\\s+|de\\s+)*(?:eerdere\\s+|vorige\\s+|bovenstaande\\s+)?(?:instructies|regels|opdrachten)',
  'nieuwe\\s+instructies',
  // fr
  '(?:ignore[zr]?|oublie[zr]?)\\s+(?:toutes\\s+)?(?:les\\s+)?(?:instructions|consignes|règles)(?:\\s+précédentes)?',
  'nouvelles\\s+instructions',
  // es
  '(?:ignora\\p{L}*|olvida\\p{L}*)\\s+(?:todas\\s+)?(?:las\\s+)?(?:instrucciones|reglas|indicaciones)(?:\\s+anteriores)?',
  'nuevas\\s+instrucciones',
  // lv
  '(?:ignorē\\p{L}*|aizmirst\\p{L}*)\\s+(?:visas\\s+)?(?:iepriekšējās\\s+)?(?:instrukcijas|norādes|noteikumus)',
  'jaunas\\s+instrukcijas',
];

const ROLE_MARKER_RE =
  /(?:^|\n)\s*(?:system|assistant|developer|user)\s*:|<\s*\/?\s*(?:system|assistant|instructions?|prompt|email)\s*>|<\|im_(?:start|end)\|>|\[\/?INST\]|<<\s*SYS\s*>>|###\s*(?:system|instruction)/i;
const BOUNDARY_SPOOF_RE = /<{3,}|>{3,}|end_?email_?data|email_data_|kb_data_/i;
const EXFIL_RE = wordRegex(
  '(?:send|forward|email|share|export|leak|mail)\\s+(?:me\\s+|us\\s+)?(?:the\\s+|all\\s+|your\\s+|this\\s+|entire\\s+|whole\\s+|full\\s+|complete\\s+|a\\s+copy\\s+of\\s+)*(?:conversation|thread|emails?|customer\\s+(?:list|data(?:base)?)|database|contacts?|price\\s*list|internal|credentials?|passwords?|system\\s+prompt|instructions)',
  'iu',
);
const CC_RE = wordRegex(
  '(?:cc|bcc|copy\\s+in|carbon\\s+copy|add\\s+.{1,40}\\s+to\\s+(?:the\\s+)?(?:thread|conversation|email))',
  'iu',
);
const AI_ADDRESSED_RE = wordRegex(
  '(?:dear|hey|hi|attention|note\\s+(?:to|for))\\s+(?:the\\s+|our\\s+|your\\s+)?(?:ai|assistant|bot|chatbot|language\\s+model|llm|gpt|gemini|claude|noctiv)|(?:ai|assistant|bot|model)\\s+(?:note|instruction)s?',
  'iu',
);
// Long unbroken base64/hex blobs have no place in a customer enquiry.
const ENCODED_RE = /(?:[A-Za-z0-9+/]{120,}={0,2})|(?:[0-9a-f]{160,})/;
const HIDDEN_HTML_RE =
  /<[^>]+style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px|pt|em|rem)?\b|opacity\s*:\s*0(?:\.0+)?\b|max-height\s*:\s*0|color\s*:\s*(?:#fff(?:fff)?|white|transparent))[^"']*["'][^>]*>\s*[^<\s][^<]{8,}/i;

const OVERRIDE_RES = OVERRIDE_PHRASES.map((p) => wordRegex(p, 'iu'));

/**
 * Heuristic prompt-injection signals in an inbound email. Not a security
 * boundary by itself — the model is never allowed to act on its own — but any
 * signal makes the message ineligible for auto-send (PLAN.md §3.5 rule 6).
 */
export function detectInjection(input: {
  subject?: string | null;
  text: string;
  html?: string | null;
}): InjectionCheck {
  const raw = `${input.subject ?? ''}\n${input.text}`;
  const text = foldForMatching(raw);
  const signals = new Set<InjectionSignal>();

  if (OVERRIDE_RES.some((re) => re.test(text))) signals.add('instruction_override');
  if (ROLE_MARKER_RE.test(text)) signals.add('role_marker');
  if (BOUNDARY_SPOOF_RE.test(text)) signals.add('boundary_spoof');
  if (EXFIL_RE.test(text)) signals.add('exfiltration_request');
  if (CC_RE.test(text)) signals.add('cc_request');
  if (AI_ADDRESSED_RE.test(text)) signals.add('ai_addressed');
  if (ENCODED_RE.test(raw)) signals.add('encoded_payload');
  if (hasInvisible(raw) || (input.html && hasInvisible(input.html)))
    signals.add('invisible_characters');
  if (input.html && HIDDEN_HTML_RE.test(input.html)) signals.add('hidden_html_text');

  return { suspected: signals.size > 0, signals: [...signals] };
}
