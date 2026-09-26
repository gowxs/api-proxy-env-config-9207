import { randomUUID } from 'node:crypto';
import { waitlistToken } from '@noctiv/core';
import postgres from 'postgres';
import { afterAll, describe, expect, inject, it } from 'vitest';
import { sendWaitlistConfirmations } from '../src/ops/waitlist.ts';

const owner = postgres(inject('ownerDatabaseUrl'), { max: 2, onnotice: () => {} });
const worker = postgres(inject('workerDatabaseUrl'), { max: 2, onnotice: () => {} });
afterAll(() => Promise.all([owner.end(), worker.end()]));

const SECRET = 'waitlist-test-secret-0123456789abcdef';

describe('waitlist confirmation e-mails', () => {
  it('sends one double opt-in e-mail per sign-up, with confirm and unsubscribe links', async () => {
    await owner`update marketing.waitlist set confirmation_due = false`;
    const email = `wl-${randomUUID()}@example.test`;
    const [s] = await owner<{ id: string }[]>`
      select id from app.waitlist_signup(${email}, ${['xero', 'shopify']}, 'integrations', null)`;
    const sent: { to: string; subject: string; text: string; headers: Record<string, string> }[] =
      [];
    const deps = {
      sql: worker,
      transport: { sendMail: async (m: never) => void sent.push(m) } as never,
      from: 'Noctiv <notify@noctiv.test>',
      apiUrl: 'https://app.noctiv.test/api/',
      secret: SECRET,
    };
    expect(await sendWaitlistConfirmations(deps)).toBe(1);
    expect(await sendWaitlistConfirmations(deps)).toBe(0);
    const [m] = sent;
    expect(m!.to).toBe(email);
    expect(m!.text).toContain('Xero and Shopify');
    expect(m!.text).toContain(
      `https://app.noctiv.test/api/waitlist/confirm/${s!.id}/${waitlistToken(s!.id, 'confirm', SECRET)}`,
    );
    expect(m!.text).toContain('No other e-mails.');
    expect(m!.headers['List-Unsubscribe']).toBe(
      `<https://app.noctiv.test/api/waitlist/unsubscribe/${s!.id}/${waitlistToken(s!.id, 'unsubscribe', SECRET)}>`,
    );
    expect(m!.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');

    // Signing up again the same day sends nothing more.
    await owner`select * from app.waitlist_signup(${email}, ${['xero']}, 'integrations', null)`;
    expect(await sendWaitlistConfirmations(deps)).toBe(0);
  });

  it('the worker cannot read the waitlist table directly', async () => {
    await expect(worker`select * from marketing.waitlist`).rejects.toThrow(/permission denied/);
  });
});
