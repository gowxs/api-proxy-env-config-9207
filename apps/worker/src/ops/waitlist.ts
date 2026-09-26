import {
  INTEGRATION_NAMES,
  type Logger,
  waitlistToken,
  type WaitlistIntegration,
} from '@noctiv/core';
import type { Transporter } from 'nodemailer';
import type { Sql } from 'postgres';

export interface WaitlistMailDeps {
  sql: Sql;
  transport: Pick<Transporter, 'sendMail'>;
  from: string;
  /** Public base URL of the API (links: <apiUrl>/waitlist/confirm/…). */
  apiUrl: string;
  secret: string;
  logger?: Logger;
}

const list = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export function waitlistConfirmationEmail(
  row: { id: string; integrations: string[] },
  deps: Pick<WaitlistMailDeps, 'apiUrl' | 'secret'>,
) {
  const base = deps.apiUrl.replace(/\/+$/, '');
  const confirm = `${base}/waitlist/confirm/${row.id}/${waitlistToken(row.id, 'confirm', deps.secret)}`;
  const unsubscribe = `${base}/waitlist/unsubscribe/${row.id}/${waitlistToken(row.id, 'unsubscribe', deps.secret)}`;
  const names = list(row.integrations.map((i) => INTEGRATION_NAMES[i as WaitlistIntegration] ?? i));
  return {
    subject: 'Confirm: Noctiv integrations waitlist',
    text: [
      'Hello,',
      '',
      `Someone (hopefully you) asked to hear when Noctiv works with ${names}.`,
      '',
      'Confirm your address:',
      confirm,
      '',
      'We will e-mail you when it is ready. No other e-mails.',
      'If you did not ask for this, ignore this message; without confirming you will not hear from us.',
      '',
      `Unsubscribe: ${unsubscribe}`,
      '',
      'Noctiv · noctiv.io',
    ].join('\n'),
    headers: {
      'Auto-Submitted': 'auto-generated',
      'List-Unsubscribe': `<${unsubscribe}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

/**
 * Double opt-in for the integrations waitlist (PLAN.md §23): one
 * confirmation e-mail per sign-up from the system mailer. The database
 * queues at most one per address a day.
 */
let running = false;
export async function sendWaitlistConfirmations(deps: WaitlistMailDeps, limit = 20) {
  if (running) return 0;
  running = true;
  try {
    return await sendBatch(deps, limit);
  } finally {
    running = false;
  }
}

async function sendBatch(deps: WaitlistMailDeps, limit: number) {
  const rows = await deps.sql<{ id: string; email: string; integrations: string[] }[]>`
    select * from app.waitlist_due_confirmations(${limit})`;
  let sent = 0;
  for (const row of rows) {
    // Marked first: a failure never turns into repeated e-mails to a stranger.
    await deps.sql`select app.waitlist_confirmation_sent(${row.id})`;
    try {
      const m = waitlistConfirmationEmail(row, deps);
      await deps.transport.sendMail({ from: deps.from, to: row.email, ...m });
      sent++;
    } catch (e) {
      deps.logger?.error({ err: String(e) }, 'waitlist confirmation failed');
    }
  }
  return sent;
}
