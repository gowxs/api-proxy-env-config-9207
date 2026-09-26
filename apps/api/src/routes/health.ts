import type { FastifyInstance } from 'fastify';
import type { Sql } from 'postgres';

/** A worker that has not written its heartbeat for this long is down. */
export const HEARTBEAT_MAX_AGE_S = 3 * 60;
/** A connected mailbox not health-checked for this long means the checks stopped. */
export const MAILBOX_CHECK_MAX_AGE_MIN = 60;

export interface WorkerHealth {
  lastBeat: Date | null;
  connected: number;
  unchecked: number;
}

export async function readWorkerHealth(sql: Sql): Promise<WorkerHealth> {
  const [r] = await sql<{ last_beat: Date | null; connected: number; unchecked: number }[]>`
    select last_beat, connected, unchecked
    from app.worker_health(make_interval(mins => ${MAILBOX_CHECK_MAX_AGE_MIN}))`;
  return { lastBeat: r!.last_beat, connected: r!.connected, unchecked: r!.unchecked };
}

/**
 * GET /healthz/worker (PLAN.md §25), for the external uptime monitor:
 * 503 when the worker's heartbeat is older than 3 minutes or a connected
 * mailbox has not been health-checked for 60 minutes. Counts only — no
 * tenant, address or error text.
 */
export function healthRoutes(
  app: FastifyInstance,
  read: () => Promise<WorkerHealth>,
  now: () => Date = () => new Date(),
) {
  app.get('/healthz/worker', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    let h: WorkerHealth;
    try {
      h = await read();
    } catch {
      return reply.code(503).send({ status: 'unavailable', problems: ['database'] });
    }
    const age = h.lastBeat ? Math.round((now().getTime() - h.lastBeat.getTime()) / 1000) : null;
    const problems: string[] = [];
    if (age === null || age > HEARTBEAT_MAX_AGE_S) problems.push('worker_heartbeat');
    if (h.unchecked > 0) problems.push('mailbox_checks');
    return reply.code(problems.length ? 503 : 200).send({
      status: problems.length ? 'degraded' : 'ok',
      problems,
      heartbeatAgeSeconds: age,
      mailboxes: { connected: h.connected, unchecked: h.unchecked },
    });
  });
}
