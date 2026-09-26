import type { Notification } from '@noctiv/core';
import { headerText, MAIL_ERROR_MESSAGES, type MailErrorCode } from '@noctiv/mail';
import { formatMoney } from '@noctiv/quotes';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const REASONS: Record<string, string> = {
  tenant_draft_only: 'your account is set to approve everything',
  arrived_while_paused: 'it arrived while the service was paused (no subscription)',
  billing_inactive: 'the service is paused (no active subscription)',
  budget_limited: 'the daily AI budget is nearly used up',
  sender_cap_reached: 'this customer already got the maximum number of automatic replies today',
  tenant_hour_cap_reached: 'the hourly limit for automatic replies was reached',
  mode_changed_to_draft_only: 'you switched to approving everything',
  content_removed: 'something was removed from the reply (for example a link)',
  unsupported_language: 'the language is not supported for automatic replies',
  language_mismatch: 'the reply language differs from the customer’s',
  injection_suspected: 'the email looks like it tries to manipulate the assistant',
  reply_to_mismatch: 'the reply address differs from the sender',
  model_chose_draft: 'the assistant was not sure enough to send it alone',
  not_verified: 'the facts in the reply could not be double-checked',
  invalid_output: 'the assistant produced no usable answer',
  model_escalated: 'the assistant asked for a human',
  low_confidence: 'the assistant was not confident',
  empty_reply: 'the assistant produced no reply',
  unknown_source: 'the reply cited something outside your knowledge base',
  claim_without_sources: 'the reply stated facts without a source',
  verifier_failed: 'a fact check found statements not backed by your knowledge base',
  acknowledgement_sent: 'the customer got a short acknowledgement (fully automatic mode)',
  quote_over_limit: 'the quote total is above your automatic-send limit',
  quote_unmapped: 'some requested items are not on your price list',
  quote_empty: 'nothing in the request matched your price list',
  partial_answer_check:
    'the e-mail also answers a question outside your price list; please check that part',
  quotes_disabled: 'Quotes (beta) is switched off',
  invoice_over_limit: 'the invoice total is above your automatic-send limit',
  documents_disabled: 'Documents (beta) is switched off',
};

