import { foldForMatching } from '../text/normalize.ts';

/** Share of the smaller chunk's word triples found in the other one. */
export const NEAR_DUPLICATE_OVERLAP = 0.8;

/**
 * A website repeats the same text on several pages ("Business website …
 * ready in 3–7 business days" on the home, pricing and services pages).
 * Chunk text starts with the page's heading trail ("Pricing › Business
 * website …"), which differs per page, so it is left out of the comparison.
 */
function shingles(content: string): Set<string> {
  const body = content.includes('›') ? content.slice(content.lastIndexOf('›') + 1) : content;
  const words = foldForMatching(body).match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (let i = 0; i + 2 < words.length; i++) out.add(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
  if (words.length > 0 && words.length < 3) out.add(words.join(' '));
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const s of small) if (large.has(s)) shared++;
  return shared / small.size;
}

/**
 * Drops near-duplicate chunks from a ranked list, so repeated website text
 * does not take the places of other sources (production case 2026-09-28).
 * Keeps the rank of the first copy; when a later copy says more (the smaller
 * one is contained in it), the later copy takes that place instead.
 */
export function dropNearDuplicates<T extends { content: string }>(ranked: T[]): T[] {
  const kept: { item: T; sh: Set<string> }[] = [];
  for (const item of ranked) {
    const sh = shingles(item.content);
    const same = kept.find((k) => overlap(k.sh, sh) >= NEAR_DUPLICATE_OVERLAP);
    if (!same) kept.push({ item, sh });
    else if (sh.size > same.sh.size) Object.assign(same, { item, sh });
  }
  return kept.map((k) => k.item);
}
