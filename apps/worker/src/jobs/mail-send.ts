import {
  emptyAllowlist,
  hostOf,
  isAutomaticMode,
  nextFollowupAt,
  ownerNotificationPayload,
  renderReplyEmail,
  type EmailTemplate,
  type Logger,
  type TenantMode,
} from '@noctiv/core';
import { loadAllowlist } from '@noctiv/kb';

type DraftKind = 'reply' | 'followup' | 'acknowledgement';
import { JobError, withTenant, type Job } from '@noctiv/db';
import {
  appendToFolder,
  buildOutboundMessage,
  connectImap,
  findSentFolder,
  folderHasMessageId,
  headerText,
  newMessageId,
  openMailboxPassword,
  sendRawMessage,
  SmtpSendError,
  type MailServerSettings,
} from '@noctiv/mail';
import type { Sql, TransactionSql } from 'postgres';
import { DISCONNECT_CODES, loadConnection, markDisconnected } from '../mailbox/connection-repo.ts';
import { setLeadStage } from '../pipeline/leads.ts';

export interface MailSendDeps {
  sql: Sql;
  keys: { publicKey: string; privateKey: string };
  allowInsecure: boolean;
  logger?: Logger;
  /**
   * An outbound email in 'sending' state younger than this may still be in
   * flight in another worker (job lease expiry); it is retried later instead
   * of being recovered. Must stay below the job lease (900 s).
   */
  inProgressMs?: number;
}

type SentVia = 'auto' | 'owner_approval';
type AppendMode = 'append' | 'provider_auto' | 'none';

interface Outbound {
  id: string;
  status: 'queued' | 'sending' | 'sent' | 'failed';
  messageId: string;
  sentVia: SentVia;
}

interface SendPlan {
  recover: boolean;
  outbound: Outbound;
  draft: {
    id: string;
    kind: DraftKind;
    to: string;
    subject: string;
    text: string;
    /** The tenant's e-mail design (null: text only). */
    html: string | null;
  };
  threadId: string;
  leadId: string | null;
  sourceMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  connection: {
    id: string;
    settings: MailServerSettings;
    ciphertext: Buffer;
    displayName: string;
    appendMode: AppendMode;
    sentFolder: string | null;
  };
  tenant: { timezone: string; followupAfterDays: number; followupMax: number };
  followupsSent: number;
}

type PlanResult =
  | { plan: SendPlan }
  | { done: Record<string, unknown> }
  | { fail: { code: string; outboundId: string | null } };

const DEFAULT_IN_PROGRESS_MS = 4 * 60_000;

/**
 * mail.send(draftId) — PLAN.md §4.5, exactly once as far as SMTP allows.
 * 1. Lock the draft; auto-sends re-check tenant mode and rate caps; record
 *    the outbound email with a pre-generated Message-ID ('sending').
 * 2. SMTP send of bytes built once (same bytes go to the Sent folder).
 * 3. Mark sent, store the outbound message, thread → awaiting_customer with
 *    the next follow-up time (Q7), lead → sent.
 * 4. APPEND to Sent unless the provider saves sent mail itself.
 * A retry that finds the email still 'sending' (worker crashed mid-send)
 * searches the Sent folder for the Message-ID instead of sending blindly;
 * when that cannot prove anything, it never resends: the owner is told.
 */
