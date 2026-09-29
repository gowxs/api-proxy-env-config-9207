/**
 * A clean, fictional demo business for the product video: "Nordlicht Candles",
 * owner Anna Berg. Example customers and addresses only. LOCAL DEV STACK ONLY:
 * it talks to the dev Postgres on localhost and the dev API, replaces every
 * business in that database, and refuses to run against anything else.
 *
 *   DEV_OWNER_EMAIL=anna.berg@nordlicht-candles.example \
 *   DEV_MAILBOX=hello@nordlicht-candles.example \
 *     node scripts/dev-stack.ts --empty        # terminal 1
 *   node demo/seed.ts                          # terminal 2 (repo root)
 *
 * What it creates: mode 2, 8 leads across stages, one draft waiting for approval,
 * one open escalation, sent replies and follow-ups, two quotes (one sent, one
 * accepted), a paid invoice with its delivery note and a CMR (through the real
 * API), 3 knowledge-base notes, and a 5-item price list.
 */
/* eslint-disable no-console -- progress output */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { sealMailboxPassword } from '../packages/mail/src/credentials.ts';

const OWNER_URL = 'postgres://postgres:postgres@localhost:54322/postgres';
const API = process.env.API_URL ?? 'http://localhost:4000';
const USER_ID = 'd0e10000-0000-4000-8000-000000000001';
const OWNER_EMAIL = process.env.DEV_OWNER_EMAIL ?? 'anna.berg@nordlicht-candles.example';
const MAILBOX = process.env.DEV_MAILBOX ?? 'hello@nordlicht-candles.example';
const MAILBOX_PASSWORD = 'demo-app-password';
const SMTP_PORT = Number(process.env.GREENMAIL_SMTP_PORT ?? 3025);
const IMAP_PORT = Number(process.env.GREENMAIL_IMAP_PORT ?? 3143);
const DOMAIN = MAILBOX.split('@')[1]!;

if (!/\.example$/.test(OWNER_EMAIL) || !/\.example$/.test(MAILBOX))
  throw new Error('Use fictional addresses ending in .example for the demo business.');

const sql = postgres(OWNER_URL, { max: 1, onnotice: () => {} });
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const msgId = () => `<${randomUUID()}@${DOMAIN}>`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tx = any;

