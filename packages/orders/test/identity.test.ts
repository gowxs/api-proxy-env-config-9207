import { describe, expect, it } from 'vitest';
import { emailMatches } from '../src/index.ts';

const order = { email: 'Anna.Berg@Example.com', customerEmail: 'anna@home.example' };

describe('identity check', () => {
  it('matches the checkout e-mail, ignoring case and spaces', () => {
    expect(emailMatches('  anna.berg@example.com ', order)).toBe(true);
  });
  it('matches the linked customer e-mail', () =>
    expect(emailMatches('ANNA@home.example', order)).toBe(true));
  it.each([
    'anna.berg+shop@example.com',
    'annaberg@example.com',
    'anna.berg@example.org',
    'x@anna.berg@example.com',
    'example.com',
    '',
  ])('does not match %j', (sender) => expect(emailMatches(sender, order)).toBe(false));
  it('never matches when the order has no e-mail', () =>
    expect(emailMatches('anna@example.com', { email: null, customerEmail: null })).toBe(false));
});
