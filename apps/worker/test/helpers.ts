import { randomUUID } from 'node:crypto';
import { generateSealingKeyPair } from '@noctiv/core';
import { sealMailboxPassword } from '@noctiv/mail';
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
  args: { tenantId: string; address: string; password: string; isTest?: boolean },
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
       username, credentials_ciphertext, credentials_key_id, status, is_test_mailbox, sent_append_mode)
    values (${id}, ${args.tenantId}, 'generic', ${args.address}, ${gm.host}, ${gm.imapPort}, false, ${gm.host}, ${gm.smtpPort},
            'starttls', ${args.address}, ${ciphertext}, ${keyId}, 'connected', ${args.isTest ?? false}, 'none')`;
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
