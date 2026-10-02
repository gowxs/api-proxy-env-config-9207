import { describe, expect, it } from 'vitest';
import { BlockedAddressError, safeGet } from '../src/http.ts';
import { isPublicAddress, normalizeStoreUrl } from '../src/url.ts';

describe('store address', () => {
  it('normalizes to https origin (+ subdirectory), without paths into WordPress', () => {
    const url = (s: string) => (normalizeStoreUrl(s) as { url: string }).url;
    expect(url('myshop.com')).toBe('https://myshop.com');
    expect(url('  https://MyShop.com/  ')).toBe('https://myshop.com');
    expect(url('https://myshop.com/shop/')).toBe('https://myshop.com/shop');
    expect(url('https://myshop.com/wp-admin/admin.php?page=wc-settings')).toBe(
      'https://myshop.com',
    );
    expect(url('https://myshop.com/wp-json/wc/v3/orders')).toBe('https://myshop.com');
    expect(url('https://myshop.com:443')).toBe('https://myshop.com');
  });
  it('asks for https instead of using plain http', () => {
    expect(normalizeStoreUrl('http://myshop.com')).toEqual({ problem: 'HTTPS_REQUIRED' });
  });
  it.each([
    'localhost',
    'https://localhost',
    'https://127.0.0.1',
    'https://10.0.0.5',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]',
    'https://shop',
    'https://nas.local',
    'https://router.internal',
    'https://user:pass@myshop.com',
    'https://myshop.com:8443',
    'https://my shop.com',
    'ftp://myshop.com',
    '',
  ])('refuses %s', (s) => {
    expect('problem' in normalizeStoreUrl(s)).toBe(true);
  });
  it('classifies addresses: only the public internet is allowed', () => {
    for (const a of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      '::',
      'fd00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '2001:db8::1',
      '2002:7f00:1::1',
      'not-an-ip',
    ])
      expect(isPublicAddress(a), a).toBe(false);
    for (const a of [
      '93.184.216.34',
      '8.8.8.8',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:8.8.8.8',
    ])
      expect(isPublicAddress(a), a).toBe(true);
  });
  it('the real transport refuses a host that resolves to a private address', async () => {
    await expect(safeGet('https://localhost/wp-json', {})).rejects.toSatisfy(
      (e: { cause?: unknown }) =>
        e instanceof BlockedAddressError || e.cause instanceof BlockedAddressError,
    );
    await expect(safeGet('http://example.com/', {})).rejects.toBeInstanceOf(BlockedAddressError);
  });
});
