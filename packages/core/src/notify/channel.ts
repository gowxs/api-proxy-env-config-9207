/**
 * Owner/admin notifications go through a channel interface. Phase 1 has one
 * implementation (email via the system mailer); a chat channel can be added
 * later without touching producers (founder decision after step 8).
 */
export type NotificationKind =
  | 'draft_ready'
  | 'escalation'
  | 'mailbox_disconnected'
  | 'send_failed'
  | 'budget_halted'
  | 'budget_state'
  /** The in-app free trial ends in 7 days / 1 day (app.queue_trial_reminders). */
  | 'trial_ending'
  /** One-off check that the system mailer reaches the owner (queued by an operator). */
  | 'test';

export interface NotificationLinks {
  /** Signed, single-decision links (draft_ready only). */
  approve?: string;
  reject?: string;
  /** Where the owner can see, edit or fix the item. */
  dashboard: string;
}

export interface Notification {
  id: string;
  tenantId: string;
  tenantName: string;
  audience: 'owner' | 'admin';
  kind: NotificationKind | (string & {});
  /** Stored payload; already reduced to privacy mode unless the tenant enabled full text. */
  payload: Record<string, unknown>;
  links: NotificationLinks;
  /** Extra facts looked up at delivery (e.g. the disconnected mailbox address). */
  facts?: Record<string, string>;
}

export interface NotificationChannel {
  readonly name: string;
  /** Throws on failure; the delivery loop retries with backoff. */
  deliver(n: Notification, recipients: string[]): Promise<void>;
}