export function mailSendHandler(deps: MailSendDeps) {
  const inProgressMs = deps.inProgressMs ?? DEFAULT_IN_PROGRESS_MS;
  return async (job: Job) => {
    const draftId = String(job.payload.draftId);
    const tenantId = job.tenantId;
    const planned = await withTenant(deps.sql, tenantId, (tx) =>
      planSend(tx, tenantId, draftId, inProgressMs),
    );
    if ('done' in planned) return planned.done;
    if ('fail' in planned) {
      await withTenant(deps.sql, tenantId, (tx) =>
        finalizeFailed(tx, tenantId, draftId, planned.fail.outboundId, planned.fail.code),
      );
      return { status: 'failed', code: planned.fail.code };
    }
    const plan = planned.plan;
    const c = plan.connection;
    const password = openMailboxPassword(c.ciphertext, deps.keys, tenantId, c.id);
    const mailOpts = { allowInsecure: deps.allowInsecure };

    if (plan.recover) {
      const found = await searchSent(plan, password, mailOpts).catch(() => undefined);
      if (found === undefined) {
        throw new JobError('sent folder unavailable during recovery', { retryable: true });
      }
      if (found) {
        await withTenant(deps.sql, tenantId, (tx) =>
          finalizeSent(tx, tenantId, plan, 'recovered from Sent folder', true),
        );
        return { status: 'sent', recovered: true };
      }
      // Gmail files every accepted message in Sent: absent there means never accepted.
      if (c.appendMode !== 'provider_auto') {
        await withTenant(deps.sql, tenantId, (tx) =>
          finalizeFailed(tx, tenantId, draftId, plan.outbound.id, 'SEND_UNCERTAIN'),
        );
        return { status: 'failed', code: 'SEND_UNCERTAIN' };
      }
    }

    const raw = await buildOutboundMessage({
      from: { address: c.settings.emailAddress, name: c.displayName },
      to: plan.draft.to,
      subject: plan.draft.subject,
      text: plan.draft.text,
      html: plan.draft.html,
      messageId: plan.outbound.messageId,
      inReplyTo: plan.inReplyTo,
      references: plan.references,
      autoSubmitted: plan.outbound.sentVia === 'auto',
    });

    let response: string;
    try {
      ({ response } = await sendRawMessage(
        c.settings,
        password,
        { from: c.settings.emailAddress, to: plan.draft.to, raw },
        mailOpts,
      ));
    } catch (e) {
      const err =
        e instanceof SmtpSendError ? e : new SmtpSendError('UNKNOWN', false, 'unexpected error');
      if (DISCONNECT_CODES.has(err.code)) {
        await withTenant(deps.sql, tenantId, async (tx) => {
          await markDisconnected(tx, tenantId, c.id, err.code);
          await finalizeFailed(tx, tenantId, draftId, plan.outbound.id, err.code);
        });
        throw new JobError(`smtp auth failed: ${err.code}`, { retryable: false });
      }
      if (err.permanent || job.attempts >= job.maxAttempts) {
        await withTenant(deps.sql, tenantId, (tx) =>
          finalizeFailed(tx, tenantId, draftId, plan.outbound.id, err.code, err.detail),
        );
        throw new JobError(`smtp send failed: ${err.code}`, { retryable: false });
      }
      // Not accepted by the server: the next attempt sends again with the same Message-ID.
      await withTenant(
        deps.sql,
        tenantId,
        (tx) => tx`update public.outbound_emails set status = 'queued', error = ${err.code}
                   where id = ${plan.outbound.id} and status = 'sending'`,
      );
      throw new JobError(`smtp send failed: ${err.code}`, { retryable: true });
    }

    await withTenant(deps.sql, tenantId, (tx) =>
      finalizeSent(tx, tenantId, plan, response, c.appendMode !== 'append'),
    );
    if (c.appendMode === 'append') {
      await appendSent(deps, tenantId, plan, password, raw).catch((e: unknown) =>
        deps.logger?.warn(
          { tenantId, connectionId: c.id, err: e instanceof Error ? e.message : 'error' },
          'append to Sent failed',
        ),
      );
    }
    return { status: 'sent' };
  };
}

