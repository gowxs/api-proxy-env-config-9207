import { gzipSync } from 'node:zlib';
import type { Logger } from '@noctiv/core';
import { Encrypter } from 'age-encryption';
import type { Sql } from 'postgres';
import type { AdminTransport } from './keepalive.ts';

/** Tables of the export (app.backup_export decides the columns; credentials and e-mail text are never in it). */
export const EXPORT_TABLES = [
  'tenants',
  'tenant_members',
  'email_connections',
  'leads',
  'lead_events',
  'threads',
  'messages',
  'kb_sources',
  'price_items',
  'quotes',
  'quote_lines',
  'documents',
  'booking_settings',
  'bookings',
  'intake_forms',
] as const;

export const EXPORT_EVERY_MS = 7 * 24 * 3600_000;
export const EXPORT_MAIL_MAX_BYTES = 8_000_000;
export const EXPORT_HOUR_RIGA = 4;

/** gzip'd JSON of the tables, encrypted to the operator's age public key (same key as the nightly R2 dump). */
export async function buildEncryptedExport(
  sql: Sql,
  recipient: string,
  at = new Date(),
): Promise<{ data: Uint8Array; filename: string; rows: Record<string, number> }> {
  const tables: Record<string, unknown[]> = {};
  for (const t of EXPORT_TABLES) {
    const [r] = await sql<{ rows: unknown[] }[]>`select app.backup_export(${t}) as rows`;
    tables[t] = r!.rows;
  }
  const rows = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
  const json = JSON.stringify({ exportedAt: at.toISOString(), format: 'noctiv-export-1', tables });
  const enc = new Encrypter();
  enc.addRecipient(recipient);
  const data = await enc.encrypt(gzipSync(Buffer.from(json)));
  return { data, filename: `noctiv-export-${at.toISOString().slice(0, 10)}.json.gz.age`, rows };
}

export interface ExportDeps {
  sql: Sql;
  transport: AdminTransport;
  from: string;
  to: string;
  recipient: string;
  logger?: Logger;
  everyMs?: number;
  maxBytes?: number;
}

/** Weekly: builds the export and mails it to the admin (or says it is too big for e-mail). */
export async function maybeMailExport(deps: ExportDeps): Promise<'sent' | 'too_large' | 'not_due'> {
  const every = deps.everyMs ?? EXPORT_EVERY_MS;
  const [c] = await deps.sql<{ due: boolean }[]>`
    select app.ops_claim('export_mail', ${`${Math.round(every / 1000) - 3600} seconds`}::interval) as due`;
  if (!c?.due) return 'not_due';
  try {
    const out = await buildEncryptedExport(deps.sql, deps.recipient);
    const summary = Object.entries(out.rows)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    const size = out.data.byteLength;
    const tooLarge = size > (deps.maxBytes ?? EXPORT_MAIL_MAX_BYTES);
    await deps.transport.sendMail({
      from: deps.from,
      to: deps.to,
      subject: tooLarge
        ? '[admin] Noctiv weekly export is too large for e-mail'
        : `[admin] Noctiv weekly encrypted export ${out.filename.slice(14, 24)}`,
      text: tooLarge
        ? `The encrypted export is ${(size / 1e6).toFixed(1)} MB, over the e-mail limit, so it was not attached.\n` +
          'Enable the nightly Cloudflare R2 backup (docs/backup-restore.md) to keep full backups.'
        : 'Encrypted export of the Noctiv business tables (no credentials, no e-mail text).\n\n' +
          `Rows: ${summary}\n\n` +
          `Decrypt: age -d -i noctiv-backup-key.txt ${out.filename} | gunzip > export.json\n` +
          'The key is the one from docs/backup-restore.md. Without it the file cannot be read.',
      headers: { 'Auto-Submitted': 'auto-generated' },
      ...(tooLarge
        ? {}
        : {
            attachments: [
              {
                filename: out.filename,
                content: Buffer.from(out.data),
                contentType: 'application/octet-stream',
              },
            ],
          }),
    });
    const detail = `${tooLarge ? 'too large, not attached' : 'sent'}; ${size} bytes; ${summary}`;
    await deps.sql`select app.ops_done('export_mail', ${!tooLarge}, ${detail})`;
    deps.logger?.info({ bytes: size, tooLarge }, 'weekly export mailed');
    return tooLarge ? 'too_large' : 'sent';
  } catch (e) {
    await deps.sql`select app.ops_done('export_mail', false, ${String(e)})`.catch(() => undefined);
    throw e;
  }
}
