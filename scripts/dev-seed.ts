/**
 * Demo data for the local stack (never used in production). Idempotent: an
 * existing demo business is left as it is.
 */
import type { Sql } from 'postgres';
import { sealMailboxPassword } from '../packages/mail/src/credentials.ts';

export const DEV = {
  userId: 'd0e10000-0000-4000-8000-000000000001',
  ownerEmail: 'owner@noctiv.local',
  mailbox: 'shop@demo.test',
  mailboxPassword: 'demo-app-password',
  /** GreenMail host ports (docker/compose.dev.yml); movable when taken. */
  smtpPort: Number(process.env.GREENMAIL_SMTP_PORT ?? 3025),
  imapPort: Number(process.env.GREENMAIL_IMAP_PORT ?? 3143),
};

const KB_NOTES = [
  {
    title: 'Prices',
    text: 'One scented candle costs 24 EUR. A gift set of three candles costs 65 EUR. Wholesale prices are agreed individually with the owner.',
  },
  {
    title: 'Shipping',
    text: 'Delivery within Latvia takes 2-3 business days and costs 4 EUR. Delivery to Estonia and Lithuania takes 3-5 business days and costs 7 EUR. Orders over 60 EUR ship free within the Baltics.',
  },
  {
    title: 'Returns',
    text: 'Unused candles can be returned within 14 days. Damaged deliveries are replaced after the customer sends a photo.',
  },
];

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

