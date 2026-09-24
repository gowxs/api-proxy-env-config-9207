import type { TrainingPolicy } from '@noctiv/core';

export interface MailboxRef {
  tenantId: string;
  connectionId: string;
  isTestMailbox: boolean;
}

/**
 * Startup guard (founder decision, step 4): while a provider that may train
 * on submitted data is active, only mailboxes flagged is_test_mailbox are
 * processed at all — they are not even connected. Every model call is also
 * checked individually (assertOriginAllowed), so this is the second of two
 * independent locks.
 */
export function partitionMailboxes<T extends MailboxRef>(
  provider: { trainingPolicy: TrainingPolicy },
  mailboxes: T[],
): { allowed: T[]; refused: T[] } {
  if (provider.trainingPolicy === 'no_training') return { allowed: mailboxes, refused: [] };
  return {
    allowed: mailboxes.filter((m) => m.isTestMailbox),
    refused: mailboxes.filter((m) => !m.isTestMailbox),
  };
}
