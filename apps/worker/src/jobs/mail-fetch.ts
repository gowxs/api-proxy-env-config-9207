import { JobError, withTenant, type Job } from '@noctiv/db';
import {
  connectImap,
  fetchNewMessages,
  MailConnectError,
  MAX_MESSAGE_BYTES,
  openMailboxPassword,
  parseInbound,
  type InboundMessage,
} from '@noctiv/mail';
import type { Sql } from 'postgres';
import { storeInbound } from '../ingest/store.ts';
import {
  DISCONNECT_CODES,
  loadConnection,
  markDisconnected,
  saveInboxState,
} from '../mailbox/connection-repo.ts';

export interface MailFetchDeps {
  sql: Sql;
  keys: { publicKey: string; privateKey: string };
  allowInsecure: boolean;
  /** Messages per IMAP round trip; the job keeps going until the inbox is drained (bounded). */
  batchSize?: number;
}

const MAX_BATCHES_PER_JOB = 20;

/**
 * mail.fetch: one run per connection at a time (singleton key). Reads new
 * INBOX messages read-only, stores each with its processing job in one
 * transaction, and advances the stored UID only after the message is saved.
 */
export function mailFetchHandler(deps: MailFetchDeps) {
  return async (job: Job) => {
    const connectionId = String(job.payload.connectionId);
    const conn = await withTenant(deps.sql, job.tenantId, (tx) => loadConnection(tx, connectionId));
    if (!conn || conn.status !== 'connected') return { skipped: 'not_connected' };

    const password = openMailboxPassword(conn.ciphertext, deps.keys, job.tenantId, conn.id);
    let client;
    try {
      client = await connectImap(conn.settings, password, { allowInsecure: deps.allowInsecure });
    } catch (e) {
      if (e instanceof MailConnectError && DISCONNECT_CODES.has(e.code)) {
        await withTenant(deps.sql, job.tenantId, (tx) =>
          markDisconnected(tx, job.tenantId, conn.id, e.code),
        );
        throw new JobError(`mailbox disconnected: ${e.code}`, { retryable: false });
      }
      throw new JobError(
        `imap unavailable: ${e instanceof MailConnectError ? e.code : 'UNKNOWN'}`,
        { retryable: true },
      );
    }

    let stored = 0;
    let state = { uidValidity: conn.uidValidity, lastUid: conn.lastUid };
    try {
      for (let i = 0; i < MAX_BATCHES_PER_JOB; i++) {
        const batch = await fetchNewMessages(client, state, {
          max: deps.batchSize ?? 50,
          notBefore: conn.connectedAt,
        });
        for (const m of batch.messages) {
          const tooLarge = m.size > MAX_MESSAGE_BYTES;
          let msg: InboundMessage;
          try {
            msg = await parseInbound(m.source);
          } catch {
            continue; // Unparseable: skip; the UID still advances below.
          }
          const id = await withTenant(deps.sql, job.tenantId, async (tx) => {
            const newId = await storeInbound(tx, {
              tenantId: job.tenantId,
              connectionId: conn.id,
              uid: m.uid,
              msg,
              tooLarge,
            });
            if (!batch.uidValidityChanged)
              await saveInboxState(tx, conn.id, batch.uidValidity, m.uid);
            return newId;
          });
          if (id) stored++;
        }
        await withTenant(deps.sql, job.tenantId, (tx) =>
          saveInboxState(tx, conn.id, batch.uidValidity, batch.lastUid),
        );
        state = { uidValidity: batch.uidValidity, lastUid: batch.lastUid };
        if (!batch.more) break;
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
    return { stored };
  };
}
