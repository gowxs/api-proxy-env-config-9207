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

  it('names the violated quota in the message (ids only)', () => {
    const e = Object.assign(
      new Error(
        '{"error":{"message":"secret text","details":[{"violations":[{"quotaId":"EmbedContentInputTokensPerMinutePerProjectPerModel-FreeTier"}]}]}}',
      ),
      { status: 429 },
    );
    const err = classifyError('p', e);
    expect(err.kind).toBe('rate_limited');
    expect(err.message).toBe(
      'p request failed: rate_limited (HTTP 429, EmbedContentInputTokensPerMinutePerProjectPerModel-FreeTier)',
    );
  });

  it("without a quota id, quotes the start of Google's own message", () => {
    const e = Object.assign(
      new Error(
        '{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}',
      ),
      { status: 429 },
    );
    expect(classifyError('p', e).message).toBe(
      'p request failed: rate_limited (HTTP 429, "Resource has been exhausted (e.g. check quota).")',
    );
  });
});
