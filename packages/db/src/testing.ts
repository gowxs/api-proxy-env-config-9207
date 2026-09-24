/**
 * Test fixtures. Uses the schema-owner connection (bypasses RLS) to build
 * data, so tests can then observe it through the restricted roles.
 * Never import from runtime code.
 */
import { randomUUID } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

// Values the db test global setup provides to tests (packages/db/test/global-setup.ts).
declare module 'vitest' {
  export interface ProvidedContext {
    /** Schema owner (Supabase `postgres` role) — bypasses RLS; use only for fixtures. */
    ownerDatabaseUrl: string;
    apiDatabaseUrl: string;
    workerDatabaseUrl: string;
    /** GreenMail IMAP/SMTP test server (plaintext, local only). */
    greenmail: { host: string; smtpPort: number; imapPort: number };
  }
}

export const EMBEDDING_DIMS = 768;
/** Mailboxes that exist in the test GreenMail server (login = address). */
export const GREENMAIL_USERS = {
  shopA: { address: 'shop@nordlicht.test', password: 'app-pass-a' },
  shopB: { address: 'info@other-shop.test', password: 'app-pass-b' },
  customer: { address: 'anna@example-mail.test', password: 'customer-pass' },
  customer2: { address: 'janis@example-mail.test', password: 'customer2-pass' },
} as const;
export const TEST_EMBEDDING_MODEL = 'test-embedding';

/** Unit vector with 1 at `axis` — makes nearest-neighbour results predictable. */
export function axisVector(axis: number): string {
  const v = new Array<number>(EMBEDDING_DIMS).fill(0);
  v[axis] = 1;
  return `[${v.join(',')}]`;
}

export interface SeededTenant {
  label: string;
  tenantId: string;
  userId: string;
  connectionId: string;
  sourceId: string;
  chunkId: string;
  leadId: string;
  threadId: string;
  messageId: string;
  draftId: string;
}

