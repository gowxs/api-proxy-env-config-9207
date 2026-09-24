export type LlmErrorKind =
  | 'rate_limited'
  | 'quota_exhausted'
  | 'unavailable'
  | 'timeout'
  | 'invalid_request'
  | 'auth'
  | 'not_found'
  | 'unknown';

/**
 * Provider failure with a coarse, loggable kind. The message never contains
 * prompt or email content — only the HTTP status and provider name.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Server-suggested wait before retrying (Google RetryInfo), if any. */
  readonly retryAfterMs: number | undefined;

  constructor(provider: string, kind: LlmErrorKind, status?: number, retryAfterMs?: number) {
    super(`${provider} request failed: ${kind}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
    this.retryable = kind === 'rate_limited' || kind === 'unavailable' || kind === 'timeout';
    this.retryAfterMs = retryAfterMs;
  }
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export function classifyError(provider: string, error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const e = error as { status?: unknown; name?: unknown; code?: unknown };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError')
    return new LlmError(provider, 'timeout');
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === 429) {
    // A per-day quota does not come back in seconds, whatever retryDelay says.
    if (isDailyQuota(error)) return new LlmError(provider, 'quota_exhausted', status);
    return new LlmError(provider, 'rate_limited', status, retryDelayMs(error));
  }
  if (status === 401 || status === 403) return new LlmError(provider, 'auth', status);
  if (status === 404) return new LlmError(provider, 'not_found', status);
  if (status !== undefined && status >= 500) return new LlmError(provider, 'unavailable', status);
  if (status !== undefined && status >= 400)
    return new LlmError(provider, 'invalid_request', status);
  // Node fetch reports network failures as TypeError("fetch failed") with the code on `cause`.
  const code = e?.code ?? (e as { cause?: { code?: unknown } })?.cause?.code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) {
    return new LlmError(provider, 'unavailable');
  }
  const unknown = new LlmError(provider, 'unknown', status);
  // Kept for diagnostics (logs only): the original error's name and message.
  (unknown as { cause?: unknown }).cause = error;
  return unknown;
}

/** Reads Google's RetryInfo ("retryDelay": "33s") from an error body. Only the number is kept. */
function retryDelayMs(error: unknown): number | undefined {
  const text = error instanceof Error ? error.message : String(error);
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  return m ? Math.round(Number(m[1]) * 1000) : undefined;
}

/** Google names the violated quota, e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier". */
function isDailyQuota(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /"quotaId"\s*:\s*"[^"]*PerDay/i.test(text);
}
