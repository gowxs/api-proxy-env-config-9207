import {
  checkEmailText,
  documentNumberKey,
  draftDocument,
  ownerNamed,
  type AssistantCustomer,
  type AssistantEvidence,
  type AssistantStep,
  type NormalizedProposal,
} from '@noctiv/core';
import { documentTotals } from '@noctiv/documents';
import { formatMoney, type VatMode } from '@noctiv/quotes';
import type { TransactionSql } from 'postgres';
import { detectMailbox, EMAIL_ADDRESS, mailboxFromName } from '@noctiv/mail';
import { customerOnFile, dnsResolveMx, findCustomers } from './tools.ts';

/**
 * The action cards (PLAN.md §27.2): a document, an e-mail, a payment. The
 * model's proposal is checked against this business's own data; a card that
 * does not pass is dropped. Nothing happens here: the API applies a card
 * only when the owner confirms it.
 */

type Proposal = AssistantStep['proposals'][number];

export interface ActionCard extends NormalizedProposal {
  /** send_email: attach the create_document card of this answer (its id is set on insert). */
  attachNew?: boolean;
}

export interface ActionContext {
  tx: TransactionSql;
  evidence: AssistantEvidence;
  /** Everything the owner wrote in this conversation (customers and addresses must come from it). */
  ownerText: string;
  /** MX lookup for connect_mailbox. */
  resolveMx?: (domain: string) => Promise<{ exchange: string }[]>;
  /** Bookings (beta): the signed link to an intake form for this customer. */
  formLink?: (formId: string, leadId: string | null) => string;
}

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z]{2,}$/i;

interface TenantRow {
  today: string;
  invoice_due_days: number;
  quotes_currency: string;
  quotes_vat_mode: VatMode;
  quotes_vat_rate: number;
  auto_delivery_note_after_payment: boolean;
}

/** One customer the owner named: exactly one match, or a new customer by name or address. */
async function resolveCustomer(
  tx: TransactionSql,
  raw: string,
  ownerText: string,
  typedAddress = '',
): Promise<AssistantCustomer | null> {
  const q = raw.trim();
  if (!q || !ownerNamed(q, ownerText)) return null;
  const found = await findCustomers(tx, q);
  if (found.length > 1) return null;
  const l = found[0];
  const base = l
    ? { leadId: l.id, name: l.name ?? '', email: l.email, threadId: l.thread_id }
    : q.includes('@')
      ? EMAIL.test(q)
        ? { leadId: null, name: '', email: q.toLowerCase(), threadId: null }
        : null
      : { leadId: null, name: q.slice(0, 200), email: '', threadId: null };
  if (!base) return null;
  // The address: as the owner wrote it, else the one on the customer's latest document.
  const typed = typedAddress.trim();
  if (typed && ownerNamed(typed, ownerText))
    return { ...base, address: typed.slice(0, 500), regNo: '', vatNo: '' };
  const onFile = base.email || base.leadId ? await customerOnFile(tx, base) : null;
  return {
    ...base,
    address: onFile?.address ?? '',
    regNo: onFile?.regNo ?? '',
    vatNo: onFile?.vatNo ?? '',
  };
}

const docName = (t: string) => (t === 'invoice' ? 'Invoice' : 'Delivery note');

