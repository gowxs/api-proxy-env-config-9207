import { seedTenant } from '@noctiv/db/testing';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { digestText, maybeSendDigest, zonedInstant, type DigestStats } from '../src/ops/digest.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

const health = async () =>
  (
    await worker<{ last_beat: Date | null; connected: number; unchecked: number }[]>`
      select last_beat, connected, unchecked from app.worker_health(interval '60 minutes')`
  )[0]!;

describe('worker heartbeat and health (PLAN.md §25)', () => {
  it('the heartbeat is visible to the health check', async () => {
    await worker`select app.worker_beat('test-worker:1', now() - interval '1 hour')`;
    const h = await health();
    expect(Date.now() - h.last_beat!.getTime()).toBeLessThan(60_000);
  });

  it('counts connected mailboxes not checked for 60 minutes', async () => {
    const t = await seedTenant(owner, 'monitoring', { embeddingAxis: 181 });
    await owner`update public.email_connections
                set status = 'connected', last_checked_at = now() - interval '2 hours'
                where id = ${t.connectionId}`;
    const before = await health();
    expect(before.unchecked).toBeGreaterThanOrEqual(1);
    await owner`update public.email_connections set last_checked_at = now() where id = ${t.connectionId}`;
    expect((await health()).unchecked).toBe(before.unchecked - 1);
  });
});

describe('admin daily digest', () => {
  it('08:00 Riga is 06:00 UTC in winter and 05:00 UTC in summer', () => {
    expect(zonedInstant('2026-01-15', 8, 'Europe/Riga').toISOString()).toBe(
      '2026-01-15T06:00:00.000Z',
    );
    expect(zonedInstant('2026-03-29', 8, 'Europe/Riga').toISOString()).toBe(
      '2026-03-29T05:00:00.000Z',
    );
  });

  it('is sent once per Riga day from 08:00, with counts only', async () => {
    const sent: { to: string; subject: string; text: string }[] = [];
    const deps = {
      sql: worker,
      transport: { sendMail: async (m: never) => void sent.push(m) } as never,
      from: 'Noctiv <notify@noctiv.test>',
      to: 'admin@noctiv.test',
    };
    // A day no other test uses; 07:59 Riga is too early.
    expect(await maybeSendDigest(deps, new Date('2031-06-10T04:59:00Z'))).toBe(false);
    expect(await maybeSendDigest(deps, new Date('2031-06-10T05:01:00Z'))).toBe(true);
    expect(await maybeSendDigest(deps, new Date('2031-06-10T09:00:00Z'))).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('admin@noctiv.test');
    expect(sent[0]!.subject).toBe('[admin] Noctiv daily digest 2031-06-10');
    for (const heading of ['ACCOUNTS', 'E-MAILS', 'AI (GEMINI)', 'SYSTEM', 'WAITLIST'])
      expect(sent[0]!.text).toContain(heading);
  });

  it('a failed send is retried later', async () => {
    let calls = 0;
    const deps = {
      sql: worker,
      transport: {
        sendMail: async () => {
          calls++;
          if (calls === 1) throw new Error('smtp down');
        },
      } as never,
      from: 'x@noctiv.test',
      to: 'admin@noctiv.test',
    };
    await expect(maybeSendDigest(deps, new Date('2031-06-11T06:00:00Z'))).rejects.toThrow();
    // Within 10 minutes: not claimed again.
    expect(await maybeSendDigest(deps, new Date('2031-06-11T06:01:00Z'))).toBe(false);
    await owner`update app.admin_digests set last_attempt_at = now() - interval '11 minutes'
                where day = '2031-06-11'`;
    expect(await maybeSendDigest(deps, new Date('2031-06-11T06:20:00Z'))).toBe(true);
    expect(calls).toBe(2);
  });

  it('text: every section, names on one line', () => {
    const zero = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 0]));
    const s = {
      tenants: zero([
        'active',
        'new',
        'onboarded',
        'trial',
        'paying',
        'past_due',
        'canceled',
        'comped',
      ]),
      emails: zero([
        'processed',
        'drafted',
        'auto_sent',
        'escalated',
        'skipped',
        'failed',
        'still_queued',
      ]),
      sent: zero(['auto', 'approved', 'failed']),
      escalations: zero(['new', 'open']),
      quota: zero(['alerts', 'waiting_now']),
      jobs: { dead: { 'mail.process': 2 }, backlog: 0 },
      mailboxes: zero(['connected', 'disconnected', 'disconnects', 'unhealthy_alerts']),
      usage: {
        day: '2031-06-09',
        llm_calls: 1200,
        tokens_in: 5,
        tokens_out: 5,
        embed_tokens: 0,
        est_cost_micro_eur: 1_500_000,
        halted_tenants: 0,
      },
      waitlist: zero(['new', 'confirmed', 'total_confirmed']),
      top_tenants: [{ name: 'Evil\nSubject: x', processed: 3, auto_sent: 1, escalated: 0 }],
    } as unknown as DigestStats;
    const text = digestText(s, '2031-06-10', { heartbeat: '20 s ago', unchecked: 0 });
    expect(text).toContain('Failed jobs: mail.process 2');
    expect(text).toContain('1,200 calls');
    expect(text).toContain('est. €1.50');
    expect(text).toContain('  Evil Subject: x: 3 / 1 / 0');
  });
});
