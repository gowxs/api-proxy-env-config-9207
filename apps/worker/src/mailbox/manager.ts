import type { Logger } from '@noctiv/core';
import { enqueueFor, withTenant } from '@noctiv/db';
import { partitionMailboxes } from '@noctiv/llm';
import { openMailboxPassword } from '@noctiv/mail';
import type { TrainingPolicy } from '@noctiv/core';
import type { Sql } from 'postgres';
import { listConnectedMailboxes } from '../mailboxes.ts';
import { QUEUES } from '../queues.ts';
import { loadConnection, markDisconnected } from './connection-repo.ts';
import { MailboxListener, type ListenerOptions } from './listener.ts';

export interface ManagerDeps {
  sql: Sql;
  logger: Logger;
  keys: { publicKey: string; privateKey: string };
  provider: { trainingPolicy: TrainingPolicy };
  listener?: ListenerOptions;
}

/**
 * Starts one listener per connected mailbox the current LLM provider may
 * process (free tier: test mailboxes only), and stops listeners for mailboxes
 * that were removed or disconnected. Call refresh() periodically.
 */
export class MailboxManager {
  private readonly listeners = new Map<string, MailboxListener>();
  private readonly deps: ManagerDeps;

  constructor(deps: ManagerDeps) {
    this.deps = deps;
  }

  get active(): string[] {
    return [...this.listeners.keys()];
  }

  listener(connectionId: string): MailboxListener | undefined {
    return this.listeners.get(connectionId);
  }

  async refresh(): Promise<void> {
    const { allowed, refused } = partitionMailboxes(
      this.deps.provider,
      await listConnectedMailboxes(this.deps.sql),
    );
    if (refused.length) {
      this.deps.logger.warn(
        { refused: refused.map((m) => m.connectionId) },
        'mailboxes not processed: free-tier provider and not flagged is_test_mailbox',
      );
    }
    const wanted = new Set(allowed.map((m) => m.connectionId));
    for (const [id, l] of this.listeners) {
      if (!wanted.has(id)) {
        await l.stop();
        this.listeners.delete(id);
      }
    }
    for (const m of allowed) {
      if (this.listeners.has(m.connectionId)) continue;
      const conn = await withTenant(this.deps.sql, m.tenantId, (tx) =>
        loadConnection(tx, m.connectionId),
      );
      if (!conn) continue;
      const fetch = () =>
        void enqueueFor(this.deps.sql, {
          tenantId: m.tenantId,
          queue: QUEUES.mailFetch,
          payload: { connectionId: m.connectionId },
          singletonKey: m.connectionId,
        }).catch((e: unknown) =>
          this.deps.logger.error(
            { err: String(e), connectionId: m.connectionId },
            'enqueue fetch failed',
          ),
        );
      const listener = new MailboxListener(
        conn.settings,
        // Decrypted at each (re)connect; not kept as a field.
        () => openMailboxPassword(conn.ciphertext, this.deps.keys, m.tenantId, m.connectionId),
        {
          onActivity: fetch,
          onAuthFailure: (code) => {
            this.listeners.delete(m.connectionId);
            void withTenant(this.deps.sql, m.tenantId, (tx) =>
              markDisconnected(tx, m.tenantId, m.connectionId, code),
            );
            this.deps.logger.warn({ connectionId: m.connectionId, code }, 'mailbox disconnected');
          },
          onError: (code) =>
            this.deps.logger.info(
              { connectionId: m.connectionId, code },
              'imap connection problem; retrying',
            ),
        },
        this.deps.listener,
      );
      this.listeners.set(m.connectionId, listener);
      listener.start();
    }
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.listeners.values()].map((l) => l.stop()));
    this.listeners.clear();
  }
}