async function planSend(
  tx: TransactionSql,
  tenantId: string,
  draftId: string,
  inProgressMs: number,
): Promise<PlanResult> {
  const [d] = await tx<
    {
      id: string;
      status: string;
      kind: DraftKind;
      to_address: string;
      subject: string;
      body: string | null;
      decided_by: string | null;
      thread_id: string;
      source_message_id: string | null;
      connection_id: string;
      lead_id: string | null;
      followups_sent: number;
      thread_status: string;
      last_outbound_at: Date | null;
      tenant_status: string;
      entitled: boolean;
      mode: string;
      reply_signature: string | null;
      email_template: EmailTemplate;
      brand_company_name: string | null;
      brand_logo_url: string | null;
      brand_color: string | null;
      brand_website: string | null;
      brand_phone: string | null;
      brand_address: string | null;
      brand_social_links: string[];
      tenant_name: string;
      timezone: string;
      followup_after_days: number;
      followup_max: number;
      max_replies_per_hour: number;
      max_ai_replies_per_sender_24h: number;
    }[]
  >`
    select d.id, d.status, d.kind, d.to_address, d.subject, d.body, d.decided_by, d.thread_id, d.source_message_id,
           th.connection_id, th.lead_id, th.followups_sent, th.status as thread_status, th.last_outbound_at,
           t.status as tenant_status, app.billing_entitled(t.billing_status, t.trial_ends_at) as entitled, t.mode, t.reply_signature, t.name as tenant_name, t.timezone,
           t.email_template, t.brand_company_name, t.brand_logo_url, t.brand_color, t.brand_website,
           t.brand_phone, t.brand_address, t.brand_social_links,
           t.followup_after_days, t.followup_max, t.max_replies_per_hour, t.max_ai_replies_per_sender_24h
    from public.drafts d
    join public.threads th on th.id = d.thread_id
    join public.tenants t on t.id = d.tenant_id
    where d.id = ${draftId}
    for update of d`;
  if (!d) return { done: { skipped: 'draft_missing' } };

  const [existing] = await tx<
    {
      id: string;
      status: Outbound['status'];
      message_id_header: string;
      sent_via: SentVia;
      stale: boolean;
    }[]
  >`
    select id, status, message_id_header, sent_via,
           updated_at < now() - make_interval(secs => ${inProgressMs / 1000}) as stale
    from public.outbound_emails where draft_id = ${draftId}`;

  let outbound: Outbound;
  let recover = false;
  if (existing) {
    if (existing.status === 'sent') {
      if (d.status !== 'sent')
        await tx`update public.drafts set status = 'sent' where id = ${d.id}`;
      return { done: { status: 'already_sent' } };
    }
    if (existing.status === 'failed') return { done: { skipped: 'failed_earlier' } };
    if (existing.status === 'sending') {
      if (!existing.stale) throw new JobError('send in progress', { retryable: true });
      recover = true;
    }
    await tx`update public.outbound_emails set status = 'sending', attempts = attempts + 1 where id = ${existing.id}`;
    outbound = {
      id: existing.id,
      status: 'sending',
      messageId: existing.message_id_header,
      sentVia: existing.sent_via,
    };
  } else {
    if (d.status !== 'approved') return { done: { skipped: `draft_${d.status}` } };
    if (d.tenant_status !== 'active') return { done: { skipped: 'tenant_inactive' } };
    if (d.kind === 'followup') {
      // A follow-up is only sent while the customer still has not answered.
      const answered = await tx`
        select 1 from public.messages where thread_id = ${d.thread_id} and direction = 'inbound'
          and received_at > ${d.last_outbound_at ?? new Date(0)} limit 1`;
      if (d.thread_status !== 'awaiting_customer' || answered.length) {
        await tx`update public.drafts set status = 'superseded' where id = ${d.id}`;
        return { done: { skipped: 'followup_superseded' } };
      }
    }
    outbound = { id: '', status: 'sending', messageId: '', sentVia: 'owner_approval' };
    outbound.sentVia = d.decided_by === 'auto' ? 'auto' : 'owner_approval';
  }

  const conn = await loadConnection(tx, d.connection_id);
  if (!conn || conn.status !== 'connected') {
    return { fail: { code: 'MAILBOX_DISCONNECTED', outboundId: existing?.id ?? null } };
  }
  if (!d.body?.trim()) return { fail: { code: 'DRAFT_EMPTY', outboundId: existing?.id ?? null } };

  if (!existing && outbound.sentVia === 'auto') {
    // Serialise auto-sends per tenant so two jobs cannot both pass the caps.
    await tx`select 1 from public.tenants where id = ${tenantId} for update`;
    const [caps] = await tx<{ sender: number; hour: number }[]>`
      select count(*) filter (where to_address = ${d.to_address} and created_at > now() - interval '24 hours')::int as sender,
             count(*) filter (where created_at > now() - interval '1 hour')::int as hour
      from public.outbound_emails where sent_via = 'auto' and status <> 'failed'`;
    const reasons: string[] = [];
    const isAck = d.kind === 'acknowledgement';
    // Acknowledgements are a mode-3 feature; replies go out in either automatic mode.
    if (isAck ? d.mode !== 'full_auto' : !isAutomaticMode(d.mode as TenantMode))
      reasons.push(isAck ? 'mode_changed' : 'mode_changed_to_draft_only');
    // Subscription lapsed between drafting and sending: the owner decides.
    if (!d.entitled) reasons.push('billing_inactive');
    if (caps!.sender >= d.max_ai_replies_per_sender_24h) reasons.push('sender_cap_reached');
    if (caps!.hour >= d.max_replies_per_hour) reasons.push('tenant_hour_cap_reached');
    if (reasons.length) {
      if (isAck) {
        // Not a reply the owner should approve: the escalation already asks them to answer.
        await tx`update public.drafts set status = 'superseded' where id = ${d.id}`;
        return { done: { skipped: 'acknowledgement_cancelled', reasons } };
      }
      await downgradeToApproval(tx, tenantId, d.id, d.source_message_id, reasons);
      return { done: { status: 'downgraded', reasons } };
    }
  }

  // Threading: answer the source message, else the newest message in the thread.
  const [src] = await tx<{ message_id_header: string; reference_ids: string[] }[]>`
    select message_id_header, reference_ids from public.messages
    where ${d.source_message_id ? tx`id = ${d.source_message_id}` : tx`thread_id = ${d.thread_id}`}
    order by received_at desc limit 1`;

  const [extra] = await tx<
    { display_name: string | null; sent_folder_path: string | null; sent_append_mode: AppendMode }[]
  >`select display_name, sent_folder_path, sent_append_mode from public.email_connections where id = ${conn.id}`;

  if (!existing) {
    const messageId = newMessageId(conn.settings.emailAddress);
    const [row] = await tx<{ id: string }[]>`
      insert into public.outbound_emails (tenant_id, draft_id, thread_id, message_id_header, to_address, subject,
                                          in_reply_to, reference_ids, sent_via, status, attempts)
      values (${tenantId}, ${d.id}, ${d.thread_id}, ${messageId}, ${d.to_address}, ${d.subject},
              ${src?.message_id_header ?? null}, ${src?.reference_ids ?? []}, ${outbound.sentVia}, 'sending', 1)
      returning id`;
    outbound = { ...outbound, id: row!.id, messageId };
  }

  // The tenant's e-mail design frames the reply; the reply text is unchanged.
  const rendered = renderReplyEmail({
    template: d.email_template,
    body: d.body,
    signature: d.reply_signature,
    brand: {
      companyName: d.brand_company_name ?? d.tenant_name,
      logoUrl: d.brand_logo_url,
      color: d.brand_color,
      website: d.brand_website,
      phone: d.brand_phone,
      address: d.brand_address,
      socialLinks: d.brand_social_links,
    },
    allowlist: d.email_template === 'plain' ? emptyAllowlist() : await loadAllowlist(tx),
  });
  return {
    plan: {
      recover,
      outbound,
      draft: {
        id: d.id,
        kind: d.kind,
        to: d.to_address,
        subject: d.subject,
        text: rendered.text,
        html: rendered.html,
      },
      threadId: d.thread_id,
      leadId: d.lead_id,
      sourceMessageId: d.source_message_id,
      inReplyTo: src?.message_id_header ?? null,
      references: src?.reference_ids ?? [],
      connection: {
        id: conn.id,
        settings: conn.settings,
        ciphertext: conn.ciphertext,
        displayName: extra?.display_name?.trim() || d.tenant_name,
        appendMode: extra?.sent_append_mode ?? 'none',
        sentFolder: extra?.sent_folder_path ?? null,
      },
      tenant: {
        timezone: d.timezone,
        followupAfterDays: d.followup_after_days,
        followupMax: d.followup_max,
      },
      followupsSent: d.followups_sent,
    },
  };
}

