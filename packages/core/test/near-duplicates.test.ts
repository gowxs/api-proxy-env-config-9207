import { describe, expect, it } from 'vitest';
import { dropNearDuplicates } from '../src/index.ts';

const c = (id: string, content: string) => ({ id, content });

describe('dropNearDuplicates', () => {
  it('keeps one copy of text repeated on several pages, in the first copy’s place', () => {
    const out = dropNearDuplicates([
      c(
        'a',
        'Pricing › Business website A complete site for a small business. Ready in 3–7 business days',
      ),
      c('b', 'Our work › A bakery site and a dentist site.'),
      c(
        'c',
        'Home › Packages › Business website A complete site for a small business. Ready in 3–7 business days',
      ),
      c(
        'd',
        'Services › Business website A complete site for a small business. Ready in 3–7 business days',
      ),
    ]);
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('a later copy that says more takes the place', () => {
    const short = 'FAQ › A business website takes 3–7 business days after we receive the content.';
    const long =
      'Home › A business website takes 3–7 business days after we receive the content. No upfront payment; we invoice after approval.';
    expect(
      dropNearDuplicates([c('s', short), c('x', 'Other text entirely here'), c('l', long)]).map(
        (x) => x.id,
      ),
    ).toEqual(['l', 'x']);
  });

  it('different text is kept', () => {
    const list = [
      c('1', 'Landing page: 5 business days'),
      c('2', 'Business website: 10 business days'),
    ];
    expect(dropNearDuplicates(list)).toEqual(list);
  });
});
