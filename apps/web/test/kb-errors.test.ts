import { describe, expect, it } from 'vitest';
import { kbErrorText } from '../src/lib/kb-errors.ts';

describe('knowledge-source error wording', () => {
  it('explains the cause instead of showing a bare code', () => {
    expect(kbErrorText('embedding_failed:rate_limited')).toBe(
      'The text could not be prepared for search. The AI service is busy (per-minute limit).',
    );
    expect(kbErrorText('embedding_failed:quota_exhausted')).toMatch(/daily AI allowance/);
    expect(kbErrorText('free_tier_customer_data')).toMatch(/test mailboxes/);
    expect(kbErrorText('fetch_failed')).toMatch(/website could not be read/);
    expect(kbErrorText('embedding_failed')).toBe('The text could not be prepared for search.');
    expect(kbErrorText('something_new:odd_detail')).toBe('something new odd detail');
    expect(kbErrorText(null)).toBeNull();
  });
});
