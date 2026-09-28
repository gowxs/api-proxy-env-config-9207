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

  it('lists sources that disagree and says which figure the reply uses', () => {
    const r = renderNotificationEmail({
      id: 'n9',
      tenantId: 't1',
      tenantName: 'WXS',
      audience: 'owner',
      kind: 'draft_ready',
      payload: {
        senderDomain: 'example-mail.test',
        subject: 'Business website',
        summary: 'Asks about cost and timeline.',
        reasons: ['price_omitted', 'contradicts_owner_note'],
        conflicts: [
          {
            about: 'business website',
            reply: '3–7 business days',
            replyUsesNote: false,
            sources: [
              {
                says: '10 business days',
                source: 'your note "Prices <b>" (2026-09-24)',
                preferred: true,
              },
              {
                says: '3–7 business days',
                source: 'your website example.com/en/ (read 2026-09-25)',
                preferred: false,
              },
            ],
          },
        ],
      },
      links: { dashboard: 'https://app.example/' },
    });
    expect(r.text).toContain(
      'the customer asked for a price your knowledge base has, and the reply left it out; a figure in the reply differs from your own note',
    );
    expect(r.text).toContain('SOURCES DISAGREE');
    expect(r.text).toContain(
      'business website: your note "Prices <b>" (2026-09-24) says 10 business days (newest note); ' +
        'your website example.com/en/ (read 2026-09-25) says 3–7 business days. ' +
        "The reply says 3–7 business days, not your note's figure: edit it before approving.",
    );
    expect(r.text).toContain('Please correct the source that is out of date.');
    expect(r.html).toContain('Prices &lt;b&gt;');
    expect(r.html).not.toContain('Prices <b>');
  });
});
