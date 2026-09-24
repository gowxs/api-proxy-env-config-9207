import type { lookup } from 'node:dns';

export type MailProvider = 'gmail' | 'google_workspace' | 'hostinger' | 'outlook' | 'generic';

export interface MailServerSettings {
  provider: MailProvider;
  emailAddress: string;
  username: string;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; security: 'tls' | 'starttls' };
}

export interface ConnectOptions {
  /**
   * Development/tests only (GreenMail): allows private addresses, plaintext
   * connections and self-signed certificates. Refused in production config.
   */
  allowInsecure?: boolean;
  timeoutMs?: number;
  lookup?: typeof lookup;
}
