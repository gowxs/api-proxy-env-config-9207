import { randomUUID } from 'node:crypto';
import { verifyActionToken, type NotificationChannel } from '@noctiv/core';
import { GREENMAIL_USERS, seedTenant, type SeededTenant } from '@noctiv/db/testing';
import { parseInbound } from '@noctiv/mail';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { deliverNotifications, type DeliveryDeps } from '../src/notify/delivery.ts';
import { createSystemTransport, EmailChannel } from '../src/notify/email-channel.ts';
import { header, readFolder } from './helpers.ts';

const gm = inject('greenmail');
const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 4, onnotice: () => {} });
const U = GREENMAIL_USERS;
const SECRET = 'notify-test-secret-0123456789abcdef';

const email = new EmailChannel({
  transport: createSystemTransport({
    host: gm.host,
    port: gm.smtpPort,
    security: 'none',
    user: U.system.address,
    pass: U.system.password,
    from: `Noctiv <${U.system.address}>`,
  }),
  from: `Noctiv <${U.system.address}>`,
});
const deps = (patch: Partial<DeliveryDeps> = {}): DeliveryDeps => ({
  sql: worker,
  routes: {
    email_owner: { channel: email, audience: 'owner' },
    email_admin: { channel: email, audience: 'admin' },
  },
  adminEmail: U.admin.address,
  links: {
    apiUrl: 'https://api.noctiv.test',
    appUrl: 'https://app.noctiv.test',
    actionSecret: SECRET,
  },
  ...patch,
});

let T: SeededTenant;

async function tenantWithOwner(label: string, ownerEmail: string) {
  const t = await seedTenant(owner, label, { embeddingAxis: 80 });
  await owner`update auth.users set email = ${ownerEmail} where id = ${t.userId}`;
  await owner`update public.tenants set name = 'Lumen Studio' where id = ${t.tenantId}`;
  return t;
}

async function notify(
  tenantId: string,
  kind: string,
  payload: Record<string, unknown>,
  channel = 'email_owner',
) {
  const [n] = await owner<{ id: string }[]>`
    insert into public.notifications (tenant_id, channel, kind, dedupe_key, payload)
    values (${tenantId}, ${channel}, ${kind}, ${randomUUID()}, ${owner.json(payload as never)}) returning id`;
  return n!.id;
}

/** The delivered email for one notification (Message-ID is derived from its id). */
async function delivered(user: { address: string; password: string }, notificationId: string) {
  const all = await readFolder(gm, user);
  const hit = all.find(
    (m) => header(m.raw, 'Message-ID') === `<notify.${notificationId}@noctiv.test>`,
  );
  if (!hit) return undefined;
  const parsed = await parseInbound(Buffer.from(hit.raw));
  return { raw: hit.raw, text: parsed.text, subject: parsed.subject ?? '' };
}
const row = async (id: string) =>
  (
    await owner<
      { status: string; attempts: number; error: string | null; next_attempt_at: Date }[]
    >`
      select status, attempts, error, next_attempt_at from public.notifications where id = ${id}`
  )[0];

const draftPayload = (patch: Record<string, unknown> = {}) => ({
  kind: 'draft_ready',
  senderDomain: 'example-mail.test',
  subject: 'Lavender candles <b>now</b>',
  summary: 'Asks if lavender candles are in stock; see https://evil.example/login for details.',
  action: 'draft',
  reasons: ['tenant_draft_only', 'hard_list:angry'],
  unverifiedSuggestion: false,
  draftId: randomUUID(),
  messageId: randomUUID(),
  ...patch,
});

beforeAll(async () => {
  T = await tenantWithOwner('notify', U.owner.address);
});
afterAll(() => Promise.all([owner.end(), worker.end()]));

