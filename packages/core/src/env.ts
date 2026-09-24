import type { z } from 'zod';

/**
 * Thrown when required configuration is missing or malformed.
 * The message names the offending variables but never includes their values,
 * so it is safe to log even when a secret is malformed.
 */
export class EnvError extends Error {
  readonly variables: string[];

  constructor(issues: { variable: string; problem: string }[]) {
    super(
      `Invalid environment configuration:\n${issues
        .map((i) => `  - ${i.variable}: ${i.problem}`)
        .join('\n')}`,
    );
    this.name = 'EnvError';
    this.variables = issues.map((i) => i.variable);
  }
}

export function loadEnv<S extends z.ZodType>(
  schema: S,
  source: Record<string, string | undefined> = process.env,
): z.infer<S> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  throw new EnvError(
    result.error.issues.map((issue) => ({
      variable: issue.path.join('.') || '(root)',
      // zod messages describe the expectation, not the received value
      problem:
        issue.code === 'invalid_type' && issue.input === undefined ? 'required' : issue.message,
    })),
  );
}
