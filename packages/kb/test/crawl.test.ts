import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crawlSite, createSafeFetcher } from '../src/index.ts';
import { serveSite } from './helpers.ts';

describe('crawlSite', () => {
  let site: Awaited<ReturnType<typeof serveSite>>;
  beforeAll(async () => {
    site = await serveSite({
      '/robots.txt': { type: 'text/plain', body: 'User-agent: *\nDisallow: /private\n' },
      '/': {
        body: `<title>Home</title><main><h1>Nordlicht</h1><p>Soy candles from Riga.</p>
               <a href="/shipping">Shipping</a> <a href="/private/admin">Admin</a>
               <a href="https://elsewhere.test/">Other site</a> <a href="/catalog.pdf">PDF</a>
               <a href="/shipping?utm_source=x">Shipping again</a></main>`,
      },
      '/shipping': {
        body: '<title>Shipping</title><main><h1>Shipping</h1><p>EU: 5 business days.</p><a href="/deep">Deep</a></main>',
      },
      '/deep': { body: '<main><p>Deep page.</p></main>' },
      '/private/admin': { body: '<p>should never be fetched</p>' },
    });
  });
  afterAll(() => site.close());

  const fetcher = () => createSafeFetcher({ allowPrivateNetworks: true });

  it('reads same-site HTML pages, respects robots.txt and skips other sites and files', async () => {
    const result = await crawlSite(`${site.base}/`, fetcher(), { delayMs: 0 });
    expect(result.pages.map((p) => new URL(p.url).pathname)).toEqual(['/', '/shipping', '/deep']);
    expect(result.pages[1]!.text).toContain('EU: 5 business days.');
    expect(result.skipped).toContainEqual({
      url: `${site.base}/private/admin`,
      reason: 'robots_txt',
    });
    expect(site.hits).not.toContain('/private/admin');
    expect(site.hits).not.toContain('/catalog.pdf');
    expect(site.hits.filter((h) => h === '/shipping')).toHaveLength(1);
  });

  it('stops at the page limit and depth limit', async () => {
    expect(
      (await crawlSite(`${site.base}/`, fetcher(), { delayMs: 0, maxPages: 1 })).pages,
    ).toHaveLength(1);
    expect(
      (await crawlSite(`${site.base}/`, fetcher(), { delayMs: 0, maxDepth: 1 })).pages,
    ).toHaveLength(2);
  });

  it('waits between requests', async () => {
    const waits: number[] = [];
    await crawlSite(`${site.base}/`, fetcher(), {
      delayMs: 500,
      maxPages: 2,
      sleep: async (ms) => void waits.push(ms),
    });
    expect(waits.every((w) => w === 500)).toBe(true);
    expect(waits.length).toBeGreaterThanOrEqual(1);
  });
});
