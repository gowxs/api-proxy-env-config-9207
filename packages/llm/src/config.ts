import { EnvError, loadEnv, type EmbeddingProvider, type LlmProvider } from '@noctiv/core';
import { z } from 'zod';
import { FakeProvider } from './fake.ts';
import { DEFAULT_MODELS } from './models.ts';
import { GoogleAiStudioProvider, VertexGeminiProvider, type ClientFactory } from './providers.ts';

const optionalString = z.string().trim().min(1).optional().catch(undefined);

export const llmEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** Optional override; otherwise chosen from which credentials are present. */
  LLM_PROVIDER: z.enum(['vertex', 'google_ai_studio', 'fake']).optional(),
  GEMINI_API_KEY: optionalString,
  GCP_PROJECT_ID: optionalString,
  GCP_LOCATION: z.string().trim().default('europe-west4'),
  GOOGLE_APPLICATION_CREDENTIALS: optionalString,
  LLM_MODEL_FAST: z.string().trim().min(1).default(DEFAULT_MODELS.fast),
  LLM_MODEL_QUALITY: z.string().trim().min(1).default(DEFAULT_MODELS.quality),
  EMBED_MODEL: z.string().trim().min(1).default(DEFAULT_MODELS.embedding),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(60_000),
  // Read by @google/genai to redirect traffic. We refuse to start if set.
  GOOGLE_GEMINI_BASE_URL: optionalString,
  GOOGLE_VERTEX_BASE_URL: optionalString,
});
export type LlmEnv = z.infer<typeof llmEnvSchema>;

export type LlmConfig =
  | {
      provider: 'vertex';
      projectId: string;
      location: string;
      credentialsFile: string;
      common: Common;
    }
  | { provider: 'google_ai_studio'; apiKey: string; common: Common }
  | { provider: 'fake'; common: Common };

interface Common {
  models: { fast: string; quality: string };
  embeddingModel: string;
  timeoutMs: number;
}

/**
 * Picks the provider (PLAN.md §11, step 4 decision):
 *  1. LLM_PROVIDER if set (its credentials must be present);
 *  2. Vertex when GCP credentials are present (paid, EU, no training);
 *  3. Google AI Studio when only GEMINI_API_KEY is present (free tier, test mailboxes only);
 *  4. otherwise a configuration error. The fake provider is never chosen implicitly
 *     and never allowed in production.
 */
export function resolveLlmConfig(
  source: Record<string, string | undefined> = process.env,
): LlmConfig {
  const env = loadEnv(llmEnvSchema, source);
  const problems: { variable: string; problem: string }[] = [];

  for (const v of ['GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL'] as const) {
    if (env[v])
      problems.push({ variable: v, problem: 'must not be set (would redirect model traffic)' });
  }

  const hasVertex = Boolean(env.GCP_PROJECT_ID && env.GOOGLE_APPLICATION_CREDENTIALS);
  const provider =
    env.LLM_PROVIDER ??
    (hasVertex ? 'vertex' : env.GEMINI_API_KEY ? 'google_ai_studio' : undefined);
  const common: Common = {
    models: { fast: env.LLM_MODEL_FAST, quality: env.LLM_MODEL_QUALITY },
    embeddingModel: env.EMBED_MODEL,
    timeoutMs: env.LLM_TIMEOUT_MS,
  };

  if (!provider) {
    problems.push({
      variable: 'GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS or GEMINI_API_KEY',
      problem: 'no LLM provider configured',
    });
  } else if (provider === 'vertex') {
    if (!env.GCP_PROJECT_ID)
      problems.push({ variable: 'GCP_PROJECT_ID', problem: 'required for vertex' });
    if (!env.GOOGLE_APPLICATION_CREDENTIALS) {
      problems.push({ variable: 'GOOGLE_APPLICATION_CREDENTIALS', problem: 'required for vertex' });
    }
  } else if (provider === 'google_ai_studio') {
    if (!env.GEMINI_API_KEY)
      problems.push({ variable: 'GEMINI_API_KEY', problem: 'required for google_ai_studio' });
  } else if (env.NODE_ENV === 'production') {
    problems.push({
      variable: 'LLM_PROVIDER',
      problem: 'fake provider is not allowed in production',
    });
  }
  if (problems.length) throw new EnvError(problems);

  switch (provider) {
    case 'vertex':
      return {
        provider,
        projectId: env.GCP_PROJECT_ID!,
        location: env.GCP_LOCATION,
        credentialsFile: env.GOOGLE_APPLICATION_CREDENTIALS!,
        common,
      };
    case 'google_ai_studio':
      return { provider, apiKey: env.GEMINI_API_KEY!, common };
    default:
      return { provider: 'fake', common };
  }
}

export interface Providers {
  llm: LlmProvider;
  embeddings: EmbeddingProvider;
  /** Safe to log: no secrets. */
  description: {
    provider: LlmConfig['provider'];
    trainingPolicy: LlmProvider['trainingPolicy'];
    models: { fast: string; quality: string; embedding: string };
    location?: string;
  };
}

export function createProviders(
  config: LlmConfig,
  deps: { clientFactory?: ClientFactory } = {},
): Providers {
  const c = config.common;
  const shared = {
    models: c.models,
    embeddingModel: c.embeddingModel,
    timeoutMs: c.timeoutMs,
    clientFactory: deps.clientFactory,
  };
  let provider: VertexGeminiProvider | GoogleAiStudioProvider | FakeProvider;
  if (config.provider === 'vertex') {
    provider = new VertexGeminiProvider({
      ...shared,
      projectId: config.projectId,
      location: config.location,
      credentialsFile: config.credentialsFile,
    });
  } else if (config.provider === 'google_ai_studio') {
    provider = new GoogleAiStudioProvider({ ...shared, apiKey: config.apiKey });
  } else {
    provider = new FakeProvider();
  }
  return {
    llm: provider,
    embeddings: provider,
    description: {
      provider: config.provider,
      trainingPolicy: provider.trainingPolicy,
      models: { ...provider.models, embedding: provider.model },
      ...(config.provider === 'vertex' ? { location: config.location } : {}),
    },
  };
}
