import { classifyError } from '@noctiv/llm';
import { describe, expect, it } from 'vitest';
import { describeError } from '../src/ingest.ts';

describe('describeError (worker log diagnostic)', () => {
  it('names the wrapped cause of an unknown provider error', () => {
    const err = classifyError('google_ai_studio', new TypeError('bad\n  response'));
    expect(describeError(err)).toBe(
      'LlmError: google_ai_studio request failed: unknown (cause: TypeError: bad response)',
    );
  });

  it('includes HTTP status and network code, and stays short', () => {
    const e = Object.assign(new Error('x'.repeat(1000)), { status: 400, code: 'E1' });
    const d = describeError(e);
    expect(d.startsWith('Error HTTP 400 E1: ')).toBe(true);
    expect(d.length).toBeLessThan(300);
  });
});
