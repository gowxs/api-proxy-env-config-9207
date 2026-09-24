export type LlmErrorKind =
  'rate_limited' | 'unavailable' | 'timeout' | 'invalid_request' | 'auth' | 'not_found' | 'unknown';

/**
 * Provider failure with a coarse, loggable kind. The message never contains
 * prompt or email content — only the HTTP status and provider name.
 */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(provider: string, kind: LlmErrorKind, status?: number) {
    super(`${provider} request failed: ${kind}${status ? ` (HTTP ${status})` : ''}`);
    this.name = 'LlmError';
    this.kind = kind;
    this.status = status;
    this.retryable = kind === 'rate_limited' || kind === 'unavailable' || kind === 'timeout';
  }
}

export function classifyError(provider: string, error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const e = error as { status?: unknown; name?: unknown; code?: unknown };
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError')
    return new LlmError(provider, 'timeout');
  const status = typeof e?.status === 'number' ? e.status : undefined;
  if (status === 429) return new LlmError(provider, 'rate_limited', status);
  if (status === 401 || status === 403) return new LlmError(provider, 'auth', status);
  if (status === 404) return new LlmError(provider, 'not_found', status);
  if (status !== undefined && status >= 500) return new LlmError(provider, 'unavailable', status);
  if (status !== undefined && status >= 400)
    return new LlmError(provider, 'invalid_request', status);
  if (e?.code === 'ECONNRESET' || e?.code === 'ETIMEDOUT' || e?.code === 'ENOTFOUND') {
    return new LlmError(provider, 'unavailable');
  }
  return new LlmError(provider, 'unknown', status);
}
