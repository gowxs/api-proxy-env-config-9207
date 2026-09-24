import type { MailProvider, MailServerSettings } from './types.ts';

export interface ProviderPreset {
  imap: MailServerSettings['imap'];
  smtp: MailServerSettings['smtp'];
  /** Gmail saves SMTP-sent mail to Sent itself; appending would duplicate it. */
  savesSentAutomatically: boolean;
}

export const PRESETS: Partial<Record<MailProvider, ProviderPreset>> = {
  gmail: {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    savesSentAutomatically: true,
  },
  google_workspace: {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    savesSentAutomatically: true,
  },
  yahoo: {
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    savesSentAutomatically: false,
  },
  hostinger: {
    imap: { host: 'imap.hostinger.com', port: 993, secure: true },
    smtp: { host: 'smtp.hostinger.com', port: 465, security: 'tls' },
    savesSentAutomatically: false,
  },
};

/** Microsoft consumer domains: password sign-in for IMAP/SMTP is switched off (PLAN.md Q4). */
const MICROSOFT_CONSUMER_DOMAINS = /@(?:outlook|hotmail|live|msn|windowslive)\.[a-z.]+$/i;

export function isUnsupportedProvider(provider: MailProvider, emailAddress: string): boolean {
  return provider === 'outlook' || MICROSOFT_CONSUMER_DOMAINS.test(emailAddress.trim());
}

/** Fills host/port from the preset for known providers; generic uses what the owner typed. */
export function resolveSettings(input: {
  provider: MailProvider;
  emailAddress: string;
  username?: string;
  imap?: MailServerSettings['imap'];
  smtp?: MailServerSettings['smtp'];
}): MailServerSettings {
  const preset = PRESETS[input.provider];
  const imap = preset?.imap ?? input.imap;
  const smtp = preset?.smtp ?? input.smtp;
  if (!imap || !smtp) throw new Error('imap and smtp settings are required for a generic provider');
  return {
    provider: input.provider,
    emailAddress: input.emailAddress.trim().toLowerCase(),
    username: (input.username ?? input.emailAddress).trim(),
    imap,
    smtp,
  };
}

export function savesSentAutomatically(settings: MailServerSettings): boolean {
  return (
    PRESETS[settings.provider]?.savesSentAutomatically ??
    /(^|\.)gmail\.com$/i.test(settings.imap.host)
  );
}
