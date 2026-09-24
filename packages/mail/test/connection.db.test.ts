import { GREENMAIL_USERS } from '@noctiv/db/testing';
import { describe, expect, inject, it } from 'vitest';
import { testMailConnection, verifySmtp, type MailServerSettings } from '../src/index.ts';

const gm = inject('greenmail');
const insecure = { allowInsecure: true, timeoutMs: 5_000 };
const settings = (address: string): MailServerSettings => ({
  provider: 'generic',
  emailAddress: address,
  username: address,
  imap: { host: gm.host, port: gm.imapPort, secure: false },
  smtp: { host: gm.host, port: gm.smtpPort, security: 'starttls' },
});

describe('testMailConnection against GreenMail', () => {
  it('logs in to IMAP and SMTP and reports the inbox baseline', async () => {
    const r = await testMailConnection(
      settings(GREENMAIL_USERS.shopA.address),
      GREENMAIL_USERS.shopA.password,
      insecure,
    );
    expect(r).toMatchObject({ ok: true, sentAppendMode: 'none', sentFolder: null });
    expect(r.ok && Number(r.uidValidity)).toBeGreaterThan(0);
  });

  it('reports a wrong password as AUTH_FAILED at the IMAP stage', async () => {
    const r = await testMailConnection(settings(GREENMAIL_USERS.shopA.address), 'wrong', insecure);
    expect(r).toMatchObject({
      ok: false,
      code: 'AUTH_FAILED',
      stage: 'imap',
      message: 'The username or App Password is wrong.',
    });
  });

  it('reports a wrong SMTP password as SMTP_AUTH_FAILED', async () => {
    await expect(
      verifySmtp(settings(GREENMAIL_USERS.shopA.address), 'wrong', insecure),
    ).rejects.toMatchObject({
      code: 'SMTP_AUTH_FAILED',
      stage: 'smtp',
    });
  });

  it('reports a closed port and an unknown host', async () => {
    const s = settings(GREENMAIL_USERS.shopA.address);
    expect(
      await testMailConnection({ ...s, imap: { ...s.imap, port: 1 } }, 'x', insecure),
    ).toMatchObject({ code: 'WRONG_PORT' });
    expect(
      await testMailConnection(
        { ...s, imap: { ...s.imap, host: 'imap.does-not-exist.invalid' } },
        'x',
        insecure,
      ),
    ).toMatchObject({
      code: 'HOST_NOT_FOUND',
    });
  });

  it('without the development flag refuses private addresses and unencrypted settings', async () => {
    const s = settings(GREENMAIL_USERS.shopA.address);
    expect(await testMailConnection(s, 'x')).toMatchObject({ code: 'INSECURE_SETTINGS' });
    expect(
      await testMailConnection({ ...s, imap: { host: gm.host, port: 993, secure: true } }, 'x'),
    ).toMatchObject({ code: 'BLOCKED_ADDRESS' });
  });
});
