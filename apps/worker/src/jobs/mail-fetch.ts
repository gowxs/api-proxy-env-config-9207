import { JobError, withTenant, type Job } from '@noctiv/db';
import {
  connectImap,
  fetchNewMessages,
  fetchSeenFlags,
  findSentFolder,
  MailConnectError,
  MAX_MESSAGE_BYTES,
  openMailboxPassword,
  parseInbound,
  type InboundMessage,
} from '@noctiv/mail';
import type { Sql } from 'postgres';
import { tenantEntitled } from '../billing.ts';
import { storeSent } from '../ingest/sent.ts';
import { storeInbound } from '../ingest/store.ts';
import {
  DISCONNECT_CODES,
  loadConnection,
  markDisconnected,
  saveInboxState,
  saveSentError,
  saveSentState,
  type StoredConnection,
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
    // No subscription after the trial: the mail waits in the inbox until service resumes.
    if (!(await tenantEntitled(deps.sql, job.tenantId))) return { skipped: 'billing_inactive' };

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
              seen: m.seen,
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
      // Read state and the owner's own replies are best effort: a problem there never
      // blocks or fails the inbox fetch that already succeeded.
      await refreshSeen(deps.sql, job.tenantId, conn, client).catch(() => undefined);
      const sent = await syncSent(deps.sql, job.tenantId, conn, client).catch(() => 0);
      return { stored, ...(sent ? { sentStored: sent } : {}) };
    } finally {
      await client.logout().catch(() => client.close());
    }
  };
}

const SEEN_WINDOW_DAYS = 14;
const SEEN_MAX_MESSAGES = 200;

/**
 * Mirrors the provider's read state (one direction, read-only) for recent
 * inbound messages: UID FETCH FLAGS, no bodies. Skipped when the inbox
 * UIDVALIDITY changed (the stored UIDs mean nothing then).
 */
async function refreshSeen(
  sql: Sql,
  tenantId: string,
  conn: StoredConnection,
  client: Parameters<typeof fetchSeenFlags>[0],
): Promise<void> {
  if (!conn.uidValidity) return;
  const rows = await withTenant(
    sql,
    tenantId,
    (tx) => tx<{ id: string; imap_uid: string; seen: boolean | null }[]>`
      select m.id, m.imap_uid::text, m.seen from public.messages m
      where m.connection_id = ${conn.id} and m.direction = 'inbound' and m.mailbox_folder = 'inbox'
        and m.imap_uid is not null and m.received_at > now() - make_interval(days => ${SEEN_WINDOW_DAYS})
      order by m.received_at desc limit ${SEEN_MAX_MESSAGES}`,
  );
  if (rows.length === 0) return;
  const flags = await fetchSeenFlags(
    client,
    rows.map((r) => Number(r.imap_uid)),
    conn.uidValidity,
  );
  if (!flags) return;
  const changed = rows.filter((r) => {
    const now = flags.get(Number(r.imap_uid));
    return now !== undefined && now !== r.seen;
  });
  if (changed.length === 0) return;
  await withTenant(sql, tenantId, async (tx) => {
    for (const r of changed)
      await tx`update public.messages set seen = ${flags.get(Number(r.imap_uid))!} where id = ${r.id}`;
  });
}

/**
 * Reads the owner's Sent folder (read-only) so replies written in their own
 * mail client show in the thread. First run only records the position: no
 * history is imported. Messages that do not belong to a known conversation
 * are dropped (storeSent). Returns how many were stored.
 */
export async function syncSent(
  sql: Sql,
  tenantId: string,
  conn: StoredConnection,
  client: Parameters<typeof fetchSeenFlags>[0],
): Promise<number> {
  const folder = await findSentFolder(client, conn.sentFolder);
  if (!folder) {
    // No \Sent marker (or the entered name does not exist): Settings asks the owner for the folder name.
    await withTenant(sql, tenantId, (tx) =>
      saveSentError(tx, conn.id, conn.sentFolder ? 'FOLDER_NOT_FOUND' : 'NO_SENT_FOLDER'),
    );
    return 0;
  }
  let state = { uidValidity: conn.sentUidValidity, lastUid: conn.sentLastUid };
  const startedAt = conn.sentSyncStartedAt ?? new Date();
  let stored = 0;
  for (let i = 0; i < MAX_BATCHES_PER_JOB; i++) {
    let batch;
    try {
      batch = await fetchNewMessages(client, state, { folder, notBefore: startedAt, max: 50 });
    } catch {
      // The folder name is wrong or gone: say so in Settings; the owner can correct it.
      await withTenant(sql, tenantId, (tx) => saveSentError(tx, conn.id, 'FOLDER_NOT_FOUND'));
      return stored;
    }
    for (const m of batch.messages) {
      let msg: InboundMessage;
      try {
        msg = await parseInbound(m.source);
      } catch {
        continue;
      }
      await withTenant(sql, tenantId, async (tx) => {
        const r = await storeSent(tx, {
          tenantId,
          connectionId: conn.id,
          ownAddress: conn.settings.emailAddress,
          uid: m.uid,
          msg,
          tooLarge: m.size > MAX_MESSAGE_BYTES,
        });
        if (r === 'stored') stored++;
        if (!batch.uidValidityChanged)
          await saveSentState(tx, conn.id, { uidValidity: batch.uidValidity, lastUid: m.uid });
      });
    }
    await withTenant(sql, tenantId, (tx) =>
      saveSentState(tx, conn.id, {
        uidValidity: batch.uidValidity,
        lastUid: batch.lastUid,
        // The first run (baseline) fixes the moment syncing began.
        startedAt: batch.baselineOnly ? startedAt : null,
        folder,
      }),
    );
    state = { uidValidity: batch.uidValidity, lastUid: batch.lastUid };
    if (!batch.more) break;
  }
  return stored;
}
