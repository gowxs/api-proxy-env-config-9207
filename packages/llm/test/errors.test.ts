import { describe, expect, it } from 'vitest';
import { classifyError, LlmError } from '../src/errors.ts';

describe('classifyError', () => {
  it('treats Node fetch network failures (code on cause) as unavailable', () => {
    const e = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    const err = classifyError('p', e);
    expect(err.kind).toBe('unavailable');
    expect(err.retryable).toBe(true);
  });

  it('keeps the original error on an unknown failure, for the log', () => {
    const original = new TypeError('Cannot read properties of undefined');
    const err = classifyError('p', original);
    expect(err).toBeInstanceOf(LlmError);
    expect(err.kind).toBe('unknown');
    expect((err as { cause?: unknown }).cause).toBe(original);
  });
});
