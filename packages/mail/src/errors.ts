export type MailErrorCode =
  | 'AUTH_FAILED'
  | 'APP_PASSWORD_REQUIRED'
  | 'IMAP_DISABLED'
  | 'BASIC_AUTH_DISABLED'
  | 'SMTP_AUTH_FAILED'
  | 'TLS_ERROR'
  | 'WRONG_PORT'
  | 'HOST_NOT_FOUND'
  | 'HOST_UNREACHABLE'
  | 'TIMEOUT'
  | 'BLOCKED_ADDRESS'
  | 'INSECURE_SETTINGS'
  | 'PROVIDER_UNSUPPORTED'
  | 'UNKNOWN';

/** Owner-facing explanations shown by the connection wizard (English UI). */
export const MAIL_ERROR_MESSAGES: Record<MailErrorCode, string> = {
  AUTH_FAILED: 'The username or App Password is wrong.',
  APP_PASSWORD_REQUIRED:
    'Your provider rejected your normal password. Create an App Password (requires 2-Step Verification) and use that instead.',
  IMAP_DISABLED:
    'IMAP access is turned off for this mailbox. Enable IMAP in your mail settings (or ask your admin) and try again.',
  BASIC_AUTH_DISABLED:
    'Microsoft no longer allows password sign-in for this account, so it cannot be connected in this version.',
  SMTP_AUTH_FAILED:
    'Reading mail works, but sending was refused: the SMTP username or App Password is wrong.',
  TLS_ERROR: 'A secure (TLS) connection could not be established. Check the server name.',
  WRONG_PORT:
    'The server did not answer on this port. Check the port and security setting (IMAP usually 993, SMTP 465 or 587).',
  HOST_NOT_FOUND: 'The server name could not be found. Check the IMAP/SMTP server address.',
  HOST_UNREACHABLE: 'The server could not be reached.',
  TIMEOUT: 'The server took too long to answer. Try again in a moment.',
  BLOCKED_ADDRESS: 'This server address is not allowed.',
  INSECURE_SETTINGS:
    'Only encrypted connections are allowed (IMAP on 993, SMTP with TLS or STARTTLS).',
  PROVIDER_UNSUPPORTED: 'Outlook / Microsoft accounts cannot be connected with a password yet.',
  UNKNOWN: 'The connection failed for an unexpected reason.',
};

export class MailConnectError extends Error {
  readonly code: MailErrorCode;
  readonly stage: 'config' | 'imap' | 'smtp';
  /** Short server response, safe to show (never contains credentials). */
  readonly detail: string | undefined;

  constructor(code: MailErrorCode, stage: MailConnectError['stage'], detail?: string) {
    super(`${stage}: ${code}`);
    this.name = 'MailConnectError';
    this.code = code;
    this.stage = stage;
    this.detail = detail;
  }
}

function text(e: unknown): string {
  const x = e as { responseText?: unknown; response?: unknown; message?: unknown };
  return [x?.responseText, x?.response, x?.message].filter((v) => typeof v === 'string').join(' ');
}

/** Printable, short server text for the wizard. */
export function safeDetail(e: unknown): string | undefined {
  const t = text(e)
    .replace(/[^\x20-\x7E]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, 200) : undefined;
}

function networkCode(e: unknown): MailErrorCode | undefined {
  const x = e as { code?: unknown; name?: unknown };
  const code = typeof x?.code === 'string' ? x.code : '';
  const all = `${code} ${text(e)}`;
  if (/ENOTFOUND|EAI_AGAIN|EDNS/.test(code)) return 'HOST_NOT_FOUND';
  if (code === 'ECONNREFUSED') return 'WRONG_PORT';
  if (/EHOSTUNREACH|ENETUNREACH|ECONNRESET/.test(code)) return 'HOST_UNREACHABLE';
  if (/wrong version number|packet length too long|unexpected eof/i.test(all)) return 'WRONG_PORT';
  if (/ERR_TLS|ERR_SSL|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|certificate/i.test(all))
    return 'TLS_ERROR';
  if (/ETIMEDOUT|ETIMEOUT|timed? ?out|timeout/i.test(all) || x?.name === 'TimeoutError')
    return 'TIMEOUT';
  return undefined;
}

/** Maps imapflow errors (and their server responses) to a wizard error code. */
export function classifyImapError(e: unknown): MailErrorCode {
  const x = e as { authenticationFailed?: boolean; serverResponseCode?: string };
  const t = text(e);
  if (/application-specific password required/i.test(t)) return 'APP_PASSWORD_REQUIRED';
  if (/not enabled for imap|imap (?:access )?is disabled|web login required.*imap/i.test(t))
    return 'IMAP_DISABLED';
  if (/basicauthblocked|basic auth(?:entication)? is disabled|logondenied/i.test(t))
    return 'BASIC_AUTH_DISABLED';
  if (
    x?.authenticationFailed ||
    x?.serverResponseCode === 'AUTHENTICATIONFAILED' ||
    /invalid credentials|authenticate failed|login failed/i.test(t)
  ) {
    return 'AUTH_FAILED';
  }
  return networkCode(e) ?? 'UNKNOWN';
}

/** Maps nodemailer SMTP errors to a wizard error code. */
export function classifySmtpError(e: unknown): MailErrorCode {
  const x = e as { code?: string; responseCode?: number };
  const t = text(e);
  if (x?.code === 'EAUTH' || x?.responseCode === 535 || x?.responseCode === 534) {
    if (/5\.7\.9|application-specific password/i.test(t)) return 'APP_PASSWORD_REQUIRED';
    if (/5\.7\.139|basic authentication is disabled|smtpclientauthentication is disabled/i.test(t))
      return 'BASIC_AUTH_DISABLED';
    return 'SMTP_AUTH_FAILED';
  }
  return networkCode(e) ?? 'UNKNOWN';
}
