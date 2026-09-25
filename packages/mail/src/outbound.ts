import { randomUUID } from 'node:crypto';
import type { ImapFlow } from 'imapflow';
import MailComposer from 'nodemailer/lib/mail-composer';
import { resolveMailEndpoint } from './endpoint.ts';
import { classifySmtpError, MailConnectError, safeDetail, type MailErrorCode } from './errors.ts';
import { assertEncrypted, createSmtpTransport } from './clients.ts';
import type { ConnectOptions, MailServerSettings } from './types.ts';

/** References kept on a reply: the newest ones, so the header stays short. */
const MAX_REFERENCES = 20;

/** Our own Message-ID, generated before sending so a retry can find the message again. */
export function newMessageId(fromAddress: string): string {
  const domain =
    fromAddress
      .split('@')[1]
      ?.toLowerCase()
      .replace(/[^a-z0-9.-]/g, '') || 'noctiv.io';
  return `<noctiv.${randomUUID()}@${domain}>`;
}

/** Single-line header text: control characters (CR/LF included) become spaces. */
export function headerText(value: string, max = 250): string {
  return value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export interface OutboundInput {
  from: { address: string; name?: string | null };
  to: string;
  subject: string;
  text: string;
  /** Optional HTML alternative (the tenant's e-mail design); the text part is always complete. */
  html?: string | null;
  messageId: string;
  inReplyTo?: string | null;
  references?: string[];
  /** RFC 3834: set on replies nobody approved, so other assistants never answer them. */
  autoSubmitted?: boolean;
  date?: Date;
  /** Files attached after the body (e.g. a quote PDF); bytes only, never paths or URLs. */
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

/**
 * Builds the complete RFC 5322 message once; the same bytes are sent over
 * SMTP and appended to the Sent folder. Text only, or multipart/alternative
 * (text first, then HTML) when an HTML design is given; wrapped in
 * multipart/mixed when there are attachments.
 */
export async function buildOutboundMessage(i: OutboundInput): Promise<Buffer> {
  const refs = [...(i.references ?? []), ...(i.inReplyTo ? [i.inReplyTo] : [])]
    .filter((r, idx, all) => /^<[^<>\s]+>$/.test(r) && all.indexOf(r) === idx)
    .slice(-MAX_REFERENCES);
  const headers: Record<string, string> = {};
  if (i.autoSubmitted) headers['Auto-Submitted'] = 'auto-replied';
  const composer = new MailComposer({
    from: i.from.name
      ? { name: headerText(i.from.name, 100), address: i.from.address }
      : i.from.address,
    to: i.to,
    subject: headerText(i.subject),
    text: i.text,
    ...(i.html ? { html: i.html } : {}),
    ...(i.attachments?.length
      ? {
          attachments: i.attachments.map((a) => ({
            filename: headerText(a.filename, 100),
            content: a.content,
            contentType: a.contentType,
          })),
        }
      : {}),
    messageId: i.messageId,
    date: i.date ?? new Date(),
    ...(i.inReplyTo ? { inReplyTo: i.inReplyTo } : {}),
    ...(refs.length ? { references: refs } : {}),
    headers,
    textEncoding: 'quoted-printable',
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  return composer.compile().build();
}

export class SmtpSendError extends Error {
  readonly code: MailErrorCode;
  /** 5xx: resending the same message will not help. */
  readonly permanent: boolean;
  readonly detail: string | undefined;
  constructor(code: MailErrorCode, permanent: boolean, detail?: string) {
    super(`smtp send: ${code}${permanent ? ' (permanent)' : ''}`);
    this.name = 'SmtpSendError';
    this.code = code;
    this.permanent = permanent;
    this.detail = detail;
  }
}

/** Sends pre-built message bytes. The envelope comes from our data, never from the bytes. */
export async function sendRawMessage(
  settings: MailServerSettings,
  password: string,
  message: { from: string; to: string; raw: Buffer },
  opts: ConnectOptions = {},
): Promise<{ response: string }> {
  assertEncrypted(settings, opts);
  let transport;
  try {
    const ep = await resolveMailEndpoint('smtp', settings.smtp.host, settings.smtp.port, opts);
    transport = createSmtpTransport(settings, password, ep, opts);
  } catch (e) {
    const code = e instanceof MailConnectError ? e.code : 'UNKNOWN';
    throw new SmtpSendError(code, code === 'BLOCKED_ADDRESS', safeDetail(e));
  }
  try {
    const info = await transport.sendMail({
      envelope: { from: message.from, to: [message.to] },
      raw: message.raw,
    });
    return { response: safeDetail({ response: info.response }) ?? '' };
  } catch (e) {
    const code = classifySmtpError(e);
    const status = (e as { responseCode?: number }).responseCode ?? 0;
    const permanent = code !== 'UNKNOWN' && code.endsWith('AUTH_FAILED') ? true : status >= 500;
    throw new SmtpSendError(code, permanent, safeDetail(e));
  } finally {
    transport.close();
  }
}

/** The mailbox's Sent folder: the stored path, else the \Sent special-use folder. */
export async function findSentFolder(
  client: ImapFlow,
  stored: string | null,
): Promise<string | null> {
  const folders = await client.list();
  if (stored && folders.some((f) => f.path === stored)) return stored;
  return folders.find((f) => f.specialUse === '\\Sent')?.path ?? null;
}

/** True when a message with this Message-ID is already in the folder (crash recovery). */
export async function folderHasMessageId(
  client: ImapFlow,
  folder: string,
  messageId: string,
): Promise<boolean> {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const found = await client.search({ header: { 'message-id': messageId } }, { uid: true });
    return Array.isArray(found) && found.length > 0;
  } finally {
    lock.release();
  }
}

export async function appendToFolder(client: ImapFlow, folder: string, raw: Buffer): Promise<void> {
  await client.append(folder, raw, ['\\Seen'], new Date());
}