async function main() {
  const [db] = await sql<{ n: number }[]>`select count(*)::int as n from auth.users`;
  console.log(`dev database reachable (${db!.n} user)`);

  // Replace every business (cascades) and give the owner a name.
  await sql`delete from public.tenants`;
  await sql`update auth.users set email = ${OWNER_EMAIL},
            raw_user_meta_data = ${sql.json({ full_name: 'Anna Berg' })} where id = ${USER_ID}`;

  const publicKey = readFileSync(
    join(import.meta.dirname, '..', 'secrets', 'dev-sealing-public.key'),
    'utf8',
  ).trim();

  const ids = await sql.begin(async (tx: Tx) => {
    const [t] = await tx`
      insert into public.tenants (name, website_url, timezone, reply_signature, onboarding_completed_at)
      values ('Nordlicht Candles', 'https://nordlicht-candles.example', 'Europe/Riga',
              ${'Anna Berg\nNordlicht Candles'}, now())
      returning id`;
    const tenantId: string = t.id;
    await tx`update public.tenants set
               mode = 'auto_send', quotes_enabled = true, documents_enabled = true,
               brand_color = '#B4532A', brand_website = 'https://nordlicht-candles.example',
               seller_legal_name = 'Nordlicht Candles SIA',
               seller_legal_address = ${'Tērbatas iela 5, Rīga, LV-1011'},
               seller_reg_no = '40003000000', seller_vat_no = 'LV40003000000',
               seller_bank_name = 'Example Bank', seller_iban = 'LV80BANK0000435195001',
               seller_bic = 'EXBKLV22', seller_country = 'LV'
             where id = ${tenantId}`;
    await tx`insert into public.tenant_members (tenant_id, user_id) values (${tenantId}, ${USER_ID})`;

    // The mailbox (GreenMail accepts any login in the dev stack).
    const [c] = await tx`select gen_random_uuid() as id`;
    const connectionId: string = c.id;
    const sealed = sealMailboxPassword(MAILBOX_PASSWORD, publicKey, tenantId, connectionId);
    await tx`insert into public.email_connections
               (id, tenant_id, provider, email_address, display_name, imap_host, imap_port, imap_secure,
                smtp_host, smtp_port, smtp_security, username, credentials_ciphertext, credentials_key_id,
                status, is_test_mailbox, sent_append_mode, last_ok_at, last_checked_at)
             values (${connectionId}, ${tenantId}, 'generic', ${MAILBOX}, 'Nordlicht Candles', 'localhost',
                     ${IMAP_PORT}, false, 'localhost', ${SMTP_PORT}, 'starttls', ${MAILBOX},
                     ${sealed.ciphertext}, ${sealed.keyId}, 'connected', true, 'none', now(), now())`;

    // Knowledge base: three notes (ingested by the worker).
    const notes = [
      [
        'Prices',
        'A lavender soy candle costs 24 EUR. Wedding favour candles (minimum 20) cost 6.50 EUR each. A gift set of three candles costs 65 EUR. A candle care kit costs 12 EUR. Wholesale prices are agreed individually with the owner.',
      ],
      [
        'Shipping',
        'Delivery within Latvia takes 2-3 business days and costs 4 EUR. Delivery to Estonia and Lithuania takes 3-5 business days and costs 7 EUR. Orders over 60 EUR ship free within the Baltics.',
      ],
      [
        'Returns',
        'Unused candles can be returned within 14 days. Damaged deliveries are replaced after the customer sends a photo. Refunds are decided by the owner.',
      ],
    ] as const;
    for (const [title, text] of notes) {
      const [s] = await tx`insert into public.kb_sources (tenant_id, type, title, note_text, status)
                           values (${tenantId}, 'note', ${title}, ${text}, 'pending') returning id`;
      await tx`insert into public.jobs (tenant_id, queue, payload, singleton_key)
               values (${tenantId}, 'kb.ingest', ${tx.json({ sourceId: s.id })}, ${s.id})`;
    }

    // Price list: five confirmed items.
    const price: Record<string, string> = {};
    const items: [string, string, string, number][] = [
      ['candle', 'Lavender soy candle', 'pcs', 2400],
      ['favour', 'Wedding favour candle', 'pcs', 650],
      ['gift', 'Gift set of three candles', 'set', 6500],
      ['care', 'Candle care kit', 'pcs', 1200],
      ['delivery', 'Delivery within Latvia', 'pcs', 400],
    ];
    for (const [key, name, unit, cents] of items) {
      const [p] =
        await tx`insert into public.price_items (tenant_id, name, unit, unit_price_cents, status, source)
                           values (${tenantId}, ${name}, ${unit}, ${cents}, 'confirmed', 'manual') returning id`;
      price[key] = p.id;
    }

    // Conversations.
    const conversation = async (c: {
      name: string;
      email: string;
      stage: string;
      threadStatus: string;
      subject: string;
      body: string;
      summary: string;
      minutesAgo: number;
      processing: [string, string | null];
    }) => {
      const at = ago(c.minutesAgo);
      const [lead] =
        await tx`insert into public.leads (tenant_id, email, name, stage, first_seen_at, last_activity_at, stage_changed_at)
                              values (${tenantId}, ${c.email}, ${c.name}, ${c.stage}, ${at}, ${at}, ${at}) returning id`;
      const [th] =
        await tx`insert into public.threads (tenant_id, connection_id, lead_id, subject, status, last_inbound_at)
                            values (${tenantId}, ${connectionId}, ${lead.id}, ${c.subject}, ${c.threadStatus}, ${at}) returning id`;
      const [m] =
        await tx`insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header,
                                                        from_address, from_name, to_addresses, subject, body_text, received_at)
                           values (${tenantId}, ${connectionId}, ${th.id}, 'inbound', ${msgId()}, ${c.email}, ${c.name},
                                   ${[MAILBOX]}, ${c.subject}, ${c.body}, ${at}) returning id`;
      await tx`insert into public.message_processing (tenant_id, message_id, status, final_action, downgrade_reasons, classification, confidence, created_at)
               values (${tenantId}, ${m.id}, ${c.processing[0]}, ${c.processing[1]}, ${[]},
                       ${tx.json({ category: 'product_question', sentiment: 'neutral', urgency: 'normal', language: 'en', summary: c.summary })},
                       0.92, ${at})`;
      return {
        leadId: lead.id as string,
        threadId: th.id as string,
        messageId: m.id as string,
        email: c.email,
        subject: c.subject,
        minutesAgo: c.minutesAgo,
      };
    };

    /** A sent e-mail from the business: draft, outbound record and the message in the thread. */
    const sent = async (
      cv: { leadId: string; threadId: string; messageId: string; email: string; subject: string },
      o: {
        kind: 'reply' | 'followup' | 'quote';
        body: string;
        minutesAgo: number;
        via: 'auto' | 'owner_approval';
        subject?: string;
        after?: string;
      },
    ) => {
      const at = ago(o.minutesAgo);
      const subject = o.subject ?? `Re: ${cv.subject}`;
      const [d] =
        await tx`insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, status, decided_by, decided_at)
                           values (${tenantId}, ${cv.threadId}, ${cv.messageId}, ${o.kind}, ${cv.email}, ${subject}, ${o.body},
                                   'sent', ${o.via === 'auto' ? 'system' : 'owner'}, ${at}) returning id`;
      const header = msgId();
      await tx`insert into public.outbound_emails (tenant_id, draft_id, thread_id, message_id_header, to_address, subject, sent_via, status, attempts, sent_at)
               values (${tenantId}, ${d.id}, ${cv.threadId}, ${header}, ${cv.email}, ${subject}, ${o.via}, 'sent', 1, ${at})`;
      await tx`insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, from_address, from_name,
                                            to_addresses, subject, body_text, received_at)
               values (${tenantId}, ${connectionId}, ${cv.threadId}, 'outbound', ${header}, ${MAILBOX}, 'Nordlicht Candles',
                       ${[cv.email]}, ${subject}, ${o.body}, ${at})`;
      await tx`update public.threads set last_outbound_at = ${at} where id = ${cv.threadId}`;
      return d.id as string;
    };

    // 1. The draft waiting for approval, grounded in the notes.
    const marta = await conversation({
      name: 'Marta Ozola',
      email: 'marta.ozola@example.com',
      stage: 'drafted',
      threadStatus: 'open',
      subject: 'Wedding favours for 40 guests',
      minutesAgo: 55,
      processing: ['drafted', 'draft'],
      body: 'Hello! We are getting married on 20 June and would like 40 small candles as guest favours. Do you make those, and what would it cost?\n\nThanks, Marta',
      summary: 'Asks for 40 wedding favour candles for 20 June and the price.',
    });
    await tx`insert into public.drafts (tenant_id, thread_id, source_message_id, kind, to_address, subject, body, status)
             values (${tenantId}, ${marta.threadId}, ${marta.messageId}, 'reply', ${marta.email}, ${'Re: ' + marta.subject},
                     ${'Hi Marta,\n\nCongratulations! Yes, we make wedding favour candles. They cost 6.50 EUR each, so 40 come to 260 EUR. Delivery within Latvia takes 2-3 business days and is free for orders over 60 EUR.\n\nShall I send you a quote you can accept online?'},
                     'pending_approval')`;

    // 2. Answered automatically (mode 2), in under a minute.
    const lena = await conversation({
      name: 'Lena Kruse',
      email: 'lena.kruse@example.com',
      stage: 'sent',
      threadStatus: 'awaiting_customer',
      subject: 'Do you ship to Tallinn?',
      minutesAgo: 190,
      processing: ['auto_sent', 'auto_send'],
      body: 'Hi! Do you ship to Tallinn, and how long does it take?',
      summary:
        'Asks whether Noctivless shipping to Tallinn is possible and how long it takes.'.replace(
          'Noctivless ',
          '',
        ),
    });
    await sent(lena, {
      kind: 'reply',
      via: 'auto',
      minutesAgo: 189,
      body: 'Hi Lena,\n\nYes, we ship to Estonia. Delivery takes 3-5 business days and costs 7 EUR; orders over 60 EUR ship free within the Baltics.\n\nAnna Berg\nNordlicht Candles',
    });

    // 3. Approved by the owner, then a follow-up went out.
    const tomas = await conversation({
      name: 'Tomas Vaitkus',
      email: 'tomas.vaitkus@example.com',
      stage: 'followed_up',
      threadStatus: 'awaiting_customer',
      subject: 'Gift set delivery to Kaunas',
      minutesAgo: 1620,
      processing: ['drafted', 'draft'],
      body: 'Hello, how much is the gift set of three candles and can you deliver to Kaunas?',
      summary: 'Asks for the gift set price and delivery to Kaunas.',
    });
    await sent(tomas, {
      kind: 'reply',
      via: 'owner_approval',
      minutesAgo: 1613,
      body: 'Hi Tomas,\n\nThe gift set of three candles costs 65 EUR. Delivery to Lithuania takes 3-5 business days and is free for orders over 60 EUR.\n\nAnna Berg\nNordlicht Candles',
    });
    await sent(tomas, {
      kind: 'followup',
      via: 'auto',
      minutesAgo: 240,
      subject: 'Re: Gift set delivery to Kaunas',
      body: 'Hi Tomas, just checking whether you had any more questions about the gift set. Happy to help.\n\nAnna Berg\nNordlicht Candles',
    });
    await tx`update public.threads set followups_sent = 1, next_followup_at = ${new Date(Date.now() + 2 * 86_400_000)} where id = ${tomas.threadId}`;

    // 4. A follow-up won a customer back: she answered after it.
    const elise = await conversation({
      name: 'Elise Moreau',
      email: 'elise.moreau@example.com',
      stage: 'replied',
      threadStatus: 'customer_replied',
      subject: 'Is the lavender candle in stock?',
      minutesAgo: 1800,
      processing: ['auto_sent', 'auto_send'],
      body: 'Hi, is the lavender soy candle in stock? I would like to order one.',
      summary: 'Asks whether the lavender soy candle is in stock.',
    });
    await sent(elise, {
      kind: 'reply',
      via: 'auto',
      minutesAgo: 1799,
      body: 'Hi Elise,\n\nYes, the lavender soy candle is in stock and costs 24 EUR. Delivery within Latvia takes 2-3 business days and costs 4 EUR.\n\nAnna Berg\nNordlicht Candles',
    });
    await sent(elise, {
      kind: 'followup',
      via: 'auto',
      minutesAgo: 500,
      subject: 'Re: Is the lavender candle in stock?',
      body: 'Hi Elise, would you like me to reserve a lavender candle for you?\n\nAnna Berg\nNordlicht Candles',
    });
    await tx`insert into public.messages (tenant_id, connection_id, thread_id, direction, message_id_header, from_address, from_name, to_addresses, subject, body_text, received_at)
             values (${tenantId}, ${connectionId}, ${elise.threadId}, 'inbound', ${msgId()}, ${elise.email}, 'Elise Moreau', ${[MAILBOX]},
                     ${'Re: ' + elise.subject}, 'Yes please, one lavender candle and a care kit. Thank you!', ${ago(180)})`;
    await tx`update public.threads set followups_sent = 1, last_inbound_at = ${ago(180)} where id = ${elise.threadId}`;
    await tx`update public.leads set last_activity_at = ${ago(180)} where id = ${elise.leadId}`;

    // 5. A quote is out (sent, waiting for the customer).
    const quote = async (
      cv: { leadId: string; threadId: string; messageId: string; email: string; subject: string },
      q: {
        number: string;
        name: string;
        status: 'sent' | 'accepted';
        lines: [string, string, number, number][];
        sentAgo: number;
        acceptedAgo?: number;
        body: string;
      },
    ) => {
      const subtotal = q.lines.reduce((s, l) => s + Math.round(l[2] * l[3]), 0);
      const vat = Math.round(subtotal * 0.21);
      const draftId = await sent(cv, {
        kind: 'quote',
        via: 'owner_approval',
        minutesAgo: q.sentAgo,
        subject: `Quote ${q.number}`,
        body: q.body,
      });
      const [row] = await tx`insert into public.quotes
          (tenant_id, number, thread_id, lead_id, draft_id, source_message_id, status, language, customer_name, customer_email,
           currency, vat_mode, vat_rate, subtotal_cents, vat_cents, total_cents, valid_until, sent_at, accepted_at)
        values (${tenantId}, ${q.number}, ${cv.threadId}, ${cv.leadId}, ${draftId}, ${cv.messageId}, ${q.status}, 'en', ${q.name}, ${cv.email},
                'EUR', 'exclusive', 21, ${subtotal}, ${vat}, ${subtotal + vat},
                ${new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)}, ${ago(q.sentAgo)},
                ${q.acceptedAgo ? ago(q.acceptedAgo) : null}) returning id`;
      let pos = 0;
      for (const [key, name, qty, cents] of q.lines) {
        await tx`insert into public.quote_lines (tenant_id, quote_id, position, price_item_id, name, unit, qty, unit_price_cents, line_total_cents)
                 values (${tenantId}, ${row.id}, ${pos++}, ${price[key]}, ${name}, ${key === 'gift' ? 'set' : 'pcs'}, ${qty}, ${cents}, ${Math.round(qty * cents)})`;
      }
    };
    const oskars = await conversation({
      name: 'Oskars Liepa',
      email: 'oskars.liepa@example.com',
      stage: 'quoted',
      threadStatus: 'awaiting_customer',
      subject: 'Candles for our café tables',
      minutesAgo: 1560,
      processing: ['drafted', 'draft'],
      body: 'Hello, we run a café in Riga and need 12 lavender candles for the tables. Could you send me a quote?',
      summary: 'Asks for a quote for 12 lavender candles for a café.',
    });
    await quote(oskars, {
      number: 'Q-2026-0001',
      name: 'Oskars Liepa',
      status: 'sent',
      sentAgo: 1550,
      lines: [['candle', 'Lavender soy candle', 12, 2400]],
      body: 'Hi Oskars,\n\nthank you for your request. Our quote Q-2026-0001 is attached: 12 lavender soy candles, 348.48 EUR including VAT. It is valid for 14 days and you can accept it online.\n\nAnna Berg\nNordlicht Candles',
    });

    // 6. A quote was accepted.
    const sofia = await conversation({
      name: 'Sofia Lindqvist',
      email: 'sofia.lindqvist@example.com',
      stage: 'accepted',
      threadStatus: 'customer_replied',
      subject: 'Gift sets for my team',
      minutesAgo: 2040,
      processing: ['drafted', 'draft'],
      body: 'Hi! I would like eight gift sets of three candles for my team. Can you send me a quote?',
      summary: 'Asks for a quote for eight gift sets.',
    });
    await quote(sofia, {
      number: 'Q-2026-0002',
      name: 'Sofia Lindqvist',
      status: 'accepted',
      sentAgo: 2030,
      acceptedAgo: 300,
      lines: [['gift', 'Gift set of three candles', 8, 6500]],
      body: 'Hi Sofia,\n\nthank you! Our quote Q-2026-0002 is attached: 8 gift sets, 629.20 EUR including VAT. You can accept it online.\n\nAnna Berg\nNordlicht Candles',
    });

    // 7. A customer whose invoice is paid (documents are created through the API below).
    const piotr = await conversation({
      name: 'Piotr Nowak',
      email: 'piotr.nowak@example.com',
      stage: 'converted',
      threadStatus: 'closed',
      subject: 'Candles and care kits for our shop',
      minutesAgo: 2300,
      processing: ['drafted', 'draft'],
      body: 'Hello, our shop in Gdańsk would like 10 lavender candles and 10 care kits. Can you invoice us and ship to Poland?',
      summary: 'Wants 10 lavender candles and 10 care kits, with an invoice.',
    });
    await sent(piotr, {
      kind: 'reply',
      via: 'owner_approval',
      minutesAgo: 2290,
      body: 'Hi Piotr,\n\nof course. I will send the invoice today; the goods ship as soon as it is paid.\n\nAnna Berg\nNordlicht Candles',
    });

    // 8. An open escalation: a refund request always comes to the owner.
    const karl = await conversation({
      name: 'Karl Weber',
      email: 'karl.weber@example.com',
      stage: 'escalated',
      threadStatus: 'escalated',
      subject: 'Damaged candle',
      minutesAgo: 100,
      processing: ['escalated', 'escalate'],
      body: 'The candle I ordered last week arrived broken. This is really disappointing and I would like a refund.',
      summary: 'Reports a broken candle and asks for a refund.',
    });
    await tx`insert into public.escalations (tenant_id, message_id, thread_id, category, reason, summary, notified_at)
             values (${tenantId}, ${karl.messageId}, ${karl.threadId}, 'hard_list', 'refund_request',
                     'Reports a broken candle and asks for a refund.', now())`;

    return { tenantId, piotr };
  });

  // Documents through the real API: an invoice (paid), its delivery note, and a CMR.
  const { accessToken } = (await (await fetch(`${API}/dev/login`, { method: 'POST' })).json()) as {
    accessToken: string;
  };
  const api = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(`${API}/v1/tenants/${ids.tenantId}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()}`);
    return (await r.json()) as T;
  };
  const buyer = {
    name: 'Piotr Nowak',
    address: 'ul. Długa 12, Gdańsk, Poland',
    regNo: '',
    vatNo: '',
    email: 'piotr.nowak@example.com',
  };
  const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

  const inv = await api<{ id: string }>('POST', '/documents', {
    type: 'invoice',
    threadId: ids.piotr.threadId,
  });
  const invDraft = await api<{ data: Record<string, unknown> }>('GET', `/documents/${inv.id}`);
  await api('PATCH', `/documents/${inv.id}`, {
    data: {
      ...invDraft.data,
      buyer,
      lines: [
        { name: 'Lavender soy candle', unit: 'pcs', qty: 10, unitPriceCents: 2400 },
        { name: 'Candle care kit', unit: 'pcs', qty: 10, unitPriceCents: 1200 },
      ],
      dueDate: due,
    },
  });
  await api('POST', `/documents/${inv.id}/issue`, {});
  await api('POST', `/documents/${inv.id}/mark`, { status: 'paid' });
  console.log('invoice: issued and paid');

  const dn = await api<{ id: string }>('POST', '/documents', {
    type: 'delivery_note',
    fromDocumentId: inv.id,
  });
  await api('POST', `/documents/${dn.id}/issue`, {});
  await api('POST', `/documents/${dn.id}/mark`, { status: 'delivered' });
  console.log('delivery note: issued and delivered');

  const cmr = await api<{ id: string }>('POST', '/documents', {
    type: 'cmr',
    threadId: ids.piotr.threadId,
  });
  const cmrDraft = await api<{ data: Record<string, unknown> }>('GET', `/documents/${cmr.id}`);
  const today = new Date().toISOString().slice(0, 10);
  await api('PATCH', `/documents/${cmr.id}`, {
    data: {
      ...cmrDraft.data,
      sender: {
        name: 'Nordlicht Candles SIA',
        address: 'Tērbatas iela 5, Rīga, LV-1011',
        country: 'Latvia',
      },
      consignee: { name: 'Piotr Nowak', address: 'ul. Długa 12, Gdańsk', country: 'Poland' },
      deliveryPlace: { place: 'Gdańsk', country: 'Poland' },
      takingOver: { place: 'Rīga', country: 'Latvia', date: today },
      goods: [
        {
          marks: 'NC-1',
          packages: 2,
          packing: 'Cartons',
          nature: 'Scented candles and care kits',
          statNo: '',
          grossKg: 18,
          volumeM3: null,
        },
      ],
      carriagePayment: 'paid',
      carrier: {
        name: 'Baltic Freight Example SIA',
        address: 'Ostas iela 10, Rīga',
        country: 'Latvia',
      },
      establishedIn: 'Rīga',
      establishedOn: today,
    },
  });
  try {
    await api('POST', `/documents/${cmr.id}/issue`, {});
    console.log('CMR: filled in and issued');
  } catch (e) {
    console.log(
      'CMR: filled in, left as a draft (' + String((e as Error).message).slice(0, 120) + ')',
    );
  }

  // Wait until the worker has read the three notes.
  for (let i = 0; i < 60; i++) {
    const [r] = await sql<
      { ready: number }[]
    >`select count(*) filter (where status = 'ready')::int as ready from public.kb_sources where tenant_id = ${ids.tenantId}`;
    if (r!.ready === 3) break;
    await new Promise((res) => setTimeout(res, 1000));
    if (i === 59) throw new Error('the notes were not ingested (is the worker running?)');
  }
  console.log('knowledge base: 3 notes ready');

  // Refresh the mailbox health (the worker checks it on its own too).
  await sql`update public.email_connections set last_ok_at = now(), last_checked_at = now(), status = 'connected' where tenant_id = ${ids.tenantId}`;
  console.log('done');
}

try {
  await main();
} finally {
  await sql.end();
}
