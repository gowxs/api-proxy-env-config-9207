import type { MailProvider } from './types.ts';

/**
 * Which mailbox provider an address belongs to, for prefilling the connect
 * form (Noctiv Assistant, PLAN.md §27.3). Well-known consumer domains are
 * read from the address; for a business domain the mail servers (MX records)
 * tell who hosts it. Hosts and ports are the providers' documented IMAP/SMTP
 * settings; the owner still types only the App Password, and the connection
 * test checks everything before anything is saved.
 */
export interface DetectedMailbox {
  provider: MailProvider;
  /** Shown to the owner, e.g. "Google Workspace" or "Zoho Mail". */
  label: string;
  /** For provider 'generic': the servers to prefill (known providers use their preset). */
  imap: { host: string; port: number } | null;
  smtp: { host: string; port: number } | null;
  /** How it was found. */
  source: 'address' | 'mx' | 'name' | 'unknown';
  /** Microsoft: password sign-in for IMAP/SMTP is not available (not supported yet). */
  unsupported: boolean;
}

interface Known {
  provider: MailProvider;
  label: string;
  imap?: [string, number];
  smtp?: [string, number];
  unsupported?: boolean;
}

const GMAIL: Known = { provider: 'gmail', label: 'Gmail' };
const WORKSPACE: Known = { provider: 'google_workspace', label: 'Google Workspace' };
const YAHOO: Known = { provider: 'yahoo', label: 'Yahoo Mail' };
const HOSTINGER: Known = { provider: 'hostinger', label: 'Hostinger' };
const MICROSOFT: Known = {
  provider: 'outlook',
  label: 'Outlook / Microsoft 365',
  unsupported: true,
};
const generic = (label: string, imap: [string, number], smtp: [string, number]): Known => ({
  provider: 'generic',
  label,
  imap,
  smtp,
});
const ICLOUD = generic('iCloud Mail', ['imap.mail.me.com', 993], ['smtp.mail.me.com', 587]);
const ZOHO = (tld: string) =>
  generic('Zoho Mail', [`imap.zoho.${tld}`, 993], [`smtp.zoho.${tld}`, 465]);
const FASTMAIL = generic('Fastmail', ['imap.fastmail.com', 993], ['smtp.fastmail.com', 465]);

/** Consumer domains: the address alone says who it is. */
const BY_DOMAIN: [RegExp, Known][] = [
  [/^(gmail|googlemail)\.com$/, GMAIL],
  [/^(yahoo|ymail|rocketmail)\.[a-z.]+$/, YAHOO],
  [/^(outlook|hotmail|live|msn|windowslive)\.[a-z.]+$/, MICROSOFT],
  [/^(icloud|me|mac)\.com$/, ICLOUD],
  [/^zoho(mail)?\.com$/, ZOHO('com')],
  [/^zohomail\.eu$/, ZOHO('eu')],
  [/^gmx\.[a-z.]+$/, generic('GMX', ['imap.gmx.net', 993], ['mail.gmx.net', 587])],
  [/^web\.de$/, generic('WEB.DE', ['imap.web.de', 993], ['smtp.web.de', 587])],
  [/^fastmail\.(com|fm)$/, FASTMAIL],
];

