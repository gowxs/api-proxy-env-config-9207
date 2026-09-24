import type { Notification } from '@noctiv/core';
import { headerText, MAIL_ERROR_MESSAGES, type MailErrorCode } from '@noctiv/mail';

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const REASONS: Record<string, string> = {
  tenant_draft_only: 'your account is in draft-only mode',
  budget_limited: 'the daily AI budget is nearly used up',
  sender_cap_reached: 'this customer already got the maximum number of automatic replies today',
  tenant_hour_cap_reached: 'the hourly limit for automatic replies was reached',
  mode_changed_to_draft_only: 'you switched to draft-only mode',
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
        `<a href="${escapeHtml(u)}" style="display:inline-block;margin:0 8px 8px 0;padding:10px 16px;border-radius:6px;background:#1f3a5f;color:#fff;text-decoration:none">${escapeHtml(k)}</a>`,
    )
    .join('');
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;color:#1a1a1a;max-width:600px">
<p style="font-size:17px;font-weight:600">${escapeHtml(b.heading)}</p>
<table style="border-collapse:collapse">${rows}</table>
${b.note ? `<p>${escapeHtml(b.note)}</p>` : ''}
${b.quote ? `<p style="color:#555;margin-bottom:4px">${escapeHtml(b.quote.label)}:</p><pre style="white-space:pre-wrap;font-family:inherit;border-left:3px solid #ccc;padding-left:10px;margin-top:0">${escapeHtml(b.quote.text)}</pre>` : ''}
${buttons ? `<p>${buttons}</p>` : ''}
<p style="color:#777;font-size:13px">${escapeHtml(b.footer)}</p>
</body></html>`;
  return { subject: headerText(subject, 150), text, html };
}

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
