import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Fixed-window counters in memory. Phase 1 runs one API instance on one
 * VPS, so this is enough; a second instance would need a shared store.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { max: number; windowMs: number; now?: () => number }) {
    this.max = opts.max;
    this.windowMs = opts.windowMs;
    this.now = opts.now ?? Date.now;
  }

  /** Counts one hit; returns seconds to wait when over the limit, else 0. */
  hit(key: string): number {
    const t = this.now();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) {
      e = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, e);
      if (this.hits.size > 50_000) this.sweep(t);
    }
    e.count++;
    return e.count > this.max ? Math.ceil((e.resetAt - t) / 1000) : 0;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

interface Rule {
  name: string;
  match: (req: FastifyRequest) => string | null;
  limiter: RateLimiter;
}

const MIN = 60_000;
const tenantOf = (url: string) => /^\/v1\/tenants\/([0-9a-f-]{36})/.exec(url)?.[1];

/**
 * Limits (PLAN.md step 13). Per IP for everything; tighter where a request
 * is expensive or reaches the outside world (live mailbox tests log in to
 * owner-supplied servers, website sources start a crawl), or guards a
 * bearer-like secret (action links).
 */
export function defaultRules(): Rule[] {
  const post = (req: FastifyRequest) => req.method === 'POST';
  return [
    {
      name: 'ip',
      match: (req) => `ip:${req.ip}`,
      limiter: new RateLimiter({ max: 600, windowMs: MIN }),
    },
    {
      name: 'action-links',
      match: (req) =>
        req.url.startsWith('/actions/') || req.url.startsWith('/q/') ? `act:${req.ip}` : null,
      limiter: new RateLimiter({ max: 30, windowMs: 10 * MIN }),
    },
    {
      name: 'connection-test',
      match: (req) =>
        post(req) && /\/connections\/test$/.test(req.url) ? `ct:${tenantOf(req.url)}` : null,
      limiter: new RateLimiter({ max: 10, windowMs: 10 * MIN }),
    },
    {
      name: 'kb-add',
      match: (req) =>
        post(req) && /\/kb\/(website|files|notes|sources\/[^/]+\/refresh)$/.test(req.url)
          ? `kb:${tenantOf(req.url)}`
          : null,
      limiter: new RateLimiter({ max: 60, windowMs: 60 * MIN }),
    },
    {
      name: 'signup',
      match: (req) => (post(req) && req.url === '/v1/tenants' ? `signup:${req.ip}` : null),
      limiter: new RateLimiter({ max: 5, windowMs: 60 * MIN }),
    },
  ];
}

export function registerRateLimits(app: FastifyInstance, rules: Rule[] = defaultRules()) {
  app.addHook('onRequest', async (req, reply) => {
    for (const r of rules) {
      const key = r.match(req);
      if (!key) continue;
      const wait = r.limiter.hit(key);
      if (wait > 0) {
        req.log.warn({ rule: r.name }, 'rate limited');
        return reply
          .code(429)
          .header('retry-after', String(wait))
          .send({ error: 'Too many requests. Please wait a moment and try again.' });
      }
    }
  });
}
