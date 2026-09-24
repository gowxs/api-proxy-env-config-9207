/**
 * Prompt parts are typed so providers can keep untrusted content in its own
 * delimited block (PLAN.md §3.5). Full provider interfaces arrive in step 4.
 */
export type PromptPart =
  | { kind: 'instruction'; text: string }
  | { kind: 'untrusted_email'; text: string }
  | { kind: 'kb_context'; text: string };

export interface BuiltPrompt {
  system: string;
  parts: PromptPart[];
}