/** Mail servers (MX) → the provider hosting a business domain. */
const BY_MX: [RegExp, Known | ((mx: string) => Known)][] = [
  [/(^|\.)(google\.com|googlemail\.com)$/, WORKSPACE],
  [/(^|\.)hostinger\.[a-z.]+$/, HOSTINGER],
  [/\.mail\.protection\.outlook\.com$/, MICROSOFT],
  [/(^|\.)zoho\.(com|eu|in|com\.au|jp)$/, (mx) => ZOHO(/zoho\.([a-z.]+)$/.exec(mx)![1]!)],
  [/(^|\.)yahoodns\.net$/, YAHOO],
  [
    /(^|\.)(ionos\.[a-z.]+|kundenserver\.de)$/,
    (mx) =>
      generic('IONOS', [`imap.ionos.${ionosTld(mx)}`, 993], [`smtp.ionos.${ionosTld(mx)}`, 465]),
  ],
  [
    /(^|\.)secureserver\.net$/,
    generic('GoDaddy', ['imap.secureserver.net', 993], ['smtpout.secureserver.net', 465]),
  ],
  [
    /(^|\.)privateemail\.com$/,
    generic(
      'Namecheap Private Email',
      ['mail.privateemail.com', 993],
      ['mail.privateemail.com', 465],
    ),
  ],
  [/(^|\.)mail\.ovh\.net$/, generic('OVHcloud', ['ssl0.ovh.net', 993], ['ssl0.ovh.net', 465])],
  [/(^|\.)one\.com$/, generic('one.com', ['imap.one.com', 993], ['send.one.com', 465])],
  [/(^|\.)rzone\.de$/, generic('STRATO', ['imap.strato.de', 993], ['smtp.strato.de', 465])],
  [/(^|\.)messagingengine\.com$/, FASTMAIL],
  [/(^|\.)icloud\.com$/, ICLOUD],
];
const ionosTld = (mx: string) => (/\.de$/.test(mx) || /kundenserver\.de$/.test(mx) ? 'de' : 'com');

/** Provider names the owner may say ("I use Zoho"). */
const BY_NAME: [RegExp, Known][] = [
  [/google\s*workspace|g\s*suite/i, WORKSPACE],
  [/g-?mail/i, GMAIL],
  [/yahoo/i, YAHOO],
  [/hostinger/i, HOSTINGER],
  [/outlook|hotmail|microsoft|office\s*365|m365/i, MICROSOFT],
  [/icloud/i, ICLOUD],
  [/zoho/i, ZOHO('com')],
  [/fastmail/i, FASTMAIL],
  [/ionos|1\s*&\s*1/i, generic('IONOS', ['imap.ionos.com', 993], ['smtp.ionos.com', 465])],
  [
    /godaddy/i,
    generic('GoDaddy', ['imap.secureserver.net', 993], ['smtpout.secureserver.net', 465]),
  ],
];

const result = (k: Known, source: DetectedMailbox['source']): DetectedMailbox => ({
  provider: k.provider,
  label: k.label,
  imap: k.imap ? { host: k.imap[0], port: k.imap[1] } : null,
  smtp: k.smtp ? { host: k.smtp[0], port: k.smtp[1] } : null,
  source,
  unsupported: k.unsupported === true,
});

export const UNKNOWN_MAILBOX: DetectedMailbox = {
  provider: 'generic',
  label: 'your email host',
  imap: null,
  smtp: null,
  source: 'unknown',
  unsupported: false,
};

export const EMAIL_ADDRESS = /^[^\s@<>()",;]+@([a-z0-9-]+(\.[a-z0-9-]+)+)$/i;

/** A provider name the owner said, or null. */
export function mailboxFromName(name: string): DetectedMailbox | null {
  const k = BY_NAME.find(([re]) => re.test(name))?.[1];
  return k ? result(k, 'name') : null;
}

/**
 * The provider of an address: from the domain if it is a consumer one, else
 * from its MX records (resolveMx is injected: DNS in production, a stub in tests).
 */
export async function detectMailbox(
  address: string,
  resolveMx: (domain: string) => Promise<{ exchange: string }[]>,
): Promise<DetectedMailbox> {
  const m = EMAIL_ADDRESS.exec(address.trim());
  if (!m) return UNKNOWN_MAILBOX;
  const domain = m[1]!.toLowerCase();
  const byDomain = BY_DOMAIN.find(([re]) => re.test(domain))?.[1];
  if (byDomain) return result(byDomain, 'address');
  let mx: string[];
  try {
    mx = (await resolveMx(domain)).map((r) => r.exchange.toLowerCase().replace(/\.$/, ''));
  } catch {
    return UNKNOWN_MAILBOX;
  }
  for (const host of mx) {
    const hit = BY_MX.find(([re]) => re.test(host));
    if (hit) return result(typeof hit[1] === 'function' ? hit[1](host) : hit[1], 'mx');
  }
  return UNKNOWN_MAILBOX;
}
