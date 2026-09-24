import { MAIL_ERROR_MESSAGES, MailConnectError, type MailErrorCode } from './errors.ts';
import { connectImap, verifySmtp } from './clients.ts';
import { isUnsupportedProvider, savesSentAutomatically } from './presets.ts';
import type { ConnectOptions, MailServerSettings } from './types.ts';

export type ConnectionTestResult =
  | {
      ok: true;
      uidValidity: string;
      /** High-water mark at connect time: only mail after this is processed (no backlog). */
      baselineUid: number;
      sentFolder: string | null;
      sentAppendMode: 'append' | 'provider_auto' | 'none';
    }
  | {
      ok: false;
      code: MailErrorCode;
      stage: 'config' | 'imap' | 'smtp';
      message: string;
      detail?: string;
    };

function failure(e: unknown): ConnectionTestResult {
  if (e instanceof MailConnectError) {
    return {
      ok: false,
      code: e.code,
      stage: e.stage,
      message: MAIL_ERROR_MESSAGES[e.code],
      ...(e.detail ? { detail: e.detail } : {}),
    };
  }
  return { ok: false, code: 'UNKNOWN', stage: 'config', message: MAIL_ERROR_MESSAGES.UNKNOWN };
}

/**
 * The wizard's live test (PLAN.md §3.4): IMAP login, INBOX status, Sent
 * folder discovery, then SMTP authentication. Nothing is sent, nothing is
 * marked read. The password is used only for these two logins.
 */
export async function testMailConnection(
  settings: MailServerSettings,
  password: string,
  opts: ConnectOptions = {},
): Promise<ConnectionTestResult> {
  if (isUnsupportedProvider(settings.provider, settings.emailAddress)) {
    return failure(new MailConnectError('PROVIDER_UNSUPPORTED', 'config'));
  }
  let inbox: { uidValidity: string; baselineUid: number; sentFolder: string | null };
  try {
    const client = await connectImap(settings, password, opts);
    try {
      const box = await client.mailboxOpen('INBOX', { readOnly: true });
      const folders = await client.list();
      const sent = folders.find((f) => f.specialUse === '\\Sent');
      inbox = {
        uidValidity: String(box.uidValidity),
        baselineUid: Math.max(Number(box.uidNext) - 1, 0),
        sentFolder: sent?.path ?? null,
      };
    } finally {
      await client.logout().catch(() => client.close());
    }
  } catch (e) {
    return failure(e instanceof MailConnectError ? e : new MailConnectError('UNKNOWN', 'imap'));
  }
  try {
    await verifySmtp(settings, password, opts);
  } catch (e) {
    return failure(e);
  }
  return {
    ok: true,
    ...inbox,
    sentAppendMode: savesSentAutomatically(settings)
      ? 'provider_auto'
      : inbox.sentFolder
        ? 'append'
        : 'none',
  };
}
