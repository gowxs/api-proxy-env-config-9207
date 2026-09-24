import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { redactActionPath } from './notify/action-token.ts';

/**
 * Fields that must never reach log output. Matched at any nesting depth we
 * realistically use (top level, one and two levels down).
 * Email bodies are included: they are customer data, not diagnostics.
 */
const SENSITIVE_KEYS = [
  'password',
  'pass',
  'appPassword',
  'credentials',
  'credentials_ciphertext',
  'secret',
  'token',
  'apiKey',
  'authorization',
  'cookie',
  'privateKey',
  'body',
  'body_text',
  'bodyText',
  'html',
  'text',
  'reply',
] as const;

export const REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((k) => [
  k,
  `*.${k}`,
  `*.*.${k}`,
]).concat(['req.headers.authorization', 'req.headers.cookie']);

export interface CreateLoggerOptions {
  service: string;
  level?: string;
  destination?: DestinationStream;
}

export function createLogger({
  service,
  level = 'info',
  destination,
}: CreateLoggerOptions): Logger {
  const options: LoggerOptions = {
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      // HTTP request logs (Fastify): Approve / Reject links carry a bearer-like token in the path.
      req: (req: { method?: string; url?: string; host?: string }) => ({
        method: req.method,
        url: typeof req.url === 'string' ? redactActionPath(req.url) : undefined,
        host: req.host,
      }),
    },
  };
  return destination ? pino(options, destination) : pino(options);
}

export type { Logger };
