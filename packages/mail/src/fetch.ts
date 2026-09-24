import type { ImapFlow } from 'imapflow';

export interface InboxState {
  uidValidity: string | null;
  lastUid: number | null;
}

export interface FetchBatch {
  uidValidity: string;
  /** True when this call only recorded the starting point (first run or UIDVALIDITY reset without history). */
  baselineOnly: boolean;
  messages: { uid: number; source: Buffer; size: number }[];
  /** Highest UID seen; store it after the messages are saved. */
  lastUid: number;
  more: boolean;
  uidValidityChanged: boolean;
}

/** Skip bodies of huge messages; they are escalated as unreadable. */
export const MAX_MESSAGE_BYTES = 15 * 1024 * 1024;

/**
 * Reads new INBOX messages since the last seen UID. The mailbox is opened
 * read-only (EXAMINE): nothing is marked as read, moved or changed.
 * First run: records the current position and fetches nothing (no backlog).
 * UIDVALIDITY change: re-reads the last `resyncDays` days; stored Message-IDs
 * make that safe (duplicates are ignored on insert).
 */
export async function fetchNewMessages(
  client: ImapFlow,
  state: InboxState,
  opts: { max?: number; resyncDays?: number; notBefore?: Date } = {},
): Promise<FetchBatch> {
  const max = opts.max ?? 50;
  const box = await client.mailboxOpen('INBOX', { readOnly: true });
  const uidValidity = String(box.uidValidity);
  const uidNext = Number(box.uidNext);

  if (state.uidValidity === null || state.lastUid === null) {
    return {
      uidValidity,
      baselineOnly: true,
      messages: [],
      lastUid: Math.max(uidNext - 1, 0),
      more: false,
      uidValidityChanged: false,
    };
  }

  const changed = state.uidValidity !== uidValidity;
  let uids: number[];
  if (changed) {
    const window = Date.now() - (opts.resyncDays ?? 3) * 86_400_000;
    const since = new Date(Math.max(window, opts.notBefore?.getTime() ?? 0));
    uids = ((await client.search({ since }, { uid: true })) || []) as number[];
  } else {
    // "last+1:*" always returns at least the newest message; keep only truly new UIDs.
    uids = (
      ((await client.search({ uid: `${state.lastUid + 1}:*` }, { uid: true })) || []) as number[]
    ).filter((u) => u > state.lastUid!);
  }
  uids.sort((a, b) => a - b);
  // A UIDVALIDITY re-read takes the whole window at once (the position is reset afterwards).
  const batch = uids.slice(0, changed ? Math.max(max, 500) : max);
  const messages: FetchBatch['messages'] = [];
  if (batch.length) {
    for await (const msg of client.fetch(
      batch.join(','),
      { uid: true, size: true, internalDate: true, source: { maxLength: MAX_MESSAGE_BYTES } },
      { uid: true },
    )) {
      // SEARCH SINCE is day-granular: drop anything that arrived before the mailbox was connected.
      const arrived =
        msg.internalDate instanceof Date
          ? msg.internalDate
          : new Date(msg.internalDate ?? Date.now());
      if (changed && opts.notBefore && arrived < opts.notBefore) continue;
      messages.push({ uid: msg.uid, source: msg.source ?? Buffer.alloc(0), size: msg.size ?? 0 });
    }
  }
  messages.sort((a, b) => a.uid - b.uid);
  const lastUid = changed
    ? Math.max(uidNext - 1, 0)
    : Math.max(state.lastUid, ...messages.map((m) => m.uid));
  return {
    uidValidity,
    baselineOnly: false,
    messages,
    lastUid,
    more: uids.length > batch.length,
    uidValidityChanged: changed,
  };
}
