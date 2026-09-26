import {
  buildReplySubject,
  ownerNotificationPayload,
  resolveReplyRecipient,
  type Logger,
} from '@noctiv/core';
import { enqueue, withTenant } from '@noctiv/db';
import { documentReminder, loadDocument } from '@noctiv/documents';
import type { Sql } from 'postgres';
import { QUEUES } from '../queues.ts';

/**
 * Hourly (PLAN.md §22.10): one reminder to the customer 3 days after an
 * unpaid, sent invoice's due date. It follows the tenant's mode like any
 * reply: mode 1 waits for approval, modes 2 and 3 send it (with the usual
 * send-time checks). The invoice PDF is attached again. Never a second one.
 */
export async function queuePaymentReminders(sql: Sql, logger?: Logger): Promise<number> {
  const due = await sql<{ tenant_id: string; document_id: string }[]>`
    select tenant_id, document_id from app.due_payment_reminders(50)`;
  let queued = 0;
  for (const r of due) {
    try {
      const ok = await withTenant(sql, r.tenant_id, async (tx) => {
        const [lock] = await tx<{ id: string }[]>`
          select id from public.documents
          where id = ${r.document_id} and payable and status = 'sent' and reminder_queued_at is null
          for update`;
        if (!lock) return false;
        const d = (await loadDocument(tx, { id: r.document_id }))!;
        const [m] = await tx<
          {
            id: string;
            from_address: string;
            from_name: string | null;
            reply_to: string | null;
            subject: string | null;
          }[]
        >`select id, from_address, from_name, reply_to, subject from public.messages
          where thread_id = ${d.threadId} and direction = 'inbound'
          order by received_at desc limit 1`;
        const [t] = await tx<{ mode: string; notify_full_text: boolean }[]>`
          select mode, notify_full_text from public.tenants`;
        // Nothing to reply to: remember it so the check does not repeat every hour.
        if (!m) {
          await tx`update public.documents set reminder_queued_at = now() where id = ${d.id}`;
          return false;
        }
        const to = resolveReplyRecipient({
          from: m.from_address,
          replyTo: m.reply_to ? [m.reply_to] : [],
        }).to;
        const body = documentReminder(d, m.from_name);
        const auto = t!.mode !== 'draft_only';
        const [draft] = await tx<{ id: string }[]>`
          insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body,
                                     status, decided_by, decided_at)
          values (${r.tenant_id}, ${d.threadId}, ${m.id}, 'payment_reminder', ${to}, ${buildReplySubject(m.subject)},
                  ${body}, ${auto ? 'approved' : 'pending_approval'}, ${auto ? 'auto' : null}, ${auto ? new Date() : null})
          returning id`;
        await tx`update public.documents set reminder_draft_id = ${draft!.id}, reminder_queued_at = now()
                 where id = ${d.id}`;
        if (auto) {
          await enqueue(tx, {
            tenantId: r.tenant_id,
            queue: QUEUES.mailSend,
            payload: { draftId: draft!.id, sentVia: 'auto' },
            singletonKey: draft!.id,
          });
        } else {
          const payload = {
            ...ownerNotificationPayload({
              fullText: t!.notify_full_text,
              kind: 'draft_ready',
              senderAddress: m.from_address,
              senderName: m.from_name,
              subject: m.subject,
              summary: `Payment reminder for ${d.number}, due ${d.dueDate}.`,
              action: 'draft',
              reasons: ['tenant_draft_only'],
              draftText: body,
              unverifiedSuggestion: false,
            }),
            draftId: draft!.id,
            documentId: d.id,
          };
          await tx`
            insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
            values (${r.tenant_id}, 'email_owner', 'draft_ready', ${`draft:${draft!.id}`}, ${tx.json(payload as never)})
            on conflict (tenant_id, dedupe_key) do nothing`;
        }
        return true;
      });
      if (ok) queued++;
    } catch (e) {
      logger?.warn(
        { tenantId: r.tenant_id, err: e instanceof Error ? e.message : 'error' },
        'payment reminder failed',
      );
    }
  }
  return queued;
}
