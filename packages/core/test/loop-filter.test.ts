import { describe, expect, it } from 'vitest';
import { checkLoop, isAutomatedSender, type LoopCheckInput } from '../src/index.ts';

const OWN = ['info@shop.test'];
const base: LoopCheckInput = {
  headers: {},
  from: 'customer@example-mail.test',
  replyTo: [],
  ownAddresses: OWN,
  bodyText: 'Hello, do you ship to Estonia?',
};
const check = (patch: Partial<LoopCheckInput>) => checkLoop({ ...base, ...patch });

describe('loop prevention: headers', () => {
  it('lets an ordinary customer email through', () => {
    expect(check({})).toEqual({ skip: false });
  });

  it.each([
    [{ 'auto-submitted': 'auto-replied' }, 'loop_header:auto-submitted'],
    [{ 'auto-submitted': 'auto-generated' }, 'loop_header:auto-submitted'],
    [{ 'auto-submitted': 'auto-notified; owner-email="x@y.test"' }, 'loop_header:auto-submitted'],
    [{ precedence: 'bulk' }, 'loop_header:precedence'],
    [{ precedence: 'list' }, 'loop_header:precedence'],
    [{ precedence: 'junk' }, 'loop_header:precedence'],
    [{ precedence: 'auto_reply' }, 'loop_header:precedence'],
    [{ 'list-unsubscribe': '<mailto:unsub@news.test>' }, 'loop_header:list'],
    [{ 'list-id': '<news.shop.test>' }, 'loop_header:list'],
    [{ 'x-autoreply': 'yes' }, 'loop_header:autoreply'],
    [{ 'x-autorespond': 'Out of office' }, 'loop_header:autoreply'],
    [{ 'x-auto-response-suppress': 'All' }, 'loop_header:auto-response-suppress'],
    [{ 'x-auto-response-suppress': 'DR, OOF, AutoReply' }, 'loop_header:auto-response-suppress'],
    [{ 'x-loop': 'shop.test' }, 'loop_header:x-loop'],
    [{ 'return-path': '<>' }, 'bounce:null-return-path'],
    [{ 'content-type': 'multipart/report; report-type=delivery-status' }, 'bounce:delivery-report'],
  ] as const)('%o → %s', (headers, reason) => {
    expect(check({ headers })).toEqual({ skip: true, reason });
  });

  it('does not skip Auto-Submitted: no (explicitly human)', () => {
    expect(check({ headers: { 'auto-submitted': 'No' } })).toEqual({ skip: false });
  });

  it('handles multi-valued headers', () => {
    expect(check({ headers: { precedence: ['normal', 'bulk'] } })).toEqual({
      skip: true,
      reason: 'loop_header:precedence',
    });
  });
});

describe('loop prevention: senders', () => {
  it.each([
    'noreply@shop.test',
    'no-reply@shop.test',
    'no_reply@shop.test',
    'NoReply+tracking@shop.test',
    'donotreply@bank.test',
    'do-not-reply@bank.test',
    'mailer-daemon@mx.test',
    'MAILER-DAEMON@mx.test',
    'postmaster@mx.test',
    'notifications@github.test',
    'notification@service.test',
    'notifications-team@service.test',
    'bounce-1234@mail.test',
    'someone@bounces.mailer.test',
  ])('skips automated sender %s', (from) => {
    expect(check({ from })).toEqual({ skip: true, reason: 'automated_sender' });
  });

  it.each([
    'reynold@example.test',
    'info@othershop.test',
    'noreen@example.test',
    'notary.office@example.test',
  ])('does not skip a person like %s', (from) => {
    expect(isAutomatedSender(from)).toBe(false);
    expect(check({ from })).toEqual({ skip: false });
  });

  it("skips mail from the tenant's own mailbox (incl. plus-addressing and case)", () => {
    expect(check({ from: 'Info+test@SHOP.test' })).toEqual({
      skip: true,
      reason: 'sender_is_self',
    });
  });

  it('answers contact-form mail sent from our own or a noreply address with an external Reply-To', () => {
    expect(check({ from: 'info@shop.test', replyTo: ['customer@example-mail.test'] })).toEqual({
      skip: false,
    });
    expect(check({ from: 'noreply@shop.test', replyTo: ['customer@example-mail.test'] })).toEqual({
      skip: false,
    });
  });

  it('skips when the Reply-To itself is automated or ourselves', () => {
    expect(check({ replyTo: ['noreply@elsewhere.test'] })).toEqual({
      skip: true,
      reason: 'automated_sender',
    });
    expect(check({ replyTo: ['info@shop.test'] })).toEqual({
      skip: true,
      reason: 'sender_is_self',
    });
  });

  it('skips empty bodies', () => {
    expect(check({ bodyText: '  \n ' })).toEqual({ skip: true, reason: 'empty_body' });
  });
});

describe('loop prevention: two assistants talking to each other', () => {
  it('our auto-replies carry Auto-Submitted, so another Noctiv tenant never answers them', () => {
    // Step 9 sets "Auto-Submitted: auto-replied" on every auto-sent reply (RFC 3834).
    const ourAutoReply = { 'auto-submitted': 'auto-replied' };
    expect(check({ from: 'info@othershop.test', headers: ourAutoReply })).toEqual({
      skip: true,
      reason: 'loop_header:auto-submitted',
    });
  });
});
