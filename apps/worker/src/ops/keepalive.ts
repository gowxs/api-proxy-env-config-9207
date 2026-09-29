import type { Logger } from '@noctiv/core';
import type { Transporter } from 'nodemailer';
import type { Sql } from 'postgres';

/** The free Supabase plan pauses an idle project; a write every 2 days is plenty of margin. */
export const KEEPALIVE_EVERY_MS = 2 * 24 * 3600_000;

/**
 * Scheduled write + read on the database (app.keepalive_ping). Runs at most
 * once per interval across all workers (app.ops_claim); logs the result.
 */
export async function maybeKeepalive(
  deps: { sql: Sql; logger?: Logger },
  everyMs = KEEPALIVE_EVERY_MS,
): Promise<'ran' | 'not_due'> {
  const [c] = await deps.sql<{ due: boolean }[]>`
    select app.ops_claim('keepalive', ${`${Math.round(everyMs / 1000) - 60} seconds`}::interval) as due`;
  if (!c?.due) return 'not_due';
  try {
    const [r] = await deps.sql<{ at: Date }[]>`select app.keepalive_ping() as at`;
    const ageMs = Math.abs(Date.now() - new Date(r!.at).getTime());
    if (ageMs > 60_000)
      throw new Error(`read back a stale value (${Math.round(ageMs / 1000)} s old)`);
    await deps.sql`select app.ops_done('keepalive', true, ${`write+read ok at ${new Date(r!.at).toISOString()}`})`;
    deps.logger?.info({ at: r!.at }, 'database keepalive: write+read ok');
    return 'ran';
  } catch (e) {
    await deps.sql`select app.ops_done('keepalive', false, ${String(e)})`.catch(() => undefined);
    deps.logger?.error({ err: String(e) }, 'database keepalive failed');
    throw e;
  }
}

export interface DbWatchDeps {
  probe: () => Promise<void>;
  alert: (subject: string, text: string) => Promise<void>;
  logger?: Logger;
  /** Consecutive failed probes before the first alert. */
  failuresBeforeAlert?: number;
  /** Minimum time between repeated "still down" alerts. */
  repeatMs?: number;
  now?: () => number;
}

/**
 * Probes the database every few minutes. It cannot read state from the
 * database it is testing, so it keeps its own counters: alert after N
 * consecutive failures, repeat at most every 6 hours, tell when it is back.
 */
export function createDbWatch(deps: DbWatchDeps) {
  const need = deps.failuresBeforeAlert ?? 3;
  const repeatMs = deps.repeatMs ?? 6 * 3600_000;
  const now = deps.now ?? Date.now;
  let failures = 0;
  let downSince: number | null = null;
  let lastAlertAt: number | null = null;
  return async function tick(): Promise<void> {
    try {
      await deps.probe();
    } catch (e) {
      failures += 1;
      downSince ??= now();
      deps.logger?.error({ err: String(e), failures }, 'database probe failed');
      if (failures >= need && (lastAlertAt === null || now() - lastAlertAt >= repeatMs)) {
        lastAlertAt = now();
        const since = new Date(downSince).toISOString();
        await deps
          .alert(
            '[admin] Noctiv database unreachable',
            `The database has not answered ${failures} checks in a row (first failure ${since}).\n\n` +
              `Last error: ${String(e).slice(0, 300)}\n\n` +
              'On the Supabase free plan the most likely cause is a paused project: open the Supabase dashboard and restore it. ' +
              'Otherwise check the Supabase status page and the pooler host.',
          )
          .catch((err: unknown) => deps.logger?.error({ err: String(err) }, 'db alert failed'));
      }
      return;
    }
    if (downSince !== null && lastAlertAt !== null) {
      await deps
        .alert(
          '[admin] Noctiv database is reachable again',
          `The database answers again (down since ${new Date(downSince).toISOString()}).`,
        )
        .catch((err: unknown) => deps.logger?.error({ err: String(err) }, 'db alert failed'));
    }
    failures = 0;
    downSince = null;
    lastAlertAt = null;
  };
}

/** A probe that gives up after `ms`, so a paused project (connection hangs) counts as a failure. */
export function sqlProbe(sql: Sql, ms = 15_000): () => Promise<void> {
  return async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        sql`select 1`,
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error(`no answer within ${ms} ms`)), ms);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export type AdminTransport = Pick<Transporter, 'sendMail'>;
