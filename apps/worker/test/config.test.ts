import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from '../src/config.ts';
import { loadApiConfig } from '../../api/src/config.ts';

const worker = {
  WORKER_DATABASE_URL: 'postgres://w@localhost/db',
  CREDENTIALS_PUBLIC_KEY: 'a'.repeat(43),
  CREDENTIALS_PRIVATE_KEY_FILE: '/run/secrets/key',
};
const prodMailer = {
  NODE_ENV: 'production',
  SYSTEM_SMTP_HOST: 'smtp-relay.brevo.com',
  ACTION_LINK_SECRET: 'x'.repeat(32),
  ADMIN_EMAIL: 'ops@noctiv.io',
  DATA_REGION: 'hetzner fsn1',
  DATA_REGION_IN_EU: 'true',
};

describe('worker config: notification mailer', () => {
  it('development runs without a system mailer (notifications stay queued)', () => {
    const c = loadWorkerConfig(worker);
    expect(c.SYSTEM_SMTP_HOST).toBeUndefined();
    expect(c.SYSTEM_SMTP_SECURITY).toBe('starttls');
  });

  it('production needs the mailer, the link secret and the admin address', () => {
    expect(() => loadWorkerConfig({ ...worker, NODE_ENV: 'production' })).toThrow(
      /SYSTEM_SMTP_HOST/,
    );
    expect(loadWorkerConfig({ ...worker, ...prodMailer }).SYSTEM_SMTP_HOST).toBe(
      'smtp-relay.brevo.com',
    );
  });

  it('production refuses an unencrypted mailer and short secrets', () => {
    expect(() =>
      loadWorkerConfig({ ...worker, ...prodMailer, SYSTEM_SMTP_SECURITY: 'none' }),
    ).toThrow(/SYSTEM_SMTP_SECURITY/);
    expect(() => loadWorkerConfig({ ...worker, ACTION_LINK_SECRET: 'short' })).toThrow(
      /ACTION_LINK_SECRET/,
    );
  });
});

describe('api config: action links', () => {
  const api = {
    API_DATABASE_URL: 'postgres://a@localhost/db',
    SUPABASE_URL: 'https://example.supabase.co',
    CREDENTIALS_PUBLIC_KEY: 'a'.repeat(43),
  };
  const prod = { ...api, NODE_ENV: 'production', DATA_REGION_IN_EU: 'true' };
  it('production needs the link secret and invite codes; dev login is refused', () => {
    expect(loadApiConfig(api).ACTION_LINK_SECRET).toBeUndefined();
    expect(loadApiConfig(api).SIGNUP_INVITE_CODES).toEqual([]);
    expect(() => loadApiConfig({ ...prod, SIGNUP_INVITE_CODES: 'A1' })).toThrow(
      /ACTION_LINK_SECRET/,
    );
    expect(() => loadApiConfig({ ...prod, ACTION_LINK_SECRET: 'y'.repeat(32) })).toThrow(
      /SIGNUP_INVITE_CODES/,
    );
    const ok = { ...prod, ACTION_LINK_SECRET: 'y'.repeat(32), SIGNUP_INVITE_CODES: ' A1 , B2 ' };
    expect(loadApiConfig(ok).SIGNUP_INVITE_CODES).toEqual(['A1', 'B2']);
    expect(() =>
      loadApiConfig({ ...ok, DEV_LOGIN_USER_ID: 'd0e10000-0000-4000-8000-000000000001' }),
    ).toThrow(/DEV_LOGIN_USER_ID/);
  });
});

describe('temporary deployment options', () => {
  it('production must state whether it runs in the EU', () => {
    const { DATA_REGION_IN_EU: _, ...noRegion } = prodMailer;
    expect(() => loadWorkerConfig({ ...worker, ...noRegion })).toThrow(/DATA_REGION_IN_EU/);
  });

  it('SYSTEM_MAILER_PENDING allows production without the mailer (notifications stay queued)', () => {
    const { SYSTEM_SMTP_HOST: _, ...noMailer } = prodMailer;
    expect(() => loadWorkerConfig({ ...worker, ...noMailer })).toThrow(/SYSTEM_SMTP_HOST/);
    expect(
      loadWorkerConfig({ ...worker, ...noMailer, SYSTEM_MAILER_PENDING: 'true' })
        .SYSTEM_MAILER_PENDING,
    ).toBe(true);
  });

  it('the private key comes from a file or from the environment, never both', () => {
    const { CREDENTIALS_PRIVATE_KEY_FILE: _, ...noFile } = worker;
    const key = 'b'.repeat(43);
    expect(
      loadWorkerConfig({ ...noFile, CREDENTIALS_PRIVATE_KEY: key }).CREDENTIALS_PRIVATE_KEY,
    ).toBe(key);
    expect(() => loadWorkerConfig(noFile)).toThrow(/CREDENTIALS_PRIVATE_KEY/);
    expect(() => loadWorkerConfig({ ...worker, CREDENTIALS_PRIVATE_KEY: key })).toThrow(
      /CREDENTIALS_PRIVATE_KEY/,
    );
  });

  it('non-EU regions produce a warning; EU and unstated development do not', async () => {
    const { nonEuWarning } = await import('@noctiv/core');
    expect(
      nonEuWarning(
        { NODE_ENV: 'production', DATA_REGION: 'London', DATA_REGION_IN_EU: 'false' },
        'worker',
      ),
    ).toMatch(/NON-EU REGION: the worker runs in "London"/);
    expect(
      nonEuWarning(
        { NODE_ENV: 'production', DATA_REGION: 'Frankfurt', DATA_REGION_IN_EU: 'true' },
        'api',
      ),
    ).toBeNull();
    expect(nonEuWarning({ NODE_ENV: 'development', DATA_REGION: 'unspecified' }, 'api')).toBeNull();
  });
});
