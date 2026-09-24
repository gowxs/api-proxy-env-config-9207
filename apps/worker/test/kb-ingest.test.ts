import { describe, expect, it } from 'vitest';
import { ingestRetryDelaySeconds, secondsUntilDailyQuotaReset } from '../src/jobs/kb-ingest.ts';

describe('kb ingest retry timing', () => {
  it('waits for the daily quota reset (midnight Pacific) plus a margin', () => {
    // 16:00 UTC on 24 Sep = 09:00 PDT; reset at 07:00 UTC next day.
    expect(secondsUntilDailyQuotaReset(new Date('2026-09-24T16:00:00Z'))).toBe(15 * 3_600 + 600);
    // Winter (PST): 12:00 UTC = 04:00 PST; reset at 08:00 UTC.
    expect(secondsUntilDailyQuotaReset(new Date('2026-12-01T12:00:00Z'))).toBe(20 * 3_600 + 600);
  });

  it('picks the delay by cause', () => {
    const at = new Date('2026-09-24T16:00:00Z');
    const failed = (detail?: string, reason = 'embedding_failed') =>
      ({ status: 'failed', reason, retryable: true, detail }) as never;
    expect(ingestRetryDelaySeconds(failed('quota_exhausted'), at)).toBe(15 * 3_600 + 600);
    expect(ingestRetryDelaySeconds(failed('rate_limited'), at)).toBe(120);
    expect(ingestRetryDelaySeconds(failed(undefined, 'budget_halted'), at)).toBe(3_600);
    expect(ingestRetryDelaySeconds(failed('unavailable'), at)).toBeUndefined();
  });
});