describe('owner email notifications (GreenMail as the system mailer sink)', () => {
  it('draft ready, privacy mode: summary and signed Approve / Reject links, no draft text', async () => {
    const payload = draftPayload();
    const id = await notify(T.tenantId, 'draft_ready', payload);
    const r = await deliverNotifications(deps());
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(await row(id)).toMatchObject({ status: 'sent', attempts: 1, error: null });

    const mail = (await delivered(U.owner, id))!;
    expect(mail).toBeDefined();
    expect(header(mail.raw, 'Auto-Submitted')).toBe('auto-generated');
    expect(header(mail.raw, 'From')).toBe(`Noctiv <${U.system.address}>`);
    expect(mail.subject).toBe('Reply ready for approval: Lavender candles <b>now</b>');
    expect(mail.text).toContain('someone at example-mail.test');
    expect(mail.text).toContain('[link removed]');
    expect(mail.text).not.toContain('evil.example');
    expect(mail.text).toContain('your account is in draft-only mode');
    expect(mail.text).toContain('privacy mode keeps it out of email');
    expect(mail.raw).toContain('Lavender candles &lt;b&gt;now&lt;/b&gt;');

    const approve = /Approve and send: (https:\/\/api\.noctiv\.test\/actions\/(\S+))/.exec(
      mail.text,
    );
    const reject = /Reject: https:\/\/api\.noctiv\.test\/actions\/(\S+)/.exec(mail.text);
    expect(approve && reject).toBeTruthy();
    const a = verifyActionToken(approve![2]!, SECRET);
    const rj = verifyActionToken(reject![1]!, SECRET);
    expect(a).toMatchObject({
      ok: true,
      claims: { tenantId: T.tenantId, draftId: payload.draftId, action: 'approve' },
    });
    expect(rj).toMatchObject({ ok: true, claims: { action: 'reject' } });
    expect(mail.text).toContain(`https://app.noctiv.test/drafts/${payload.draftId}`);
  });

  it('full-text tenants get the draft body and sender name', async () => {
    const id = await notify(
      T.tenantId,
      'draft_ready',
      draftPayload({ senderName: 'Anna Berzina', draftText: 'Yes, 12 EUR each, in stock.' }),
    );
    await deliverNotifications(deps());
    const mail = (await delivered(U.owner, id))!;
    expect(mail.text).toContain('Anna Berzina (example-mail.test)');
    expect(mail.text).toContain('Yes, 12 EUR each, in stock.');
  });

  it('escalations link to the dashboard only (no Approve)', async () => {
    const escalationId = randomUUID();
    const id = await notify(T.tenantId, 'escalation', {
      ...draftPayload({ kind: 'escalation', action: 'escalate', reasons: ['hard_list:refund'] }),
      draftId: undefined,
      escalationId,
    });
    await deliverNotifications(deps());
    const mail = (await delivered(U.owner, id))!;
    expect(mail.subject).toMatch(/^Please reply yourself:/);
    expect(mail.text).toContain('please reply manually');
    expect(mail.text).toContain(`https://app.noctiv.test/escalations/${escalationId}`);
    expect(mail.text).not.toContain('/actions/');
  });

  it('mailbox disconnected goes to the owner (with the address) and to the admin', async () => {
    const payload = { connectionId: T.connectionId, code: 'AUTH_FAILED' };
    const ownerId = await notify(T.tenantId, 'mailbox_disconnected', payload);
    const adminId = await notify(T.tenantId, 'mailbox_disconnected', payload, 'email_admin');
    await deliverNotifications(deps());
    const o = (await delivered(U.owner, ownerId))!;
    expect(o.subject).toBe('Action needed: inbox-notify@example.test was disconnected');
    expect(o.text).toContain('The username or App Password is wrong.');
    expect(o.text).toContain('https://app.noctiv.test/settings/mailboxes');
    const a = (await delivered(U.admin, adminId))!;
    expect(a.subject).toBe('[admin] Mailbox disconnected (Lumen Studio)');
    expect(a.text).toContain(T.tenantId);
    expect(await delivered(U.owner, adminId)).toBeUndefined();
  });

  it('budget and send-failure notices', async () => {
    const b = await notify(T.tenantId, 'budget_halted', {
      day: '2026-09-24',
      state: 'halted',
      usedTokens: 200_100,
      dailyBudget: 200_000,
    });
    const f = await notify(T.tenantId, 'send_failed', {
      draftId: randomUUID(),
      code: 'SEND_UNCERTAIN',
      recipientDomain: 'example-mail.test',
      subject: 'Re: Candle order',
    });
    await deliverNotifications(deps());
    expect((await delivered(U.owner, b))!.subject).toBe('AI replies are paused for today');
    const failed = (await delivered(U.owner, f))!;
    expect(failed.text).toContain('Check your Sent folder');
  });

  it("each tenant's notifications go only to that tenant's owners", async () => {
    const other = await tenantWithOwner('notify-other', U.customer2.address);
    const mine = await notify(T.tenantId, 'budget_halted', { usedTokens: 1, dailyBudget: 1 });
    const theirs = await notify(other.tenantId, 'budget_halted', { usedTokens: 1, dailyBudget: 1 });
    await deliverNotifications(deps());
    expect(await delivered(U.owner, mine)).toBeDefined();
    expect(await delivered(U.owner, theirs)).toBeUndefined();
    expect(await delivered(U.customer2, theirs)).toBeDefined();
    expect(await delivered(U.customer2, mine)).toBeUndefined();
  });

  it('without a signing secret the draft email has only the dashboard link', async () => {
    const id = await notify(T.tenantId, 'draft_ready', draftPayload());
    await deliverNotifications(
      deps({ links: { apiUrl: 'https://api.noctiv.test', appUrl: 'https://app.noctiv.test' } }),
    );
    const mail = (await delivered(U.owner, id))!;
    expect(mail.text).not.toContain('/actions/');
    expect(mail.text).toContain('Edit in dashboard');
  });
});