export async function seedDemo(sql: Sql, opts: { publicKey: string; withBusiness: boolean }) {
  await sql`insert into auth.users (id, email, aud, role)
            values (${DEV.userId}, ${DEV.ownerEmail}, 'authenticated', 'authenticated')
            on conflict (id) do nothing`;
  if (!opts.withBusiness) return;
  const [existing] =
    await sql`select tenant_id from public.tenant_members where user_id = ${DEV.userId}`;
  if (existing) return;

  await sql.begin(async (tx) => {
    const [t] = await tx<{ id: string }[]>`
      insert into public.tenants (name, website_url, timezone, reply_signature, onboarding_completed_at)
      values ('Nordlicht Candles', 'https://nordlicht.example', 'Europe/Riga', 'Liga — Nordlicht Candles', now())
      returning id`;
    const tenantId = t!.id;
    await tx`insert into public.tenant_members (tenant_id, user_id) values (${tenantId}, ${DEV.userId})`;

    const [c] = await tx<{ id: string }[]>`select gen_random_uuid() as id`;
    const connectionId = c!.id;
    const sealed = sealMailboxPassword(DEV.mailboxPassword, opts.publicKey, tenantId, connectionId);
    await tx`insert into public.email_connections
               (id, tenant_id, provider, email_address, display_name, imap_host, imap_port, imap_secure, smtp_host, smtp_port,
                smtp_security, username, credentials_ciphertext, credentials_key_id, status, is_test_mailbox,
                sent_append_mode, last_ok_at, last_checked_at)
             values (${connectionId}, ${tenantId}, 'generic', ${DEV.mailbox}, 'Nordlicht Candles', 'localhost', ${DEV.imapPort}, false,
                     'localhost', ${DEV.smtpPort}, 'starttls', ${DEV.mailbox}, ${sealed.ciphertext}, ${sealed.keyId}, 'connected', true,
                     'none', now(), now())`;

    for (const n of KB_NOTES) {
      const [s] = await tx<{ id: string }[]>`
        insert into public.kb_sources (tenant_id, type, title, note_text, status)
        values (${tenantId}, 'note', ${n.title}, ${n.text}, 'pending') returning id`;
      await tx`insert into public.jobs (tenant_id, queue, payload, singleton_key)
               values (${tenantId}, 'kb.ingest', ${tx.json({ sourceId: s!.id })}, ${s!.id})`;
    }

    let seq = 0;
    const conversation = async (c: {
      email: string;
      name: string;
      stage: string;
      subject: string;
      body: string;
      at: Date;
      threadStatus: string;
      processing: {
        status: string;
        action: string | null;
        reasons: string[];
        summary: string;
        skip?: string;
      };
      noLead?: boolean;
    }) => {
      seq++;
      const [lead] = c.noLead
        ? [{ id: null }]
        : await tx<{ id: string }[]>`
            insert into public.leads (tenant_id, email, name, stage, first_seen_at, last_activity_at)
            values (${tenantId}, ${c.email}, ${c.name}, ${c.stage}, ${c.at}, ${c.at}) returning id`;
      const [th] = await tx<{ id: string }[]>`
        insert into public.threads (tenant_id, connection_id, lead_id, subject, status, last_inbound_at)
        values (${tenantId}, ${connectionId}, ${lead!.id}, ${c.subject}, ${c.threadStatus}, ${c.at}) returning id`;
      const [m] = await tx<{ id: string }[]>`
        insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, from_address, from_name,
                                     to_addresses, subject, body_text, received_at)
        values (${tenantId}, ${connectionId}, ${th!.id}, 'inbound', ${`<demo-${seq}-${tenantId.slice(0, 8)}@example-mail.test>`},
                ${c.email}, ${c.name}, ${[DEV.mailbox]}, ${c.subject}, ${c.body}, ${c.at})
        returning id`;
      await tx`insert into public.message_processing (tenant_id, message_id, status, final_action, downgrade_reasons, skip_reason,
                                                      classification, confidence, created_at)
               values (${tenantId}, ${m!.id}, ${c.processing.status}, ${c.processing.action}, ${c.processing.reasons},
                       ${c.processing.skip ?? null},
                       ${tx.json({ category: 'product_question', sentiment: 'neutral', urgency: 'normal', language: 'en', summary: c.processing.summary })},
                       0.9, ${c.at})`;
      return { threadId: th!.id, messageId: m!.id };
    };

    // 1. A draft waiting for approval.
    const anna = await conversation({
      email: 'anna.berzina@example-mail.test',
      name: 'Anna Bērziņa',
      stage: 'drafted',
      subject: 'Gift set for my mother',
      body: 'Hello! Do you have a gift set with three candles, and could it arrive in Riga before Friday?\n\nThanks, Anna',
      at: hoursAgo(1),
      threadStatus: 'open',
      processing: {
        status: 'drafted',
        action: 'draft',
        reasons: ['tenant_draft_only'],
        summary: 'Asks about a gift set of three candles and delivery to Riga before Friday.',
      },
    });
    await tx`insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, status)
             values (${tenantId}, ${anna.threadId}, ${anna.messageId}, 'reply', 'anna.berzina@example-mail.test', 'Re: Gift set for my mother',
                     ${'Hello Anna,\n\nYes — our gift set of three candles costs 65 EUR. Delivery within Latvia takes 2-3 business days, so if you order today it should arrive before Friday.\n\nWould you like me to reserve one for you?'},
                     'pending_approval')`;

    // 2. A refund request: always handed to the owner, no draft.
    const jonas = await conversation({
      email: 'jonas.keller@example-mail.test',
      name: 'Jonas Keller',
      stage: 'escalated',
      subject: 'Candle arrived broken',
      body: 'My candle arrived broken. This is really annoying — I want my money back!',
      at: hoursAgo(3),
      threadStatus: 'escalated',
      processing: {
        status: 'escalated',
        action: 'escalate',
        reasons: ['hard_list:refund', 'hard_list:angry'],
        summary: 'Candle arrived broken; the customer is upset and wants a refund.',
      },
    });
    await tx`insert into public.escalations (tenant_id, message_id, thread_id, category, reason, summary)
             values (${tenantId}, ${jonas.messageId}, ${jonas.threadId}, 'hard_list', 'hard_list:refund, hard_list:angry',
                     'Candle arrived broken; the customer is upset and wants a refund.')`;

    // 3. Answered; waiting for the customer (follow-up scheduled).
    const maris = await conversation({
      email: 'maris@example-mail.test',
      name: 'Māris Ozols',
      stage: 'sent',
      subject: 'Delivery to Tallinn',
      body: 'How long does delivery to Tallinn take?',
      at: hoursAgo(26),
      threadStatus: 'awaiting_customer',
      processing: {
        status: 'auto_sent',
        action: 'auto_send',
        reasons: [],
        summary: 'Asks how long delivery to Tallinn takes.',
      },
    });
    await tx`insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, from_address,
                                          to_addresses, subject, body_text, received_at)
             values (${tenantId}, ${connectionId}, ${maris.threadId}, 'outbound', ${`<demo-out-${tenantId.slice(0, 8)}@demo.test>`},
                     ${DEV.mailbox}, ${['maris@example-mail.test']}, 'Re: Delivery to Tallinn',
                     ${'Hello Māris,\n\nDelivery to Estonia takes 3-5 business days and costs 7 EUR.\n\nLiga — Nordlicht Candles'}, ${hoursAgo(25)})`;
    await tx`update public.threads set last_outbound_at = ${hoursAgo(25)}, next_followup_at = now() + interval '2 days'
             where id = ${maris.threadId}`;

    // 4. Unsure answer: escalation with an unverified suggestion.
    const liga = await conversation({
      email: 'purchasing@hotel-example.test',
      name: 'Hotel Rīga Purchasing',
      stage: 'escalated',
      subject: 'Wholesale for 40 rooms',
      body: 'We are a hotel and would like 120 candles every month. What would your wholesale price be?',
      at: hoursAgo(5),
      threadStatus: 'escalated',
      processing: {
        status: 'escalated',
        action: 'escalate',
        reasons: ['claim_without_sources'],
        summary: 'A hotel asks for a monthly wholesale price for 120 candles.',
      },
    });
    const [sugg] = await tx<{ id: string }[]>`
      insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, status)
      values (${tenantId}, ${liga.threadId}, ${liga.messageId}, 'reply', 'purchasing@hotel-example.test', 'Re: Wholesale for 40 rooms',
              ${'Hello,\n\nThank you for your interest! Wholesale prices are agreed individually. Could you tell us which scents you prefer and your delivery address? We will send you an offer.'},
              'suggestion') returning id`;
    await tx`insert into public.escalations (tenant_id, message_id, thread_id, category, reason, summary, suggestion_draft_id)
             values (${tenantId}, ${liga.messageId}, ${liga.threadId}, 'uncertain', 'claim_without_sources',
                     'A hotel asks for a monthly wholesale price for 120 candles.', ${sugg!.id})`;

    // 5. A newsletter that was ignored.
    await conversation({
      email: 'news@supplier-example.test',
      name: 'Wax Supplier News',
      stage: 'received',
      subject: 'Our autumn catalogue',
      body: 'See our new autumn catalogue. Unsubscribe any time.',
      at: hoursAgo(2),
      threadStatus: 'open',
      processing: {
        status: 'skipped',
        action: 'skip',
        reasons: [],
        summary: 'Supplier newsletter.',
        skip: 'loop_header:list',
      },
      noLead: true,
    });

    await tx`insert into public.usage_daily (tenant_id, day, llm_calls, tokens_in, tokens_out, embed_tokens, est_cost_micro_eur)
             values (${tenantId}, (now() at time zone 'utc')::date, 9, 21000, 4200, 900, 6100)`;
  });
}
