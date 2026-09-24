import robotsParserModule from 'robots-parser';
import { extractHtml } from '../extract/html.ts';
import { USER_AGENT, type SafeFetch } from './safe-fetch.ts';

export interface CrawlOptions {
  maxPages?: number;
  maxDepth?: number;
  /** Pause between requests to the tenant's site. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CrawledPage {
  url: string;
  title: string;
  text: string;
}

export interface CrawlResult {
  pages: CrawledPage[];
  skipped: { url: string; reason: string }[];
}

// The package is CommonJS: the default import is the function itself at runtime.
const robotsParser = robotsParserModule as unknown as (
  url: string,
  robotsTxt: string,
) => { isAllowed(url: string, ua?: string): boolean | undefined };

const SKIP_EXTENSIONS =
  /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|zip|gz|mp[34]|mov|avi|docx?|xlsx?|pptx?|css|js|json|xml|woff2?)$/i;

function siteKey(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '');
}

function normalize(u: URL): string {
  const n = new URL(u);
  n.hash = '';
  // Tracking parameters create endless duplicates.
  for (const k of [...n.searchParams.keys()])
    if (/^(utm_|fbclid|gclid|mc_)/i.test(k)) n.searchParams.delete(k);
  return n.toString().replace(/\/$/, '');
}

/**
 * Breadth-first crawl of one website (the tenant's own). Same site only
 * (www. and bare domain count as one), robots.txt respected, HTML only,
 * bounded by page count and depth, one request at a time with a delay.
 */
export async function crawlSite(
  startUrl: string,
  fetcher: SafeFetch,
  opts: CrawlOptions = {},
): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? 50;
  const maxDepth = opts.maxDepth ?? 3;
  const delayMs = opts.delayMs ?? 1_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const start = new URL(startUrl);
  const site = siteKey(start);
  const robotsUrl = new URL('/robots.txt', start).toString();
  let robotsTxt = '';
  try {
    const r = await fetcher(robotsUrl, 'text/plain');
    if (r.status === 200) robotsTxt = new TextDecoder().decode(r.body);
  } catch {
    // No robots.txt reachable: allowed by convention.
  }
  const robots = robotsParser(robotsUrl, robotsTxt);

  const queue: { url: string; depth: number }[] = [{ url: normalize(start), depth: 0 }];
  const seen = new Set(queue.map((q) => q.url));
  const pages: CrawledPage[] = [];
  const skipped: CrawlResult['skipped'] = [];
  let requests = 0;

  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift()!;
    if (robots.isAllowed(url, USER_AGENT) === false) {
      skipped.push({ url, reason: 'robots_txt' });
      continue;
    }
    if (requests++ > 0) await sleep(delayMs);
    let res;
    try {
      res = await fetcher(url);
    } catch (e) {
      skipped.push({
        url,
        reason: (e as Error).name === 'BlockedUrlError' ? (e as Error).message : 'fetch_failed',
      });
      continue;
    }
    if (siteKey(new URL(res.url)) !== site) {
      skipped.push({ url, reason: 'redirected_off_site' });
      continue;
    }
    if (res.status !== 200 || !/text\/html|application\/xhtml/i.test(res.contentType)) {
      skipped.push({ url, reason: `status_${res.status}_or_not_html` });
      continue;
    }
    const page = extractHtml(new TextDecoder().decode(res.body), res.url);
    if (page.text.trim()) pages.push({ url: res.url, title: page.title, text: page.text });

    if (depth >= maxDepth) continue;
    for (const link of page.links) {
      const u = new URL(link);
      if (siteKey(u) !== site || SKIP_EXTENSIONS.test(u.pathname)) continue;
      const key = normalize(u);
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push({ url: key, depth: depth + 1 });
    }
  }
  return { pages, skipped };
}