describe('delivery retries', () => {
  it('backs off after a failure and gives up after 5 attempts', async () => {
    const t = await seedTenant(owner, 'notify-retry', { embeddingAxis: 81 });
    let calls = 0;
    const id = await notify(t.tenantId, 'budget_halted', { usedTokens: 1, dailyBudget: 1 });
    const broken: NotificationChannel = {
      name: 'broken',
      // Other tests' notifications (files run in parallel) are delivered normally.
      deliver: async (n, to) => {
        if (n.id !== id) return email.deliver(n, to);
        calls++;
        throw Object.assign(new Error('Connection closed by owner@lumen-studio.test'), {
          code: 'ECONNECTION',
        });
      },
    };
    const d = deps({ routes: { email_owner: { channel: broken, audience: 'owner' } } });
    await deliverNotifications(d);
    const first = (await row(id))!;
    expect(first).toMatchObject({ status: 'pending', attempts: 1, error: 'ECONNECTION' });
    expect(first.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 50_000);
    await deliverNotifications(d);
    expect(calls).toBe(1); // not due yet

    for (let i = 0; i < 4; i++) {
      await owner`update public.notifications set next_attempt_at = now() where id = ${id}`;
      await deliverNotifications(d);
    }
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 5, error: 'ECONNECTION' });
    expect(calls).toBe(5);
  });

  it('a tenant with no owner email fails at once (no_recipient)', async () => {
    const t = await seedTenant(owner, 'notify-noowner', { embeddingAxis: 82 });
    await owner`delete from public.tenant_members where tenant_id = ${t.tenantId}`;
    const id = await notify(t.tenantId, 'budget_halted', { usedTokens: 1, dailyBudget: 1 });
    await deliverNotifications(deps());
    expect(await row(id)).toMatchObject({ status: 'failed', attempts: 1, error: 'no_recipient' });
  });

  it('notification emails are skipped by our own loop filter if they land in a connected inbox', async () => {
    const { checkLoop } = await import('@noctiv/core');
    const id = await notify(T.tenantId, 'budget_halted', { usedTokens: 1, dailyBudget: 1 });
    await deliverNotifications(deps());
    const mail = (await delivered(U.owner, id))!;
    const parsed = await parseInbound(Buffer.from(mail.raw));
    const verdict = checkLoop({
      from: parsed.from.address,
      replyTo: parsed.replyTo,
      headers: parsed.loopHeaders,
      bodyText: parsed.text,
      ownAddresses: [U.owner.address],
    });
    expect(verdict.skip).toBe(true);
  });
});
