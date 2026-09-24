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
});
