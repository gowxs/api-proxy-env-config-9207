import { createHash } from 'node:crypto';
import { detectInjection, type HeaderMap } from '@noctiv/core';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';

export interface InboundMessage {
  /** Message-ID, or a synthetic one when the header is missing. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  from: { address: string; name: string | null };
  replyTo: string[];
  to: string[];
  cc: string[];
  subject: string | null;
  /** Plain text (HTML converted when there is no text part). */
  text: string;
  /** Hidden-text injection signal from the HTML part (HTML itself is not kept). */
  htmlHiddenText: boolean;
  /** Only the headers the loop filter needs, lower-cased names. */
  loopHeaders: HeaderMap;
  attachments: { filename: string | null; contentType: string; size: number }[];
  date: Date;
}

const LOOP_HEADERS = [
  'auto-submitted',
  'precedence',
  'list-id',
  'list-unsubscribe',
  'list-post',
  'x-autoreply',
  'x-autorespond',
  'x-autoresponder',
  'x-auto-response-suppress',
  'x-loop',
  'return-path',
  'content-type',
] as const;

const MAX_TEXT_CHARS = 200_000;
const FIELD_SEPARATOR = String.fromCharCode(0);

function addresses(field: AddressObject | AddressObject[] | undefined): string[] {
  const list = Array.isArray(field) ? field : field ? [field] : [];
  return list.flatMap((a) =>
    a.value.map((v) => v.address?.trim().toLowerCase()).filter((x): x is string => Boolean(x)),
  );
}

function headerValues(mail: ParsedMail): HeaderMap {
  const out: HeaderMap = {};
  for (const line of mail.headerLines) {
    if (!(LOOP_HEADERS as readonly string[]).includes(line.key)) continue;
    const value = line.line
      .slice(line.line.indexOf(':') + 1)
      .trim()
      .slice(0, 500);
    const prev = out[line.key];
    out[line.key] = prev === undefined ? value : [...(Array.isArray(prev) ? prev : [prev]), value];
  }
  return out;
}

function normalizeId(id: string): string {
  const t = id.trim();
  return t.startsWith('<') ? t : `<${t}>`;
}

export async function parseInbound(source: Buffer): Promise<InboundMessage> {
  const mail = await simpleParser(source, {
    skipImageLinks: true,
    skipTextToHtml: true,
    skipTextLinks: true,
  });
  const from = Array.isArray(mail.from) ? mail.from[0] : mail.from;
  const sender = from?.value[0];
  const html = typeof mail.html === 'string' ? mail.html : '';
  const text = (mail.text ?? '').slice(0, MAX_TEXT_CHARS);
  const messageId = mail.messageId
    ? normalizeId(mail.messageId)
    : `<${createHash('sha256')
        .update(
          [sender?.address ?? '', mail.date?.toISOString() ?? '', mail.subject ?? '', text].join(
            FIELD_SEPARATOR,
          ),
        )
        .digest('hex')}@noctiv.invalid>`;
  const refs = mail.references
    ? Array.isArray(mail.references)
      ? mail.references
      : [mail.references]
    : [];

  return {
    messageId,
    inReplyTo: mail.inReplyTo ? normalizeId(mail.inReplyTo) : null,
    references: refs.map(normalizeId),
    from: {
      address: (sender?.address ?? '').trim().toLowerCase(),
      name: sender?.name?.trim() || null,
    },
    replyTo: addresses(mail.replyTo),
    to: addresses(mail.to),
    cc: addresses(mail.cc),
    subject: mail.subject ?? null,
    text,
    htmlHiddenText: html
      ? detectInjection({ text: '', html }).signals.includes('hidden_html_text')
      : false,
    loopHeaders: headerValues(mail),
    attachments: mail.attachments.map((a) => ({
      filename: a.filename ?? null,
      contentType: a.contentType,
      size: a.size,
    })),
    date: mail.date ?? new Date(),
  };
}