async function searchSent(
  plan: SendPlan,
  password: string,
  opts: { allowInsecure: boolean },
): Promise<boolean> {
  if (plan.connection.appendMode === 'none') return false;
  const client = await connectImap(plan.connection.settings, password, opts);
  try {
    const folder = await findSentFolder(client, plan.connection.sentFolder);
    return folder ? await folderHasMessageId(client, folder, plan.outbound.messageId) : false;
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function appendSent(
  deps: MailSendDeps,
  tenantId: string,
  plan: SendPlan,
  password: string,
  raw: Buffer,
): Promise<void> {
  const client = await connectImap(plan.connection.settings, password, {
    allowInsecure: deps.allowInsecure,
  });
  try {
    const folder = await findSentFolder(client, plan.connection.sentFolder);
    if (!folder) return;
    await appendToFolder(client, folder, raw);
    await withTenant(deps.sql, tenantId, async (tx) => {
      await tx`update public.outbound_emails set appended_to_sent = true where id = ${plan.outbound.id}`;
      if (folder !== plan.connection.sentFolder) {
        await tx`update public.email_connections set sent_folder_path = ${folder} where id = ${plan.connection.id}`;
      }
    });
  } finally {
    await client.logout().catch(() => client.close());
  }
}

async function finalizeSent(
  tx: TransactionSql,
  tenantId: string,
  plan: SendPlan,
  smtpResponse: string,
  inSentFolder: boolean,
): Promise<void> {
  const now = new Date();
  await tx`
    update public.outbound_emails
    set status = 'sent', sent_at = ${now}, smtp_response = ${smtpResponse.slice(0, 500)}, error = null,
        appended_to_sent = ${inSentFolder && plan.connection.appendMode === 'append'}
    where id = ${plan.outbound.id}`;
  await tx`update public.drafts set status = 'sent' where id = ${plan.draft.id}`;
  await tx`
    insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, in_reply_to,
                                 reference_ids, from_address, to_addresses, subject, body_text, received_at)
    values (${tenantId}, ${plan.connection.id}, ${plan.threadId}, 'outbound', ${plan.outbound.messageId}, ${plan.inReplyTo},
            ${[...plan.references, ...(plan.inReplyTo ? [plan.inReplyTo] : [])]}, ${plan.connection.settings.emailAddress},
            ${[plan.draft.to]}, ${plan.draft.subject}, ${plan.draft.text}, ${now})
    on conflict (connection_id, message_id_header) do nothing`;

  if (plan.draft.kind === 'acknowledgement') {
    // The customer was told a person will answer: the conversation stays with the
    // owner (escalated), no follow-up is scheduled and the lead stage is unchanged.
    await tx`update public.threads set last_outbound_at = ${now} where id = ${plan.threadId}`;
    await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
             values (${tenantId}, 'system', 'email.sent', 'draft', ${plan.draft.id},
                     ${tx.json({ sentVia: plan.outbound.sentVia, outboundId: plan.outbound.id, kind: 'acknowledgement' })})`;
    return;
  }
  const isFollowup = plan.draft.kind === 'followup';
  const sentCount = isFollowup ? plan.followupsSent + 1 : 0;
  const more = sentCount < plan.tenant.followupMax;
  const next = more
    ? nextFollowupAt(now, plan.tenant.followupAfterDays, plan.tenant.timezone)
    : null;
  await tx`
    update public.threads
    set status = 'awaiting_customer', last_outbound_at = ${now}, followups_sent = ${sentCount},
        next_followup_at = ${next}, followup_stop_reason = ${more ? null : 'max_reached'}
    where id = ${plan.threadId}`;
  if (plan.leadId) {
    await setLeadStage(
      tx,
      tenantId,
      plan.leadId,
      isFollowup ? 'followed_up' : 'sent',
      plan.outbound.sentVia === 'auto' ? 'auto reply sent' : 'approved reply sent',
    );
  }
  if (plan.sourceMessageId && plan.outbound.sentVia === 'auto') {
    await tx`update public.message_processing set status = 'auto_sent' where message_id = ${plan.sourceMessageId}`;
  }
  await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
           values (${tenantId}, 'system', 'email.sent', 'draft', ${plan.draft.id},
                   ${tx.json({ sentVia: plan.outbound.sentVia, outboundId: plan.outbound.id })})`;
}

/** Permanent failure: the draft is marked send_failed and the owner is told by email. */
async function finalizeFailed(
  tx: TransactionSql,
  tenantId: string,
  draftId: string,
  outboundId: string | null,
  code: string,
  detail?: string,
): Promise<void> {
  if (outboundId) {
    await tx`update public.outbound_emails set status = 'failed', error = ${detail ? `${code}: ${detail}` : code}
             where id = ${outboundId}`;
  }
  const [d] = await tx<{ subject: string; to_address: string; kind: DraftKind }[]>`
    update public.drafts set status = 'send_failed' where id = ${draftId} and status <> 'sent'
    returning subject, to_address, kind`;
  if (!d) return;
  await tx`insert into public.audit_log (tenant_id, actor, action, target_type, target_id, metadata)
           values (${tenantId}, 'system', 'email.send_failed', 'draft', ${draftId}, ${tx.json({ code })})`;
  // A failed acknowledgement needs no alert: the owner already has the escalation.
  if (d.kind === 'acknowledgement') return;
  const payload = {
    draftId,
    code,
    recipientDomain: hostOf(d.to_address) || 'unknown',
    subject: headerText(d.subject, 200),
  };
  await tx`
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    values (${tenantId}, 'email_owner', 'send_failed', ${`send_failed:${draftId}`}, ${tx.json(payload)})
    on conflict (tenant_id, dedupe_key) do nothing`;
}

/**
 * An auto-send that may no longer go out automatically (caps reached or the
 * owner switched to draft-only meanwhile) waits for approval instead.
 */
async function downgradeToApproval(
  tx: TransactionSql,
  tenantId: string,
  draftId: string,
  sourceMessageId: string | null,
  reasons: string[],
): Promise<void> {
  await tx`update public.drafts set status = 'pending_approval', decided_by = null, decided_at = null where id = ${draftId}`;
  const [src] = sourceMessageId
    ? await tx<
        {
          from_address: string;
          from_name: string | null;
          subject: string | null;
          summary: string | null;
          notify_full_text: boolean;
          body: string | null;
        }[]
      >`
        select m.from_address, m.from_name, m.subject, mp.classification->>'summary' as summary,
               t.notify_full_text, d.body
        from public.messages m
        join public.tenants t on t.id = m.tenant_id
        join public.drafts d on d.id = ${draftId}
        left join public.message_processing mp on mp.message_id = m.id
        where m.id = ${sourceMessageId}`
    : [];
  const payload = {
    ...ownerNotificationPayload({
      fullText: src?.notify_full_text ?? false,
      kind: 'draft_ready',
      senderAddress: src?.from_address ?? '',
      senderName: src?.from_name ?? null,
      subject: src?.subject ?? null,
      summary: src?.summary ?? '',
      action: 'draft',
      reasons,
      draftText: src?.body ?? null,
      unverifiedSuggestion: false,
    }),
    draftId,
    ...(sourceMessageId ? { messageId: sourceMessageId } : {}),
  };
  await tx`
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    values (${tenantId}, 'email_owner', 'draft_ready', ${`draft:${draftId}`}, ${tx.json(payload as never)})
    on conflict (tenant_id, dedupe_key) do nothing`;
}
