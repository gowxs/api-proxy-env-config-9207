import {
  connectImap,
  MailConnectError,
  type ConnectOptions,
  type MailServerSettings,
} from '@noctiv/mail';
import type { ImapFlow } from 'imapflow';

export interface ListenerEvents {
  /** New mail may be waiting (IDLE "EXISTS", the periodic poll, or a reconnect). */
  onActivity: () => void;
  /** The password stopped working; the listener has stopped itself. */
  onAuthFailure: (code: string) => void;
  onError?: (code: string) => void;
}

export interface ListenerOptions extends ConnectOptions {
  /** Brief: fallback poll every 3 minutes. */
  pollMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

const AUTH_CODES = new Set([
  'AUTH_FAILED',
  'APP_PASSWORD_REQUIRED',
  'IMAP_DISABLED',
  'BASIC_AUTH_DISABLED',
]);

/**
 * Keeps one IMAP connection per mailbox idling on INBOX (read-only). It
 * never fetches mail itself: it only signals activity, and the mail.fetch
 * job does the work. Reconnects with jittered exponential backoff.
 */
export class MailboxListener {
  private client: ImapFlow | undefined;
  private stopped = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private retryTimer: NodeJS.Timeout | undefined;
  private failures = 0;
  private readonly settings: MailServerSettings;
  private readonly password: () => string;
  private readonly events: ListenerEvents;
  private readonly opts: ListenerOptions;

  constructor(
    settings: MailServerSettings,
    password: () => string,
    events: ListenerEvents,
    opts: ListenerOptions = {},
  ) {
    this.settings = settings;
    this.password = password;
    this.events = events;
    this.opts = opts;
  }

  start(): void {
    this.stopped = false;
    void this.connect();
    this.pollTimer = setInterval(() => this.events.onActivity(), this.opts.pollMs ?? 180_000);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.retryTimer);
    const c = this.client;
    this.client = undefined;
    if (c) await c.logout().catch(() => c.close());
  }

  /** Test hook: drop the connection as a network failure would. */
  dropConnection(): void {
    this.client?.close();
  }

  get connected(): boolean {
    return Boolean(this.client?.usable);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const client = await connectImap(this.settings, this.password(), this.opts);
      if (this.stopped) {
        await client.logout().catch(() => client.close());
        return;
      }
      await client.mailboxOpen('INBOX', { readOnly: true });
      client.on('exists', () => this.events.onActivity());
      client.on('close', () => this.scheduleReconnect());
      this.client = client;
      this.failures = 0;
      // Mail may have arrived while we were disconnected.
      this.events.onActivity();
    } catch (e) {
      const code = e instanceof MailConnectError ? e.code : 'UNKNOWN';
      if (AUTH_CODES.has(code)) {
        this.events.onAuthFailure(code);
        await this.stop();
        return;
      }
      this.events.onError?.(code);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.client = undefined;
    this.failures++;
    const min = this.opts.minBackoffMs ?? 1_000;
    const max = this.opts.maxBackoffMs ?? 300_000;
    const delay =
      Math.min(max, min * 2 ** Math.min(this.failures - 1, 16)) * (0.5 + Math.random() / 2);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}
