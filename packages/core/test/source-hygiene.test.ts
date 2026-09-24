/**
 * No source file may contain invisible or bidi characters literally. They
 * make code review unreliable (the "Trojan Source" class of attacks), and our
 * formatter silently turns backslash-u escapes (e.g. for U+200B) into such
 * characters.
 * Tests build them from code points instead (test/fixtures/chars.ts).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const SKIP = new Set(['node_modules', '.git', '.next', 'dist', 'coverage']);
const EXTENSIONS = /\.(?:ts|tsx|js|mjs|cjs|json|sql|md|ya?ml|css)$/;
const FORBIDDEN = new RegExp(
  '[\\u00A0\\u00AD\\u200B-\\u200F\\u202A-\\u202F\\u2060-\\u2069\\uFEFF]|[\\u{E0000}-\\u{E007F}]',
  'u',
);

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* files(full);
    else if (EXTENSIONS.test(name) && name !== 'pnpm-lock.yaml') yield full;
  }
}

describe('source hygiene', () => {
  it('no file contains literal invisible or bidi control characters', () => {
    const offenders: string[] = [];
    for (const file of files(ROOT)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (FORBIDDEN.test(line)) offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
