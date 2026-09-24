import { describe, expect, it } from 'vitest';
import {
  classifyImapError,
  classifySmtpError,
  isUnsupportedProvider,
  resolveSettings,
  savesSentAutomatically,
} from '../src/index.ts';

const imapErr = (responseText: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error('Command failed'), {
    responseText,
    authenticationFailed: true,
    ...extra,
  });

describe('IMAP errors from real providers', () => {
  it.each([
    [
      '[ALERT] Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)',
      'APP_PASSWORD_REQUIRED',
    ],
    ['[AUTHENTICATIONFAILED] Invalid credentials (Failure)', 'AUTH_FAILED'],
    [
      '[ALERT] Your account is not enabled for IMAP use. Please visit your Gmail settings page and enable your account for IMAP access. (Failure)',
      'IMAP_DISABLED',
    ],
    ['AUTHENTICATE failed. BasicAuthBlocked', 'BASIC_AUTH_DISABLED'],
    ['LOGIN failed.', 'AUTH_FAILED'],
  ])('%s → %s', (text, code) => {
    expect(classifyImapError(imapErr(text))).toBe(code);
  });

  it.each([
    [{ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND imap.nope.test' }, 'HOST_NOT_FOUND'],
    [{ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }, 'WRONG_PORT'],
    [{ code: 'EHOSTUNREACH', message: 'x' }, 'HOST_UNREACHABLE'],
    [{ code: 'ERR_SSL_WRONG_VERSION_NUMBER', message: 'wrong version number' }, 'WRONG_PORT'],
    [
      {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
        message: "Hostname/IP does not match certificate's altnames",
      },
      'TLS_ERROR',
    ],
    [{ code: 'ETIMEDOUT', message: 'Connection timed out' }, 'TIMEOUT'],
  ])('network %o → %s', (err, code) => {
    expect(classifyImapError(Object.assign(new Error(err.message), err))).toBe(code);
  });
});

describe('SMTP errors from real providers', () => {
  const smtp = (response: string) =>
    Object.assign(new Error('Invalid login'), { code: 'EAUTH', response, responseCode: 535 });
  it.each([
    [
      '534-5.7.9 Application-specific password required. Learn more at https://support.google.com/mail/?p=InvalidSecondFactor',
      'APP_PASSWORD_REQUIRED',
    ],
    ['535-5.7.8 Username and Password not accepted.', 'SMTP_AUTH_FAILED'],
    [
      '535 5.7.139 Authentication unsuccessful, SmtpClientAuthentication is disabled for the Tenant.',
      'BASIC_AUTH_DISABLED',
    ],
    ['535 5.7.8 Error: authentication failed: (reason unavailable)', 'SMTP_AUTH_FAILED'],
  ])('%s → %s', (text, code) => {
    expect(classifySmtpError(smtp(text))).toBe(code);
  });
});

describe('presets', () => {
  it('fills Gmail and Hostinger servers and ignores user-supplied hosts for them', () => {
    const s = resolveSettings({
      provider: 'hostinger',
      emailAddress: 'Info@Shop.LV ',
      imap: { host: 'evil', port: 1, secure: false },
    });
    expect(s).toEqual({
      provider: 'hostinger',
      emailAddress: 'info@shop.lv',
      username: 'Info@Shop.LV',
      imap: { host: 'imap.hostinger.com', port: 993, secure: true },
      smtp: { host: 'smtp.hostinger.com', port: 465, security: 'tls' },
    });
    expect(
      savesSentAutomatically(resolveSettings({ provider: 'gmail', emailAddress: 'a@gmail.com' })),
    ).toBe(true);
    expect(savesSentAutomatically(s)).toBe(false);
  });

  it('fills Yahoo servers', () => {
    expect(resolveSettings({ provider: 'yahoo', emailAddress: 'shop@yahoo.com' })).toMatchObject({
      imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
      smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    });
  });

  it('recognises Microsoft accounts as unsupported', () => {
    expect(isUnsupportedProvider('generic', 'a@hotmail.com')).toBe(true);
    expect(isUnsupportedProvider('generic', 'a@outlook.de')).toBe(true);
    expect(isUnsupportedProvider('outlook', 'a@company.lv')).toBe(true);
    expect(isUnsupportedProvider('generic', 'a@company.lv')).toBe(false);
  });
});
