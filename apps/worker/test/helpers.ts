import { randomUUID } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { generateSealingKeyPair } from '@noctiv/core';
import { sealMailboxPassword } from '@noctiv/mail';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Sql } from 'postgres';

export const keys = generateSealingKeyPair();

export interface GreenMail {
  host: string;
  smtpPort: number;
  imapPort: number;
}

/** A connected mailbox row pointing at GreenMail, with a properly sealed password. */
export async function addGreenmailConnection(
  owner: Sql,
  gm: GreenMail,
  args: {
    tenantId: string;
    address: string;
    password: string;
    isTest?: boolean;
    /** Another SMTP port on the GreenMail host (the fake SMTP server). */
    smtpPort?: number;
    smtpHost?: string;
    sentAppendMode?: 'append' | 'provider_auto' | 'none';
    sentFolder?: string;
    displayName?: string;
  },
): Promise<string> {
  const id = randomUUID();
  const { ciphertext, keyId } = sealMailboxPassword(
    args.password,
    keys.publicKey,
    args.tenantId,
    id,
  );
  await owner`
    insert into public.email_connections
      (id, tenant_id, provider, email_address, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_security,
       username, credentials_ciphertext, credentials_key_id, status, is_test_mailbox, sent_append_mode, sent_folder_path,
       display_name)
    values (${id}, ${args.tenantId}, 'generic', ${args.address}, ${gm.host}, ${gm.imapPort}, false,
            ${args.smtpHost ?? gm.host}, ${args.smtpPort ?? gm.smtpPort}, 'starttls', ${args.address}, ${ciphertext}, ${keyId},
            'connected', ${args.isTest ?? false}, ${args.sentAppendMode ?? 'none'}, ${args.sentFolder ?? null},
            ${args.displayName ?? null})`;
  return id;
}

export async function sendMail(
  gm: GreenMail,
  mail: {
    from: string;
    to: string;
    subject: string;
    text?: string;
    html?: string;
    headers?: Record<string, string>;
    messageId?: string;
    inReplyTo?: string;
    references?: string[];
    replyTo?: string;
  },
): Promise<void> {
  const t = nodemailer.createTransport({
    host: gm.host,
    port: gm.smtpPort,
    secure: false,
    ignoreTLS: true,
  });
  await t.sendMail(mail);
  t.close();
}

export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 10_000,
  stepMs = 200,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Raw messages in a GreenMail folder (IMAP login as that user). */
export async function readFolder(
  gm: GreenMail,
  user: { address: string; password: string },
  folder = 'INBOX',
): Promise<{ raw: string; flags: string[] }[]> {
  const client = new ImapFlow({
    host: gm.host,
    port: gm.imapPort,
    secure: false,
    auth: { user: user.address, pass: user.password },
    logger: false,
  });
  await client.connect();
  const out: { raw: string; flags: string[] }[] = [];
  try {
    const box = await client.mailboxOpen(folder, { readOnly: true });
    if (box.exists > 0) {
      for await (const m of client.fetch('1:*', { source: true, flags: true })) {
        out.push({ raw: m.source?.toString('utf8') ?? '', flags: [...(m.flags ?? [])] });
      }
    }
  } finally {
    await client.logout();
  }
  return out;
}

export async function createFolder(
  gm: GreenMail,
  user: { address: string; password: string },
  folder: string,
  append?: Buffer,
): Promise<void> {
  const client = new ImapFlow({
    host: gm.host,
    port: gm.imapPort,
    secure: false,
    auth: { user: user.address, pass: user.password },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxCreate(folder).catch(() => undefined);
    if (append) await client.append(folder, append);
  } finally {
    await client.logout();
  }
}

/** One header's (unfolded) value from a raw message, or null. */
export function header(raw: string, name: string): string | null {
  const head = raw.split(/\r?\n\r?\n/)[0] ?? '';
  const unfolded = head.replace(/\r?\n[ \t]+/g, ' ');
  const re = new RegExp(`^${name}:[ \\t]*(.*)$`, 'im');
  return re.exec(unfolded)?.[1]?.trim() ?? null;
}

/**
 * Minimal SMTP server that answers RCPT TO with a fixed reply, for
 * permanent (5xx) and temporary (4xx) failures GreenMail cannot produce.
 */
export async function startFakeSmtp(
  rcptReply: string,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    socket.write('220 fake.test ESMTP\r\n');
    let buf = '';
    let inData = false;
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 queued\r\n');
          }
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250 fake.test\r\n');
        else if (cmd === 'MAIL') socket.write('250 ok\r\n');
        else if (cmd === 'RCPT') socket.write(`${rcptReply}\r\n`);
        else if (cmd === 'DATA') {
          inData = true;
          socket.write('354 go\r\n');
        } else if (cmd === 'QUIT') socket.end('221 bye\r\n');
        else if (cmd === 'RSET' || cmd === 'NOOP') socket.write('250 ok\r\n');
        else socket.write('502 not implemented\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
