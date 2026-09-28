import { describe, expect, it } from 'vitest';
import { detectMailbox, mailboxFromName } from '../src/detect.ts';

const mx =
  (...hosts: string[]) =>
  async () =>
    hosts.map((exchange) => ({ exchange }));
const noDns = async () => {
  throw new Error('should not be asked');
};

describe('mailbox provider detection (PLAN.md §27.3)', () => {
  it('consumer addresses: from the address alone, no DNS', async () => {
    expect(await detectMailbox('anna@gmail.com', noDns)).toMatchObject({
      provider: 'gmail',
      source: 'address',
    });
    expect(await detectMailbox('shop@yahoo.de', noDns)).toMatchObject({ provider: 'yahoo' });
    expect(await detectMailbox('me@icloud.com', noDns)).toMatchObject({
      provider: 'generic',
      imap: { host: 'imap.mail.me.com', port: 993 },
      smtp: { host: 'smtp.mail.me.com', port: 587 },
    });
    expect(await detectMailbox('x@hotmail.com', noDns)).toMatchObject({ unsupported: true });
  });

  it('business domains: from the MX records', async () => {
    expect(
      await detectMailbox(
        'info@kerzenwerk.de',
        mx('aspmx.l.google.com.', 'alt1.aspmx.l.google.com'),
      ),
    ).toMatchObject({ provider: 'google_workspace', label: 'Google Workspace', source: 'mx' });
    expect(await detectMailbox('info@shop.lv', mx('mx1.hostinger.com'))).toMatchObject({
      provider: 'hostinger',
    });
    expect(await detectMailbox('info@studio.eu', mx('mx.zoho.eu', 'mx2.zoho.eu'))).toMatchObject({
      provider: 'generic',
      label: 'Zoho Mail',
      imap: { host: 'imap.zoho.eu', port: 993 },
      smtp: { host: 'smtp.zoho.eu', port: 465 },
    });
    expect(await detectMailbox('info@firma.de', mx('mx00.ionos.de'))).toMatchObject({
      imap: { host: 'imap.ionos.de' },
    });
    expect(
      await detectMailbox('info@corp.com', mx('corp-com.mail.protection.outlook.com')),
    ).toMatchObject({ provider: 'outlook', unsupported: true });
  });

  it('unknown host, DNS failure or a bad address: "Other", the owner fills in the servers', async () => {
    for (const d of [
      await detectMailbox('info@unknown.test', mx('mail.unknown.test')),
      await detectMailbox('info@nx.test', async () => {
        throw new Error('ENOTFOUND');
      }),
      await detectMailbox('not an address', noDns),
    ])
      expect(d).toMatchObject({ provider: 'generic', source: 'unknown', imap: null });
  });

  it('provider names the owner says', () => {
    expect(mailboxFromName('We use Google Workspace')).toMatchObject({
      provider: 'google_workspace',
    });
    expect(mailboxFromName('gmail')).toMatchObject({ provider: 'gmail' });
    expect(mailboxFromName('Zoho')).toMatchObject({ label: 'Zoho Mail' });
    expect(mailboxFromName('Office 365')).toMatchObject({ unsupported: true });
    expect(mailboxFromName('my own server')).toBeNull();
  });
});
