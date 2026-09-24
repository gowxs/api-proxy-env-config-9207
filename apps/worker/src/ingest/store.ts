import { enqueue } from '@noctiv/db';
import type { InboundMessage } from '@noctiv/mail';
import type { TransactionSql } from 'postgres';
import { QUEUES } from '../queues.ts';

/**
 * Saves one inbound message and schedules its processing, atomically.
 * The UNIQUE (connection_id, message_id_header) constraint makes this safe
 * to repeat: a message already stored is ignored and never processed twice.
 * Returns the new message id, or null for a duplicate.
 */
export async function storeInbound(
  tx: TransactionSql,
  args: {
    tenantId: string;
    connectionId: string;
    uid: number;
    msg: InboundMessage;
    tooLarge?: boolean;
  },
): Promise<string | null> {
  const { msg } = args;
  const refs = [msg.inReplyTo, ...msg.references].filter((x): x is string => Boolean(x));

  // Thread: the conversation any referenced message (ours or theirs) belongs to.
  let threadId: string | null = null;
  if (refs.length) {
    const [hit] = await tx<{ thread_id: string }[]>`
      select thread_id from public.messages
      where connection_id = ${args.connectionId} and message_id_header = any(${refs}) and thread_id is not null
      union all
      select thread_id from public.outbound_emails where message_id_header = any(${refs})
      limit 1`;
    threadId = hit?.thread_id ?? null;
  }

  const [inserted] = await tx<{ id: string }[]>`
    insert into public.messages
      (tenant_id, connection_id, direction, message_id_header, in_reply_to, reference_ids, from_address, from_name,
       reply_to, to_addresses, cc_addresses, subject, body_text, loop_headers, attachment_meta, imap_uid, received_at,
       html_hidden_text)
    values (${args.tenantId}, ${args.connectionId}, 'inbound', ${msg.messageId}, ${msg.inReplyTo}, ${msg.references},
            ${msg.from.address}, ${msg.from.name}, ${msg.replyTo[0] ?? null}, ${msg.to}, ${msg.cc}, ${msg.subject},
            ${args.tooLarge ? null : msg.text}, ${tx.json(msg.loopHeaders as never)}, ${tx.json(msg.attachments as never)},
            ${args.uid}, ${msg.date}, ${msg.htmlHiddenText})
    on conflict (connection_id, message_id_header) do nothing
    returning id`;
  if (!inserted) return null;

  if (!threadId) {
    const [t] = await tx<{ id: string }[]>`
      insert into public.threads (tenant_id, connection_id, subject, root_message_id_header, status, last_inbound_at)
      values (${args.tenantId}, ${args.connectionId}, ${msg.subject}, ${refs[0] ?? msg.messageId}, 'open', ${msg.date})
      returning id`;
    threadId = t!.id;
  } else {
    await tx`update public.threads set last_inbound_at = greatest(coalesce(last_inbound_at, ${msg.date}), ${msg.date}) where id = ${threadId}`;
  }
  await tx`update public.messages set thread_id = ${threadId} where id = ${inserted.id}`;
  await tx`insert into public.message_processing (tenant_id, message_id, status) values (${args.tenantId}, ${inserted.id}, 'queued')`;
  await enqueue(tx, {
    tenantId: args.tenantId,
    queue: QUEUES.mailProcess,
    payload: { messageId: inserted.id },
    singletonKey: inserted.id,
  });
  return inserted.id;
}
