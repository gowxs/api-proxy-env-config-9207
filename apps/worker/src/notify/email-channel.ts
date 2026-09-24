import type { Notification, NotificationChannel } from '@noctiv/core';
import nodemailer, { type Transporter } from 'nodemailer';
import { renderNotificationEmail } from './templates.ts';

export interface SystemMailerSettings {
  host: string;
  port: number;
  /** 'none' only for the local GreenMail sink; refused in production config. */
  security: 'tls' | 'starttls' | 'none';
  user?: string;
  pass?: string;
  /** e.g. "Noctiv <notify@noctiv.io>" */
  from: string;
}

/** Thrown for failures a retry cannot fix. */
export class PermanentDeliveryError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'PermanentDeliveryError';
  }
}

export function createSystemTransport(s: SystemMailerSettings): Transporter {
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    ...(s.user ? { auth: { user: s.user, pass: s.pass ?? '' } } : {}),
    tls: { rejectUnauthorized: s.security !== 'none', minVersion: 'TLSv1.2' },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 60_000,
    name: 'noctiv.io',
  });
}

/**
 * Owner/admin notifications by email through the system mailer (Brevo in
 * production, GreenMail locally) — never through the tenant's own mailbox,
 * which may be the thing that is broken.
 */
export class EmailChannel implements NotificationChannel {
  readonly name = 'email';
  readonly #transport: Transporter;
  readonly #from: string;
  readonly #domain: string;

  constructor(opts: { transport: Transporter; from: string }) {
    this.#transport = opts.transport;
    this.#from = opts.from;
    this.#domain = /@([^>\s]+)>?\s*$/.exec(opts.from)?.[1]?.toLowerCase() ?? 'noctiv.io';
  }

  async deliver(n: Notification, recipients: string[]): Promise<void> {
    if (recipients.length === 0) throw new PermanentDeliveryError('no_recipient');
    const email = renderNotificationEmail(n);
    await this.#transport.sendMail({
      from: this.#from,
      to: recipients,
      subject: email.subject,
      text: email.text,
      html: email.html,
      // Stable per notification: a repeated delivery is recognisable as the same email.
      messageId: `<notify.${n.id}@${this.#domain}>`,
      headers: {
        // RFC 3834: machine-generated; our own loop filter and other assistants skip it.
        'Auto-Submitted': 'auto-generated',
        'X-Auto-Response-Suppress': 'All',
      },
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }
}
