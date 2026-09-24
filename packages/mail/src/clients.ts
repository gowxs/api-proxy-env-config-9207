import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { resolveMailEndpoint } from './endpoint.ts';
import { classifyImapError, classifySmtpError, MailConnectError, safeDetail } from './errors.ts';
import type { ConnectOptions, MailServerSettings } from './types.ts';

const DEFAULT_TIMEOUT = 20_000;

export function assertEncrypted(settings: MailServerSettings, opts: ConnectOptions): void {
  if (opts.allowInsecure) return;
  if (!settings.imap.secure || !['tls', 'starttls'].includes(settings.smtp.security)) {
    throw new MailConnectError('INSECURE_SETTINGS', 'config');
  }
}

/** Connected, logged-in IMAP client. Callers must logout() / close(). */
export async function connectImap(
  settings: MailServerSettings,
  password: string,
  opts: ConnectOptions = {},
): Promise<ImapFlow> {
  assertEncrypted(settings, opts);
  const ep = await resolveMailEndpoint('imap', settings.imap.host, settings.imap.port, opts);
  const client = new ImapFlow({
    host: ep.address,
    servername: ep.servername,
    port: ep.port,
    secure: settings.imap.secure,
    auth: { user: settings.username, pass: password },
    logger: false,
    tls: {
      servername: ep.servername,
      rejectUnauthorized: !opts.allowInsecure,
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    greetingTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    socketTimeout: 5 * 60_000,
    // Never send plaintext credentials: require STARTTLS on non-TLS ports unless explicitly insecure (tests).
    doSTARTTLS: settings.imap.secure ? undefined : opts.allowInsecure ? false : true,
  });
  client.on('error', () => {
    // Surfaced through the failing command; avoid unhandled 'error' events.
  });
  try {
    await client.connect();
  } catch (e) {
    throw new MailConnectError(classifyImapError(e), 'imap', safeDetail(e));
  }
  return client;
}

export function createSmtpTransport(
  settings: MailServerSettings,
  password: string,
  endpoint: { address: string; servername: string; port: number },
  opts: ConnectOptions = {},
) {
  return nodemailer.createTransport({
    host: endpoint.address,
    port: endpoint.port,
    secure: settings.smtp.security === 'tls',
    requireTLS: settings.smtp.security === 'starttls' && !opts.allowInsecure,
    ignoreTLS: opts.allowInsecure && settings.smtp.security !== 'tls' ? true : undefined,
    auth: { user: settings.username, pass: password },
    tls: {
      servername: endpoint.servername,
      rejectUnauthorized: !opts.allowInsecure,
      minVersion: 'TLSv1.2',
    },
    connectionTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    greetingTimeout: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    socketTimeout: 60_000,
    name: 'noctiv.io',
  });
}

export async function verifySmtp(
  settings: MailServerSettings,
  password: string,
  opts: ConnectOptions = {},
): Promise<void> {
  assertEncrypted(settings, opts);
  const ep = await resolveMailEndpoint('smtp', settings.smtp.host, settings.smtp.port, opts);
  const transport = createSmtpTransport(settings, password, ep, opts);
  try {
    await transport.verify();
  } catch (e) {
    throw new MailConnectError(classifySmtpError(e), 'smtp', safeDetail(e));
  } finally {
    transport.close();
  }
}
