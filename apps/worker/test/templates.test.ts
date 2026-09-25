import { describe, expect, it } from 'vitest';
import { renderNotificationEmail } from '../src/notify/templates.ts';

describe('notification templates', () => {
  it('renders the one-off test notification', () => {
    const r = renderNotificationEmail({
      id: 'n1',
      tenantId: 't1',
      tenantName: 'Acme <b>',
      audience: 'owner',
      kind: 'test',
      payload: {},
      links: { dashboard: 'https://app.example/' },
    });
    expect(r.subject).toBe('Noctiv test notification');
    expect(r.text).toContain('Your Noctiv email notifications work.');
    expect(r.html).toContain('Acme &lt;b&gt;');
    expect(r.html).toContain('https://app.example/');
  });

  const trial = (payload: Record<string, unknown>) =>
    renderNotificationEmail({
      id: 'n2',
      tenantId: 't1',
      tenantName: 'Nordlicht Candles',
      audience: 'owner',
      kind: 'trial_ending',
      payload,
      links: { dashboard: 'https://app.example/' },
    });

  it('renders the 7-day trial reminder with the exact end in the business time zone', () => {
    const r = trial({
      stage: 7,
      daysLeft: 7,
      endsAt: '2026-10-08T15:30:23Z',
      timezone: 'Europe/Riga',
    });
    expect(r.subject).toBe('Your Noctiv free trial ends in 7 days');
    expect(r.text).toContain(
      'Your free trial ends in 7 days, on Thursday, 8 October 2026 at 18:30 (Europe/Riga).',
    );
    expect(r.text).toContain('$79/month, plus VAT where applicable');
    expect(r.text).toContain('your data, drafts and settings are kept');
    expect(r.html).toContain('Subscribe in dashboard');
  });

  it('renders the last-day reminder', () => {
    const r = trial({
      stage: 1,
      daysLeft: 1,
      endsAt: '2026-10-08T15:30:23Z',
      timezone: 'Nowhere/Invalid',
    });
    expect(r.subject).toBe('Last day of your Noctiv free trial');
    expect(r.text).toContain('ends in less than a day, on Thursday, 8 October 2026 at 15:30 (UTC)');
  });
});
