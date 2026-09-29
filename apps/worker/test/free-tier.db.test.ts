import { gunzipSync } from 'node:zlib';
import { seedTenant } from '@noctiv/db/testing';
import { Decrypter, generateIdentity, identityToRecipient } from 'age-encryption';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { maybeSendDigest, databaseLines } from '../src/ops/digest.ts';
import { buildEncryptedExport, maybeMailExport } from '../src/ops/export.ts';
import { createDbWatch, maybeKeepalive } from '../src/ops/keepalive.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

describe('database keepalive', () => {
  it('writes and reads back, once per interval', async () => {
    await owner`delete from app.ops_runs where job = 'keepalive'`;
    expect(await maybeKeepalive({ sql: worker })).toBe('ran');
    expect(await maybeKeepalive({ sql: worker })).toBe('not_due');
    const [s] =
      await worker`select last_ok_at, last_detail from app.ops_status() where job = 'keepalive'`;
    expect(s!.last_ok_at).toBeTruthy();
    expect(s!.last_detail).toContain('write+read ok');
  });
});

describe('database watch', () => {
  it('alerts after 3 failed probes, not again for 6 h, and says when it is back', async () => {
    let t = 0;
    let fail = true;
    const alerts: string[] = [];
    const tick = createDbWatch({
      probe: async () => {
        if (fail) throw new Error('project paused');
      },
      alert: async (subject) => void alerts.push(subject),
      now: () => t,
    });
    await tick();
    await tick();
    expect(alerts).toEqual([]);
    await tick();
    expect(alerts).toEqual(['[admin] Noctiv database unreachable']);
    t += 3600_000;
    await tick();
    expect(alerts).toHaveLength(1);
    t += 6 * 3600_000;
    await tick();
    expect(alerts).toHaveLength(2);
    fail = false;
    await tick();
    expect(alerts.at(-1)).toBe('[admin] Noctiv database is reachable again');
  });
});

describe('weekly encrypted export', () => {
  it('contains the business tables, no credentials and no e-mail text; only the key opens it', async () => {
    const t = await seedTenant(owner, 'export', { embeddingAxis: 190 });
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const out = await buildEncryptedExport(worker, recipient);
    expect(out.filename).toMatch(/^noctiv-export-\d{4}-\d{2}-\d{2}\.json\.gz\.age$/);
    // Ciphertext: the tenant name is not readable in it.
    expect(Buffer.from(out.data).toString('latin1')).not.toContain('"tables"');

    const d = new Decrypter();
    d.addIdentity(identity);
    const json = gunzipSync(Buffer.from(await d.decrypt(out.data))).toString();
    const parsed = JSON.parse(json) as { tables: Record<string, Record<string, unknown>[]> };
    expect(parsed.tables.tenants!.some((r) => r.id === t.tenantId)).toBe(true);
    const conn = parsed.tables.email_connections!.find((r) => r.tenant_id === t.tenantId)!;
    expect(conn).toBeDefined();
    expect(Object.keys(conn)).not.toEqual(expect.arrayContaining(['credentials_ciphertext']));
    for (const k of ['credentials_ciphertext', 'credentials_key_id', 'username'])
      expect(json).not.toContain(`"${k}"`);
    for (const k of ['body_text', 'html_hidden_text']) expect(json).not.toContain(`"${k}"`);
  });

  it('mails the attachment once a week, and says so when it is too large', async () => {
    await owner`delete from app.ops_runs where job = 'export_mail'`;
    const identity = await generateIdentity();
    const recipient = await identityToRecipient(identity);
    const sent: { subject: string; attachments?: unknown[] }[] = [];
    const deps = {
      sql: worker,
      transport: { sendMail: async (m: never) => void sent.push(m) } as never,
      from: 'n@example.test',
      to: 'admin@example.test',
      recipient,
    };
    expect(await maybeMailExport(deps)).toBe('sent');
    expect(sent[0]!.attachments).toHaveLength(1);
    expect(await maybeMailExport(deps)).toBe('not_due');
    await owner`delete from app.ops_runs where job = 'export_mail'`;
    expect(await maybeMailExport({ ...deps, maxBytes: 10 })).toBe('too_large');
    expect(sent[1]!.attachments).toBeUndefined();
  });

  it('refuses tables outside the allow-list', async () => {
    await expect(worker`select app.backup_export('audit_log')`).rejects.toThrow(/not exportable/);
  });
});

describe('digest database size', () => {
  it('shows size against the limit and warns from 70 %', () => {
    expect(databaseLines({ bytes: 100 * 1024 * 1024, limitMb: 500 })).toEqual([
      '  Size: 100.0 MB of 500 MB (20 %)',
    ]);
    const warn = databaseLines({ bytes: 360 * 1024 * 1024, limitMb: 500 });
    expect(warn[0]).toContain('72 %');
    expect(warn[1]).toContain('WARNING');
    expect(databaseLines({ bytes: 349 * 1024 * 1024, limitMb: 500 })).toHaveLength(1);
  });

  it('the sent digest has a DATABASE section', async () => {
    const sent: { subject: string; text: string }[] = [];
    await owner`delete from app.admin_digests where day = '2031-07-01'`.catch(() => undefined);
    await maybeSendDigest(
      {
        sql: worker,
        transport: { sendMail: async (m: never) => void sent.push(m) } as never,
        from: 'n@example.test',
        to: 'admin@example.test',
        dbLimitMb: 1,
      },
      new Date('2031-07-01T08:00:00Z'),
    );
    expect(sent[0]!.text).toMatch(/DATABASE\n {2}Size: [\d.]+ MB of 1 MB/);
    expect(sent[0]!.subject).toContain('WARNING: database size');
  });
});
