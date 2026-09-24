import type { lookup } from 'node:dns';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPublicAddress } from '@noctiv/core';
import { assertFetchableUrl, BlockedUrlError, createSafeFetcher } from '../src/index.ts';
import { serveSite } from './helpers.ts';

describe('assertFetchableUrl (SSRF guard)', () => {
  it.each([
    ['file:///etc/passwd', 'scheme'],
    ['ftp://example.com/', 'scheme'],
    ['http://user:pw@example.com/', 'credentials'],
    ['http://example.com:22/', 'port'],
    ['http://127.0.0.1/', 'private_address'],
    ['http://10.0.0.5/', 'private_address'],
    ['http://169.254.169.254/latest/meta-data/', 'private_address'],
    ['http://[::1]/', 'private_address'],
    ['http://[::ffff:192.168.1.1]/', 'private_address'],
    ['http://0.0.0.0/', 'private_address'],
    ['http://localhost/', 'private_hostname'],
    ['http://metadata.google.internal/', 'private_hostname'],
    ['not a url', 'malformed'],
  ])('blocks %s (%s)', (url, reason) => {
    expect(() => assertFetchableUrl(url)).toThrow(new BlockedUrlError(reason));
  });

  it('allows ordinary public websites', () => {
    expect(assertFetchableUrl('https://www.nordlicht-candles.lv/shop').hostname).toBe(
      'www.nordlicht-candles.lv',
    );
  });

  it.each([
    ['8.8.8.8', true],
    ['2a00:1450:4001:80b::200e', true],
    ['192.168.0.1', false],
    ['100.64.0.1', false],
    ['fd00::1', false],
    ['fe80::1', false],
    ['224.0.0.1', false],
  ])('isPublicAddress(%s) = %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected);
  });
});

describe('safe fetcher', () => {
  let site: Awaited<ReturnType<typeof serveSite>>;
  beforeAll(async () => {
    site = await serveSite({
      '/': { body: '<p>home</p>' },
      '/big': { body: 'x'.repeat(5000) },
      '/loop': { status: 302, body: '', location: '/loop' },
      '/to-metadata': {
        status: 302,
        body: '',
        location: 'http://169.254.169.254/latest/meta-data/',
      },
    });
  });
  afterAll(() => site.close());

  it('checks resolved addresses at connect time (DNS rebinding)', async () => {
    // "shop.test" resolves to loopback: blocked although the name looks public.
    const rebinding = ((
      _h: string,
      _o: unknown,
      cb: (e: null, a: { address: string; family: number }[]) => void,
    ) => cb(null, [{ address: '127.0.0.1', family: 4 }])) as unknown as typeof lookup;
    const f = createSafeFetcher({ lookup: rebinding });
    await expect(f('http://shop.test/')).rejects.toThrow(/resolves_to_private_address/);
  });

  it('fetches, caps size, limits redirects and re-checks redirect targets', async () => {
    const f = createSafeFetcher({ allowPrivateNetworks: true, maxBytes: 1000 });
    expect(new TextDecoder().decode((await f(`${site.base}/`)).body)).toBe('<p>home</p>');
    await expect(f(`${site.base}/big`)).rejects.toThrow(/too_large/);
    await expect(f(`${site.base}/loop`)).rejects.toThrow(/too_many_redirects/);
    const strict = createSafeFetcher({ allowPrivateNetworks: false });
    await expect(strict(`${site.base}/to-metadata`)).rejects.toThrow(BlockedUrlError);
  });
});
