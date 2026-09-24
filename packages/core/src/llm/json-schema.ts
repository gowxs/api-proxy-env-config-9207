import { z } from 'zod';

/** Keywords Gemini's structured output understands; everything else is dropped. */
const KEPT_KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'items',
  'enum',
  'description',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'anyOf',
]);

function strip(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!KEPT_KEYWORDS.has(key)) continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [name, strip(schema)]),
      );
    } else {
      out[key] = strip(value);
    }
  }
  return out;
}

/**
 * The response schema sent to the model: a conservative subset of the zod
 * schema. The model's output is still validated against the full zod schema
 * (patterns, strictness) in code.
 */
export function responseSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return strip(z.toJSONSchema(schema)) as Record<string, unknown>;
}