export function describeReason(code: string): string {
  if (REASONS[code]) return REASONS[code];
  const [prefix, rest] = code.split(':');
  if (prefix === 'hard_list' && rest)
    return `a person should answer this (${rest.replace(/_/g, ' ')})`;
  if (prefix === 'unsupported_claim' && rest)
    return `the reply mentions a ${rest.replace(/_/g, ' ')} not found in your knowledge base`;
  return code.replace(/[_:]/g, ' ');
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * Text that came from a customer email (subject, name, model summary) can
 * carry phishing links aimed at the owner: links are removed and it is
 * shown as plain, escaped text.
 */
function untrusted(value: unknown, max = 400): string {
  const s = typeof value === 'string' ? value : '';
  return s
    .replace(/\b(?:https?|ftp):\/\/\S+/gi, '[link removed]')
    .replace(/\bwww\.\S+/gi, '[link removed]')
    .replace(/[\p{Cc}]+/gu, (m) => (m.includes('\n') ? '\n' : ' '))
    .trim()
    .slice(0, max);
}
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

interface Block {
  heading: string;
  lines: [label: string, value: string][];
  note?: string;
  quote?: { label: string; text: string };
  buttons?: [label: string, url: string][];
  footer: string;
}

function render(subject: string, b: Block): RenderedEmail {
  const text = [
    b.heading,
    '',
    ...b.lines.map(([k, v]) => `${k}: ${v}`),
    ...(b.note ? ['', b.note] : []),
    ...(b.quote ? ['', `${b.quote.label}:`, b.quote.text] : []),
    ...(b.buttons?.length ? ['', ...b.buttons.map(([k, u]) => `${k}: ${u}`)] : []),
    '',
    b.footer,
  ].join('\n');
  const rows = b.lines
    .map(
      ([k, v]) =>
        `<tr><td style="padding:2px 12px 2px 0;color:#555;vertical-align:top">${escapeHtml(k)}</td><td style="padding:2px 0">${escapeHtml(v)}</td></tr>`,
    )
    .join('');
  const buttons = (b.buttons ?? [])
    .map(
      ([k, u]) =>
        `<a href="${escapeHtml(u)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:6px;background:#3B2FD0;color:#fff;text-decoration:none;font-weight:600">${escapeHtml(k)}</a>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#F5F6FA">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F6FA"><tr><td align="center" style="padding:16px 8px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:10px;overflow:hidden">
<tr><td style="background:#0B1026"><img src="${EMAIL_HEADER_URL}" width="600" height="80" alt="Noctiv" style="display:block;width:100%;max-width:600px;height:auto;border:0;color:#EEF1FA;font:800 22px system-ui,sans-serif"></td></tr>
<tr><td style="padding:20px 24px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#131A2E">
<p style="font-size:17px;font-weight:600;margin-top:0">${escapeHtml(b.heading)}</p>
<table style="border-collapse:collapse">${rows}</table>
${b.note ? `<p>${escapeHtml(b.note)}</p>` : ''}
${b.quote ? `<p style="color:#555;margin-bottom:4px">${escapeHtml(b.quote.label)}:</p><pre style="white-space:pre-wrap;font-family:inherit;border-left:3px solid #ccc;padding-left:10px;margin-top:0">${escapeHtml(b.quote.text)}</pre>` : ''}
${buttons ? `<p>${buttons}</p>` : ''}
<p style="color:#646C8A;font-size:13px;margin-bottom:0">${escapeHtml(b.footer)}</p>
</td></tr></table>
</td></tr></table>
</body></html>`;
  return { subject: headerText(subject, 150), text, html };
}

/** "Thursday, 8 October 2026 at 15:30 (Europe/Riga)"; UTC when the zone is unknown. */
export function formatEnd(d: Date, timeZone: string): string {
  const fmt = (tz: string) =>
    `${d.toLocaleDateString('en-GB', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} at ${d.toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false })} (${tz})`;
  try {
    return fmt(timeZone || 'UTC');
  } catch {
    return fmt('UTC');
  }
}

/** The brand header (packages/brand exports, served by the site). */
const EMAIL_HEADER_URL = 'https://noctiv.io/brand/email-header.png';

const FOOTER =
  'Sent by Noctiv, your email assistant. You get this because you own this Noctiv account.';

/** Owner and admin notification emails (English UI). */
export function renderNotificationEmail(n: Notification): RenderedEmail {
  const p = n.payload;
  const reasons = list(p.reasons).map(describeReason).join('; ');
  const subjectLine = untrusted(p.subject, 200) || '(no subject)';
  const from = p.senderName
    ? `${untrusted(p.senderName, 100)} (${str(p.senderDomain)})`
    : `someone at ${str(p.senderDomain) || 'an unknown domain'}`;

  switch (n.kind) {
    case 'draft_ready':
      return render(`Reply ready for approval: ${subjectLine}`, {
        heading: 'A reply is waiting for your approval.',
        lines: [
          ['From', from],
          ['Subject', subjectLine],
          ['Summary', untrusted(p.summary)],
          ...(reasons ? ([['Why it needs you', reasons]] as [string, string][]) : []),
        ],
        ...(str(p.draftText) ? { quote: { label: 'Draft reply', text: str(p.draftText) } } : {}),
        note: str(p.draftText)
          ? undefined
          : 'The draft text is in your dashboard (privacy mode keeps it out of email).',
        buttons: [
          ...(n.links.approve
            ? ([['Approve and send', n.links.approve]] as [string, string][])
            : []),
          ...(n.links.reject ? ([['Reject', n.links.reject]] as [string, string][]) : []),
          ['Edit in dashboard', n.links.dashboard],
        ],
        footer: `Approve and Reject open a confirmation page first and work for 7 days. ${FOOTER}`,
      });
    case 'escalation':
      return render(`Please reply yourself: ${subjectLine}`, {
        heading: 'I could not answer this email — please reply manually.',
        lines: [
          ['From', from],
          ['Subject', subjectLine],
          ['Summary', untrusted(p.summary)],
          ...(reasons ? ([['Reason', reasons]] as [string, string][]) : []),
          ...(str(p.acknowledgement)
            ? ([['Customer was told', `“${str(p.acknowledgement)}”`]] as [string, string][])
            : []),
        ],
        ...(str(p.draftText)
          ? { quote: { label: 'AI suggestion, unverified', text: str(p.draftText) } }
          : {}),
        note:
          p.unverifiedSuggestion && !str(p.draftText)
            ? 'An unverified AI suggestion is in your dashboard.'
            : undefined,
        buttons: [['Open in dashboard', n.links.dashboard]],
        footer: FOOTER,
      });
    case 'mailbox_disconnected': {
      const code = str(p.code) as MailErrorCode;
      const why = MAIL_ERROR_MESSAGES[code] ?? MAIL_ERROR_MESSAGES.UNKNOWN;
      const mailbox = n.facts?.mailbox ?? 'Your mailbox';
      if (n.audience === 'admin') {
        return render(`[admin] Mailbox disconnected (${n.tenantName})`, {
          heading: 'A tenant mailbox was disconnected.',
          lines: [
            ['Tenant', `${n.tenantName} (${n.tenantId})`],
            ['Connection', str(p.connectionId)],
            ['Code', code],
          ],
          footer: 'Noctiv admin alert.',
        });
      }
      return render(`Action needed: ${mailbox} was disconnected`, {
        heading: `${mailbox} was disconnected. New emails are not being read or answered.`,
        lines: [['Reason', why]],
        note: 'Reconnect it with a new App Password to resume.',
        buttons: [['Reconnect mailbox', n.links.dashboard]],
        footer: FOOTER,
      });
    }
    case 'send_failed':
      return render(`A reply could not be sent: ${untrusted(p.subject, 200) || '(no subject)'}`, {
        heading: 'A reply could not be sent.',
        lines: [
          ['To', `someone at ${str(p.recipientDomain)}`],
          ['Subject', untrusted(p.subject, 200)],
          ['Reason', sendFailureText(str(p.code))],
        ],
        buttons: [['Open in dashboard', n.links.dashboard]],
        footer: FOOTER,
      });
    case 'budget_halted':
      return render('AI replies are paused for today', {
        heading: 'Today’s AI usage limit is reached, so new emails are not being answered.',
        lines: [
          ['Used', `${String(p.usedTokens ?? '?')} of ${String(p.dailyBudget ?? '?')} tokens`],
        ],
        note: 'Replies resume automatically tomorrow (00:00 UTC). Nothing was lost: the emails stay in your inbox.',
        buttons: [['Open dashboard', n.links.dashboard]],
        footer: FOOTER,
      });
    case 'budget_state':
      return render(`[admin] Budget ${str(p.state)} (${n.tenantName})`, {
        heading: `Tenant budget state is now ${str(p.state)}.`,
        lines: [
          ['Tenant', `${n.tenantName} (${n.tenantId})`],
          ['Day', str(p.day)],
          ['Used', `${String(p.usedTokens ?? '?')} of ${String(p.dailyBudget ?? '?')} tokens`],
        ],
        footer: 'Noctiv admin alert.',
      });
    case 'mailbox_unhealthy':
      return render(`[admin] Mailbox checks failing (${n.tenantName})`, {
        heading: 'A tenant mailbox failed its last health checks (login still accepted).',
        lines: [
          ['Tenant', `${n.tenantName} (${n.tenantId})`],
          ['Connection', str(p.connectionId)],
          ['Last error', str(p.code)],
          ['Failed checks in a row', String(p.failedChecks ?? '?')],
        ],
        footer: 'Noctiv admin alert.',
      });
    case 'quota_wait': {
      const mins = Math.round((Date.now() - new Date(str(p.since)).getTime()) / 60_000);
      return render(`[admin] Replies waiting on the AI quota (${n.tenantName})`, {
        heading: 'Customer e-mails are waiting because the AI provider’s daily quota is used up.',
        lines: [
          ['Tenant', `${n.tenantName} (${n.tenantId})`],
          [
            'Waiting',
            `${String(p.waiting ?? '?')} e-mail(s), the oldest for ${Number.isFinite(mins) ? mins : '?'} min`,
          ],
        ],
        note: 'They are retried automatically. Raise the provider quota or switch the model to clear the wait. The owner sees “Replies are delayed” in the app and gets an e-mail after 4 hours. One alert per tenant and day.',
        footer: 'Noctiv admin alert.',
      });
    }
    case 'replies_delayed':
      return render('Replies are delayed', {
        heading: 'Some customer e-mails have not been answered yet.',
        lines: [['Account', n.tenantName]],
        note: 'They will be answered automatically as soon as possible; nothing was lost. If a customer is waiting on something urgent, you can reply yourself from your mailbox.',
        buttons: [['Open dashboard', n.links.dashboard]],
        footer: FOOTER,
      });
    case 'job_dead':
      return render(`[admin] Job gave up: ${str(p.queue)} (${n.tenantName})`, {
        heading: 'A background job used up its retries.',
        lines: [
          ['Tenant', `${n.tenantName} (${n.tenantId})`],
          ['Queue', str(p.queue)],
          ['Job', str(p.jobId)],
          ['Error type', str(p.errorKind)],
        ],
        note: 'Details: public.jobs.last_error for this job id. One alert per tenant, queue and day.',
        footer: 'Noctiv admin alert.',
      });
    case 'trial_ending': {
      const endsAt = new Date(str(p.endsAt));
      const days = typeof p.daysLeft === 'number' ? p.daysLeft : Number(p.daysLeft);
      const when = Number.isNaN(endsAt.getTime()) ? 'soon' : formatEnd(endsAt, str(p.timezone));
      const lastDay = p.stage === 1 || days <= 1;
      const left = lastDay ? 'less than a day' : `${days} days`;
      return render(
        lastDay
          ? 'Last day of your Noctiv free trial'
          : `Your Noctiv free trial ends in ${days} days`,
        {
          heading: `Your free trial ends in ${left}, on ${when}.`,
          lines: [
            ['Account', n.tenantName],
            ['Price', '$79/month, plus VAT where applicable. Cancel any time.'],
          ],
          note:
            'Subscribe in your dashboard to keep Noctiv reading and answering your email. ' +
            'If you don’t, it stops when the trial ends; your data, drafts and settings are kept, ' +
            'and you can subscribe later.',
          buttons: [['Subscribe in dashboard', n.links.dashboard]],
          footer: FOOTER,
        },
      );
    }
    case 'quote_accepted': {
      const total =
        typeof p.totalCents === 'number' ? formatMoney(p.totalCents, str(p.currency) || 'EUR') : '';
      const number = headerText(str(p.number), 40);
      return render(`Quote ${number} accepted`, {
        heading: `Your customer accepted quote ${number}.`,
        lines: [
          ['Account', n.tenantName],
          ...(total ? ([['Total', total]] as [string, string][]) : []),
        ],
        note: p.autoInvoice
          ? 'The lead moved to “accepted”. The invoice is being prepared automatically; you will see it in Documents (or get a note if something is missing).'
          : 'The lead moved to “accepted”. Reply to the customer to arrange the next steps.',
        buttons: [['Open conversation', n.links.dashboard]],
        footer: FOOTER,
      });
    }
    case 'payment_matched':
    case 'payment_proposed': {
      const amount =
        typeof p.amountCents === 'number'
          ? formatMoney(p.amountCents, str(p.currency) || 'EUR')
          : '';
      const number = headerText(str(p.number), 40);
      const matched = n.kind === 'payment_matched';
      const how: Record<string, string> = {
        exact: 'the amount and the invoice number in the payment details match',
        amount: 'the amount matches (the payment details do not name the invoice)',
        payer: 'the payer’s name matches the buyer (check the amount)',
      };
      return render(
        matched ? `Payment received: ${number} is paid` : `Payment received: is it ${number}?`,
        {
          heading: matched
            ? `A payment of ${amount} came in and ${number} is now marked as paid.`
            : `A payment of ${amount} came in. It looks like it is for ${number}.`,
          lines: [
            ['Account', n.tenantName],
            ['Matched because', how[str(p.matchKind)] ?? 'it matched an open invoice'],
          ],
          note: matched
            ? 'Read from your bank’s notification. If it is wrong, open the invoice and change its status.'
            : 'Nothing was changed. One click in the dashboard marks it as paid.',
          buttons: [[matched ? 'Open invoice' : 'Review payment', n.links.dashboard]],
          footer: FOOTER,
        },
      );
    }
    case 'document_needs_you': {
      const what = str(p.type) === 'delivery_note' ? 'delivery note' : 'invoice';
      const why =
        str(p.event) === 'invoice_paid'
          ? 'Your customer paid an invoice'
          : 'Your customer accepted a quote';
      const problems = Array.isArray(p.problems)
        ? p.problems.map((x) => headerText(String(x), 120)).join('; ')
        : '';
      return render(`Finish the ${what}: a few details are missing`, {
        heading: `${why}, so I prepared the ${what}. It needs a few details before it can be sent.`,
        lines: [
          ['Account', n.tenantName],
          ...(problems ? ([['Missing', problems]] as [string, string][]) : []),
        ],
        note: `Nothing was sent. Add the details, then send the ${what} from the dashboard.`,
        buttons: [[`Open the ${what}`, n.links.dashboard]],
        footer: FOOTER,
      });
    }
    case 'quote_needs_you': {
      const items = Array.isArray(p.unmapped)
        ? p.unmapped.map((u) => `“${untrusted(u, 80)}”`).join(', ')
        : '';
      if (p.partial)
        return render('Part of a quote request needs you', {
          heading: p.quoteSent
            ? 'The quote was sent for the items on your price list; one part of the request is not answered yet.'
            : 'A quote is ready for the items on your price list; one part of the request is not answered.',
          lines: [
            ['Account', n.tenantName],
            ...(items ? ([['Not answered', items]] as [string, string][]) : []),
          ],
          note: 'Reply to the customer about that part yourself, or add it to your price list or knowledge base.',
          buttons: [['Open conversation', n.links.dashboard]],
          footer: FOOTER,
        });
      return render('A quote request needs you', {
        heading: 'A customer asked for prices on something not on your price list.',
        lines: [
          ['Account', n.tenantName],
          ...(items ? ([['Not matched', items]] as [string, string][]) : []),
        ],
        note: p.questionSent
          ? 'Noctiv asked the customer one clarifying question. Add the missing items to your price list so the next request can be quoted.'
          : 'A clarifying question is waiting for your approval. You can also add the missing items to your price list and answer yourself.',
        buttons: [['Open conversation', n.links.dashboard]],
        footer: FOOTER,
      });
    }
    case 'test':
      return render('Noctiv test notification', {
        heading: 'Your Noctiv email notifications work.',
        lines: [['Account', n.tenantName]],
        note: 'This is a one-off test. Draft approvals and alerts will arrive the same way.',
        buttons: [['Open dashboard', n.links.dashboard]],
        footer: FOOTER,
      });
    default:
      return render(`Noctiv notification (${headerText(String(n.kind), 40)})`, {
        heading: 'There is something new in your Noctiv dashboard.',
        lines: [],
        buttons: [['Open dashboard', n.links.dashboard]],
        footer: FOOTER,
      });
  }
}

function sendFailureText(code: string): string {
  if (code === 'SEND_UNCERTAIN')
    return 'The send was interrupted and it is unclear whether it went out. Check your Sent folder before sending it again.';
  if (code === 'MAILBOX_DISCONNECTED') return 'Your mailbox is disconnected.';
  if (code === 'DRAFT_EMPTY') return 'The reply was empty.';
  const known = MAIL_ERROR_MESSAGES[code as MailErrorCode];
  return known ?? 'The mail server refused the message.';
}
