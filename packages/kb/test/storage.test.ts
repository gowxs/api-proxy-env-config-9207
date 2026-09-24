import { describe, expect, it } from 'vitest';
import {
  kbObjectPath,
  MemoryBlobStore,
  SupabaseStorageBlobStore,
  TenantPathError,
} from '../src/index.ts';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';

describe('tenant-scoped object paths', () => {
  it('builds "<tenant>/<source>/<file>" and rejects anything else', () => {
    expect(kbObjectPath(A, S, 'prices.pdf')).toBe(`${A}/${S}/prices.pdf`);
    for (const bad of [
      () => kbObjectPath('x', S, 'a.pdf'),
      () => kbObjectPath(A, S, '../b.pdf'),
      () => kbObjectPath(A, S, '.env'),
    ]) {
      expect(bad).toThrow(TenantPathError);
    }
  });

  it("a store refuses another tenant's path", async () => {
    const store = new MemoryBlobStore();
    await store.put(B, `${B}/${S}/x.txt`, new Uint8Array([1]), 'text/plain');
    await expect(store.get(A, `${B}/${S}/x.txt`)).rejects.toBeInstanceOf(TenantPathError);
    await expect(store.get(A, `${A}/../${B}/${S}/x.txt`)).rejects.toBeInstanceOf(TenantPathError);
    await expect(store.delete(A, [`${B}/`])).rejects.toBeInstanceOf(TenantPathError);
  });
});

describe('SupabaseStorageBlobStore request shape', () => {
  it('uses the bucket, bearer token, apikey and encoded path; errors carry no path', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const store = new SupabaseStorageBlobStore({
      baseUrl: 'https://ref.supabase.co/storage/v1/',
      token: 'tok',
      apiKey: 'pub',
      fetch: (async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 403 });
      }) as unknown as typeof fetch,
    });
    const err = await store.get(A, `${A}/${S}/Preis liste.pdf`).catch((e: Error) => e);
    expect(calls[0]!.url).toBe(
      `https://ref.supabase.co/storage/v1/object/kb-files/${A}/${S}/Preis%20liste.pdf`,
    );
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer tok', apikey: 'pub' });
    expect(String(err)).toBe('StorageError: storage download failed (HTTP 403)');
  });
});
