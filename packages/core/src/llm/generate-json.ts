import type { z } from 'zod';
import { responseSchemaFor } from './json-schema.ts';
import { parseModelJson } from './schemas.ts';
import {
  addUsage,
  ZERO_USAGE,
  type GenerateRequest,
  type LlmProvider,
  type TokenUsage,
} from './types.ts';

export type GenerateJsonResult<T> =
  | { ok: true; value: T; raw: string; usage: TokenUsage; model: string; attempts: number }
  | { ok: false; error: string; raw: string; usage: TokenUsage; model: string; attempts: number };

const MAX_ATTEMPTS = 2;

/**
 * Asks for schema-shaped JSON and validates it; retries once on invalid
 * output (PLAN.md §4.2: "invalid → one retry → escalate"). Provider errors
 * (network, quota) are not retried here — the job queue retries those.
 * The retry never echoes the previous output back to the model.
 */
export async function generateJson<T>(
  provider: LlmProvider,
  request: Omit<GenerateRequest, 'responseJsonSchema'>,
  schema: z.ZodType<T>,
): Promise<GenerateJsonResult<T>> {
  const responseJsonSchema = responseSchemaFor(schema);
  let usage = ZERO_USAGE;
  let lastError = '';
  let raw = '';
  let model = provider.models[request.tier];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const parts =
      attempt === 1
        ? request.parts
        : [
            ...request.parts,
            {
              kind: 'instruction' as const,
              text: `Your previous answer was rejected (${lastError.slice(0, 300)}). Return only one JSON object that follows the required schema exactly.`,
            },
          ];
    const response = await provider.generate({ ...request, parts, responseJsonSchema });
    usage = addUsage(usage, response.usage);
    raw = response.text;
    model = response.model;

    if (!response.text.trim()) {
      lastError = `empty response (finish reason: ${response.finishReason ?? 'unknown'})`;
      continue;
    }
    const parsed = parseModelJson(schema, response.text);
    if (parsed.ok) return { ok: true, value: parsed.value, raw, usage, model, attempts: attempt };
    lastError = parsed.error;
  }
  return { ok: false, error: lastError, raw, usage, model, attempts: MAX_ATTEMPTS };
}