export async function normalizeActions(
  proposals: Proposal[],
  ctx: ActionContext,
): Promise<{ cards: ActionCard[]; dropped: string[] }> {
  const { tx, evidence, ownerText } = ctx;
  const [t] = await tx<TenantRow[]>`
    select (now() at time zone timezone)::date::text as today, invoice_due_days, quotes_currency,
           quotes_vat_mode, quotes_vat_rate::float8 as quotes_vat_rate, auto_delivery_note_after_payment
    from public.tenants`;
  const money = (c: number) => formatMoney(c, t!.quotes_currency);
  const cards: ActionCard[] = [];
  const dropped: string[] = [];
  let newDoc: { buyer: AssistantCustomer; label: string } | null = null;

  // The document first: an e-mail in the same answer may attach it.
  const ordered = [
    ...proposals.filter((p) => p.type === 'create_document').slice(0, 1),
    ...proposals.filter(
      (p) => p.type === 'send_email' || p.type === 'mark_paid' || p.type === 'connect_mailbox',
    ),
  ];
  for (const p of ordered) {
    if (p.type === 'create_document') {
      const priceList = await tx<{ name: string; unit: string; unit_price_cents: number }[]>`
        select name, unit, unit_price_cents from public.price_items where status = 'confirmed'
        order by name limit 500`;
      const r = draftDocument(p, {
        evidence,
        customer: await resolveCustomer(tx, p.customer, ownerText, p.customer_address),
        priceList: priceList.map((i) => ({
          name: i.name,
          unit: i.unit,
          unitPriceCents: i.unit_price_cents,
        })),
        today: t!.today,
        defaultDueDays: t!.invoice_due_days,
      });
      if (!r.ok) {
        dropped.push(`create_document: ${r.reason}`);
        continue;
      }
      const d = r.value;
      const totals =
        d.docType === 'invoice' || d.withPrices
          ? documentTotals(d.lines, { mode: t!.quotes_vat_mode, ratePercent: t!.quotes_vat_rate })
          : null;
      const who = d.buyer.name || d.buyer.email;
      const label = `${docName(d.docType).toLowerCase()} for ${who}${totals ? `, ${money(totals.totalCents)}` : ''}`;
      newDoc = { buyer: d.buyer, label };
      // What the card states may be repeated in the answer and the e-mail.
      if (totals)
        evidence.add(
          `${money(totals.subtotalCents)} ${money(totals.vatCents)} ${money(totals.totalCents)} ${t!.quotes_vat_rate}%`,
          'tool',
        );
      if (d.dueDate) evidence.add(`${d.dueDate} ${dateWords(d.dueDate)}`, 'tool');
      cards.push({
        type: 'create_document',
        title: p.title.trim().slice(0, 120) || `${docName(d.docType)} for ${who}`,
        payload: {
          docType: d.docType,
          buyer: d.buyer,
          lines: d.lines,
          withPrices: d.withPrices,
          dueDate: d.dueDate,
          currency: t!.quotes_currency,
          vatMode: t!.quotes_vat_mode,
          vatRate: t!.quotes_vat_rate,
          totals: totals && {
            subtotalCents: totals.subtotalCents,
            vatCents: totals.vatCents,
            totalCents: totals.totalCents,
          },
        },
        requiresConfirmation: false,
      });
      continue;
    }

    if (p.type === 'send_email') {
      // Attachments: Ready documents by number, or the document card above.
      const documentIds: string[] = [];
      const attachLabels: string[] = [];
      let attachNew = false;
      let bad = '';
      for (const a of p.attach) {
        if (a.trim().toUpperCase() === 'NEW') {
          if (!newDoc) bad = 'NEW without a document card';
          else if (!attachNew) {
            attachNew = true;
            attachLabels.push(`The new ${newDoc.label} (once you confirm it above)`);
          }
          continue;
        }
        const key = documentNumberKey(a);
        const [doc] = key
          ? await tx<
              {
                id: string;
                number: string;
                type: string;
                status: string;
                total_cents: number;
                currency: string;
                due_date: string | null;
              }[]
            >`select id, number, type, status, total_cents, currency, due_date::text as due_date
              from public.documents
              where number is not null and upper(regexp_replace(number, '[^A-Za-z0-9]', '', 'g')) = ${key}`
          : [];
        if (!doc || doc.status !== 'issued') {
          bad = `attachment ${a} is not a ready document`;
          continue;
        }
        if (!documentIds.includes(doc.id)) {
          documentIds.push(doc.id);
          attachLabels.push(
            `${doc.number} (${docName(doc.type).toLowerCase()}, ${formatMoney(doc.total_cents, doc.currency)})`,
          );
          evidence.add(
            `${doc.number} ${formatMoney(doc.total_cents, doc.currency)} ${doc.due_date ?? ''} ${doc.due_date ? dateWords(doc.due_date) : ''}`,
            'tool',
          );
        }
      }
      if (bad) {
        dropped.push(`send_email: ${bad}`);
        continue;
      }
      // The recipient: an address the owner wrote or a known customer's; never one from a customer's e-mail.
      let to = '';
      let name = '';
      const typed = p.email_to.trim().toLowerCase();
      if (typed) {
        const known = EMAIL.test(typed) ? await findCustomers(tx, typed) : [];
        if (known[0] || (EMAIL.test(typed) && ownerText.toLowerCase().includes(typed))) {
          to = typed;
          name = known[0]?.name ?? '';
        }
      } else if (p.customer.trim()) {
        const c = await resolveCustomer(tx, p.customer, ownerText);
        if (c?.email) ({ email: to, name } = c);
      } else if (attachNew && newDoc?.buyer.email) {
        ({ email: to, name } = newDoc.buyer);
      }
      if (!to) {
        dropped.push('send_email: recipient');
        continue;
      }
      const own =
        await tx`select 1 from public.email_connections where lower(email_address) = ${to}`;
      if (own.length) {
        dropped.push('send_email: own address');
        continue;
      }
      const text = checkEmailText(p, evidence);
      if (!text.ok) {
        dropped.push(`send_email: ${text.reason}`);
        continue;
      }
      // An intake form: its link for this customer goes below the text (never a link the model wrote).
      let body = text.value.body;
      let formName: string | null = null;
      if (p.form.trim()) {
        const [f] = await tx<{ id: string; name: string }[]>`
          select id, name from public.intake_forms
          where archived_at is null and lower(name) = ${p.form.trim().toLowerCase()} limit 1`;
        if (!f || !ctx.formLink) {
          dropped.push('send_email: unknown form');
          continue;
        }
        const [lead] = await tx<{ id: string }[]>`select id from public.leads where email = ${to}`;
        formName = f.name;
        body = `${body}\n\n${f.name}: ${ctx.formLink(f.id, lead?.id ?? null)}`;
      }
      cards.push({
        type: 'send_email',
        title: p.title.trim().slice(0, 120) || `E-mail to ${name || to}`,
        payload: {
          to,
          name,
          subject: text.value.subject,
          body,
          documentIds,
          attachLabels,
          ...(formName ? { formName } : {}),
        },
        // Always the confirmation dialog: this e-mail goes out from the business mailbox.
        requiresConfirmation: true,
        attachNew,
      });
      continue;
    }

    if (p.type === 'connect_mailbox') {
      // The address the owner wrote (never one from a customer's e-mail), or their provider's name.
      const raw = p.mailbox.trim();
      const address =
        EMAIL_ADDRESS.test(raw) && ownerNamed(raw, ownerText) ? raw.toLowerCase() : null;
      const detected = address
        ? await detectMailbox(address, ctx.resolveMx ?? dnsResolveMx)
        : ownerNamed(raw, ownerText)
          ? mailboxFromName(raw)
          : null;
      if (!detected || detected.unsupported) {
        dropped.push(
          `connect_mailbox: ${detected?.unsupported ? 'unsupported' : 'no address or provider'}`,
        );
        continue;
      }
      if (address) {
        const same = await tx`select 1 from public.email_connections
                              where status = 'connected' and lower(email_address) = ${address}`;
        if (same.length) {
          dropped.push('connect_mailbox: already connected');
          continue;
        }
      }
      cards.push({
        type: 'connect_mailbox',
        title: p.title.trim().slice(0, 120) || `Connect ${address ?? detected.label}`,
        payload: {
          email: address,
          provider: detected.provider,
          label: detected.label,
          source: detected.source,
          // Servers for "Other (IMAP/SMTP)"; known providers use their preset.
          imap: detected.imap,
          smtp: detected.smtp,
        },
        // Nothing is changed by the card: it opens the connect form, which tests before saving.
        requiresConfirmation: false,
      });
      continue;
    }

    // mark_paid
    const key = documentNumberKey(p.document_number);
    const [doc] = key
      ? await tx<
          {
            id: string;
            number: string;
            type: string;
            status: string;
            payable: boolean;
            counterparty_name: string | null;
            total_cents: number;
            currency: string;
          }[]
        >`select id, number, type, status, payable, counterparty_name, total_cents, currency
          from public.documents
          where number is not null and upper(regexp_replace(number, '[^A-Za-z0-9]', '', 'g')) = ${key}`
      : [];
    if (!doc || !doc.payable || (doc.status !== 'issued' && doc.status !== 'sent')) {
      dropped.push(`mark_paid: ${p.document_number}`);
      continue;
    }
    evidence.add(`${doc.number} ${formatMoney(doc.total_cents, doc.currency)}`, 'tool');
    cards.push({
      type: 'mark_paid',
      title: p.title.trim().slice(0, 120) || `Mark ${doc.number} as paid`,
      payload: {
        documentId: doc.id,
        number: doc.number,
        customer: doc.counterparty_name,
        totalCents: doc.total_cents,
        currency: doc.currency,
        // "Delivery note after payment" is on: marking paid can send one.
        automation: t!.auto_delivery_note_after_payment,
      },
      requiresConfirmation: t!.auto_delivery_note_after_payment,
    });
  }
  return { cards, dropped };
}

/** "2026-10-05" → "5 October 2026 05.10.2026 5/10/2026", so the answer may say the date in words. */
function dateWords(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const month = new Date(Date.UTC(y!, m! - 1, d!)).toLocaleString('en-GB', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${d} ${month} ${y} ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}
