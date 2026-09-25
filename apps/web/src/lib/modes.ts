/** The three sending modes, in order from most to least cautious (one plan, owner's choice). */
export type Mode = 'draft_only' | 'auto_send' | 'full_auto';

export const MODES: { id: Mode; number: 1 | 2 | 3; title: string; line: string }[] = [
  {
    id: 'draft_only',
    number: 1,
    title: 'Approve everything',
    line: 'Every reply waits for your approval. Nothing is sent without you.',
  },
  {
    id: 'auto_send',
    number: 2,
    title: 'Auto-reply to grounded questions',
    line: 'Replies fully backed by your knowledge base go out on their own; everything else waits for you.',
  },
  {
    id: 'full_auto',
    number: 3,
    title: 'Fully automatic',
    line: 'Like mode 2, and questions it can’t answer get a short “I’ll check and get back to you as soon as possible” while you’re notified.',
  },
];

export const modeInfo = (m: Mode) => MODES.find((x) => x.id === m) ?? MODES[0]!;
export const modeRank = (m: Mode) => MODES.findIndex((x) => x.id === m);
