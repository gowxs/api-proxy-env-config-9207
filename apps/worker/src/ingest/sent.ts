import type { InboundMessage } from '@noctiv/mail';
import type { TransactionSql } from 'postgres';

export const OWNER_REPLIED = 'owner_replied';

/**
 * Stores one message from the owner's Sent folder, but only when it belongs
 * to a conversation Noctiv already has (it references a stored message, or
 * one of ours). Everything else is dropped without a trace: not even its
 * Message-ID is kept. Noctiv's own sent copies are recognised by Message-ID
 * and skipped. An owner reply stops pending follow-ups on the thread.
 */
export async function storeSent(
  tx: TransactionSql,
  args: {
    tenantId: string;
    connectionId: string;
    ownAddress: string;
    uid: number;
    msg: InboundMessage;
    tooLarge?: boolean;
  },
): Promise<'stored' | 'duplicate' | 'unrelated'> {
  const { msg } = args;
  const [known] = await tx`
    select 1 from public.messages where connection_id = ${args.connectionId} and message_id_header = ${msg.messageId}
    union all
    select 1 from public.outbound_emails where message_id_header = ${msg.messageId}
    limit 1`;
  if (known) return 'duplicate';

  const refs = [msg.inReplyTo, ...msg.references].filter((x): x is string => Boolean(x));
  if (refs.length === 0) return 'unrelated';
  const [hit] = await tx<{ thread_id: string }[]>`
    select thread_id from public.messages
    where connection_id = ${args.connectionId} and message_id_header = any(${refs}) and thread_id is not null
    union all
    select thread_id from public.outbound_emails where message_id_header = any(${refs})
    limit 1`;
  if (!hit) return 'unrelated';

  const [inserted] = await tx<{ id: string }[]>`
    insert into public.messages
      (tenant_id, connection_id, thread_id, direction, message_id_header, in_reply_to, reference_ids, from_address,
       to_addresses, cc_addresses, subject, body_text, attachment_meta, imap_uid, received_at, seen, mailbox_folder, sent_by)
    values (${args.tenantId}, ${args.connectionId}, ${hit.thread_id}, 'outbound', ${msg.messageId}, ${msg.inReplyTo},
            ${msg.references}, ${args.ownAddress}, ${msg.to}, ${msg.cc}, ${msg.subject},
            ${args.tooLarge ? null : msg.text}, ${tx.json(msg.attachments as never)}, ${args.uid}, ${msg.date},
            true, 'sent', 'owner')
    on conflict (connection_id, message_id_header) do nothing
    returning id`;
  if (!inserted) return 'duplicate';

  await tx`
    update public.threads
    set last_outbound_at = greatest(coalesce(last_outbound_at, ${msg.date}), ${msg.date}),
        followup_stop_reason = case when next_followup_at is not null then ${OWNER_REPLIED} else followup_stop_reason end,
        next_followup_at = null
    where id = ${hit.thread_id}`;
  await settleThread(tx, hit.thread_id, msg.date);
  return 'stored';
}

/**
 * The owner answered this conversation themselves: what was waiting for them
 * is done. Only things that existed when they wrote (up to the reply's own
 * date) are settled, so a customer message that arrived after the reply, and
 * any escalation it raised while the Sent mail was still unsynced, stay open.
 * A later customer message goes through the usual rules, hard list included.
 */
async function settleThread(tx: TransactionSql, threadId: string, repliedAt: Date): Promise<void> {
  // Escalations raised by messages the owner has now answered.
  await tx`
    update public.escalations e set resolved_at = now(), resolved_by = ${OWNER_REPLIED}
    from public.messages m
    where m.id = e.message_id and e.thread_id = ${threadId} and e.resolved_at is null
      and m.received_at <= ${repliedAt}`;
  // Drafts and suggestions waiting for the owner about those messages are moot.
  await tx`
    update public.drafts set status = 'superseded'
    where thread_id = ${threadId} and kind in ('reply', 'followup')
      and status in ('pending_approval', 'suggestion') and created_at <= ${repliedAt}`;
  // Answered: waiting for the customer. Unless a newer customer message or a still-open
  // escalation says the conversation needs attention again.
  await tx`
    update public.threads th set status = 'awaiting_customer'
    where th.id = ${threadId} and th.status in ('open', 'escalated', 'customer_replied')
      and not exists (select 1 from public.escalations e where e.thread_id = th.id and e.resolved_at is null)
      and not exists (select 1 from public.messages m
                      where m.thread_id = th.id and m.direction = 'inbound' and m.received_at > ${repliedAt})`;
}
