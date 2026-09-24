import type { DataOrigin, TrainingPolicy } from './types.ts';

export class TrainingDataPolicyError extends Error {
  constructor(provider: string) {
    super(
      `Refusing to send customer data to ${provider}: its terms allow training on submitted data. ` +
        'Only mailboxes flagged is_test_mailbox and test fixtures may use this provider.',
    );
    this.name = 'TrainingDataPolicyError';
  }
}

/**
 * Fail-closed check run by every provider before any network call: customer
 * data never reaches a provider that may train on it.
 */
export function assertOriginAllowed(
  provider: string,
  policy: TrainingPolicy,
  origin: DataOrigin,
): void {
  if (policy === 'may_train_on_data' && origin !== 'test_mailbox' && origin !== 'test_fixture') {
    throw new TrainingDataPolicyError(provider);
  }
}

/** The data origin of a message from a given mailbox. */
export function originForMailbox(mailbox: { isTestMailbox: boolean }): DataOrigin {
  return mailbox.isTestMailbox ? 'test_mailbox' : 'customer_data';
}

/**
 * A tenant's knowledge base counts as test data only if every mailbox the
 * tenant has connected is a test mailbox (and there is at least one).
 */
export function originForTenantKnowledge(mailboxes: { isTestMailbox: boolean }[]): DataOrigin {
  return mailboxes.length > 0 && mailboxes.every((m) => m.isTestMailbox)
    ? 'test_mailbox'
    : 'customer_data';
}