/** Creates a tenant with one owner and at least one row in every tenant table. */
export async function seedTenant(
  owner: Sql,
  label: string,
  opts: { embeddingAxis: number },
): Promise<SeededTenant> {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const connectionId = randomUUID();
  const sourceId = randomUUID();
  const chunkId = randomUUID();
  const leadId = randomUUID();
  const threadId = randomUUID();
  const messageId = randomUUID();
  const outboundMessageId = randomUUID();
  const draftId = randomUUID();
  const email = `owner-${label}-${tenantId.slice(0, 8)}@example.test`;
  const customer = `customer-${label}@example.test`;

  await owner.begin(async (tx) => {
    await tx`insert into auth.users (id, email, aud, role) values (${userId}, ${email}, 'authenticated', 'authenticated')`;
    await tx`insert into public.tenants (id, name, timezone) values (${tenantId}, ${`Tenant ${label}`}, 'Europe/Riga')`;
    await tx`insert into public.tenant_members (tenant_id, user_id) values (${tenantId}, ${userId})`;
    await tx`insert into public.email_connections
               (id, tenant_id, provider, email_address, imap_host, imap_port, smtp_host, smtp_port,
                smtp_security, username, credentials_ciphertext, credentials_key_id, status)
             values (${connectionId}, ${tenantId}, 'generic', ${`inbox-${label}@example.test`},
                     'imap.example.test', 993, 'smtp.example.test', 465, 'tls',
                     ${`inbox-${label}`}, ${Buffer.from(`sealed-${label}`)}, 'k1', 'connected')`;
    await tx`insert into public.connection_health_checks (tenant_id, connection_id, imap_ok, smtp_ok)
             values (${tenantId}, ${connectionId}, true, true)`;
    await tx`insert into public.kb_sources (id, tenant_id, type, title, status)
             values (${sourceId}, ${tenantId}, 'note', ${`Prices ${label}`}, 'ready')`;
    await tx.unsafe(
      `insert into public.kb_chunks (id, tenant_id, source_id, chunk_index, content, embedding, embedding_model)
       values ($1, $2, $3, 0, $4, $5::extensions.vector, $6)`,
      [
        chunkId,
        tenantId,
        sourceId,
        `Tenant ${label} secret price list: consulting costs 100 EUR`,
        axisVector(opts.embeddingAxis),
        TEST_EMBEDDING_MODEL,
      ],
    );
    const uploadSourceId = randomUUID();
    await tx`insert into public.kb_sources (id, tenant_id, type, title, mime_type, status)
             values (${uploadSourceId}, ${tenantId}, 'file', ${`upload-${label}.txt`}, 'text/plain', 'pending')`;
    await tx`insert into public.kb_uploads (source_id, tenant_id, bytes, mime_type)
             values (${uploadSourceId}, ${tenantId}, ${Buffer.from(`Private upload ${label}`)}, 'text/plain')`;
    await tx`insert into public.jobs (tenant_id, queue, payload)
             values (${tenantId}, 'test.seed', ${tx.json({ label })})`;
    await tx`insert into public.kb_allowlist (tenant_id, source_id, kind, value)
             values (${tenantId}, ${sourceId}, 'domain', ${`${label}.example.test`})`;
    await tx`insert into public.leads (id, tenant_id, email, name) values (${leadId}, ${tenantId}, ${customer}, ${`Customer ${label}`})`;
    await tx`insert into public.lead_events (tenant_id, lead_id, to_stage, actor) values (${tenantId}, ${leadId}, 'received', 'system')`;
    await tx`insert into public.threads (id, tenant_id, connection_id, lead_id, subject)
             values (${threadId}, ${tenantId}, ${connectionId}, ${leadId}, 'Question')`;
    await tx`insert into public.messages
               (id, tenant_id, connection_id, thread_id, direction, message_id_header, from_address, subject, body_text, received_at)
             values (${messageId}, ${tenantId}, ${connectionId}, ${threadId}, 'inbound',
                     ${`<${messageId}@example.test>`}, ${customer}, 'Question', ${`Private body ${label}`}, now())`;
    await tx`insert into public.messages
               (id, tenant_id, connection_id, thread_id, direction, message_id_header, from_address, subject, body_text, received_at)
             values (${outboundMessageId}, ${tenantId}, ${connectionId}, ${threadId}, 'outbound',
                     ${`<${outboundMessageId}@noctiv.test>`}, ${`inbox-${label}@example.test`}, 'Re: Question', 'Reply', now())`;
    await tx`insert into public.message_processing (tenant_id, message_id, status, final_action)
             values (${tenantId}, ${messageId}, 'drafted', 'draft')`;
    await tx`insert into public.drafts (id, tenant_id, thread_id, source_message_id, kind, to_address, subject, body)
             values (${draftId}, ${tenantId}, ${threadId}, ${messageId}, 'reply', ${customer}, 'Re: Question', ${`Draft ${label}`})`;
    await tx`insert into public.outbound_emails (tenant_id, draft_id, thread_id, message_id_header, to_address, subject, sent_via)
             values (${tenantId}, ${draftId}, ${threadId}, ${`<${randomUUID()}@noctiv.test>`}, ${customer}, 'Re: Question', 'owner_approval')`;
    await tx`insert into public.escalations (tenant_id, message_id, thread_id, category, reason)
             values (${tenantId}, ${messageId}, ${threadId}, 'hard_list', 'complaint')`;
    await tx`insert into public.usage_daily (tenant_id, day, llm_calls) values (${tenantId}, current_date, 1)`;
    await tx`insert into public.notifications (tenant_id, channel, kind, dedupe_key)
             values (${tenantId}, 'email_owner', 'draft', ${`draft:${draftId}`})`;
    await tx`insert into public.audit_log (tenant_id, actor, action) values (${tenantId}, 'system', 'seed')`;
    await tx`insert into public.tenant_deletions (tenant_id) values (${tenantId})`;
  });

  return {
    label,
    tenantId,
    userId,
    connectionId,
    sourceId,
    chunkId,
    leadId,
    threadId,
    messageId,
    draftId,
  };
}

/**
 * Runs `fn` the way PostgREST runs a dashboard request: as the
 * `authenticated` role with the user's JWT claims set for the transaction.
 * Rolled back afterwards so tests cannot leave changes behind.
 */
export async function asDashboardUser<T>(
  owner: Sql,
  userId: string | null,
  fn: (tx: TransactionSql) => Promise<T>,
  role: 'authenticated' | 'anon' = 'authenticated',
): Promise<T> {
  let result!: T;
  const rollback = new Error('rollback');
  try {
    await owner.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      if (userId) {
        const claims = JSON.stringify({ sub: userId, role });
        await tx`select set_config('request.jwt.claims', ${claims}, true),
                        set_config('request.jwt.claim.sub', ${userId}, true)`;
      }
      result = await fn(tx);
      throw rollback;
    });
  } catch (e) {
    if (e !== rollback) throw e;
  }
  return result;
}
