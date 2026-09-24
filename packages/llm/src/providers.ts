import { GoogleGenAI, type GoogleGenAIOptions } from '@google/genai';
import type { ModelTier } from '@noctiv/core';
import { GeminiBackend, type GeminiClient } from './gemini-backend.ts';

export type ClientFactory = (options: GoogleGenAIOptions) => GeminiClient;

const defaultClientFactory: ClientFactory = (options) => new GoogleGenAI(options);

interface CommonOptions {
  models: Record<ModelTier, string>;
  embeddingModel: string;
  timeoutMs: number;
  clientFactory?: ClientFactory;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
}

/**
 * Gemini Developer API (Google AI Studio) with an API key.
 * FREE TIER: Google may use submitted data to improve its products, so this
 * provider refuses every request whose data origin is customer_data. For
 * development and tests only (founder decision, step 4).
 */
export class GoogleAiStudioProvider extends GeminiBackend {
  constructor(opts: CommonOptions & { apiKey: string }) {
    const factory = opts.clientFactory ?? defaultClientFactory;
    super({
      name: 'google_ai_studio',
      trainingPolicy: 'may_train_on_data',
      // enterprise: false is explicit so GOOGLE_GENAI_USE_* env vars cannot switch backends.
      client: factory({ enterprise: false, apiKey: opts.apiKey }),
      models: opts.models,
      embeddingModel: opts.embeddingModel,
      embedBatchSize: 100,
      timeoutMs: opts.timeoutMs,
      sleep: opts.sleep,
      maxRetries: opts.maxRetries,
    });
  }
}

/**
 * EU regions accepted for Vertex AI. EU member states only: London
 * (europe-west2) and Zurich (europe-west6) are deliberately excluded.
 */
export const EU_VERTEX_LOCATIONS = new Set([
  'europe-west1', // Belgium
  'europe-west3', // Frankfurt
  'europe-west4', // Netherlands (chosen, Q5)
  'europe-west8', // Milan
  'europe-west9', // Paris
  'europe-west10', // Berlin
  'europe-west12', // Turin
  'europe-north1', // Finland
  'europe-north2', // Stockholm
  'europe-central2', // Warsaw
  'europe-southwest1', // Madrid
  'eu', // EU multi-region
]);

export class NonEuRegionError extends Error {
  constructor(location: string) {
    super(
      `Vertex AI location "${location}" is not an EU region; all processing must stay in the EU.`,
    );
    this.name = 'NonEuRegionError';
  }
}

/**
 * Gemini on Vertex AI (Google Cloud "Gemini Enterprise Agent Platform"),
 * paid tier, regional EU endpoint. Authenticates with a service-account key
 * file; never with an API key, so the SDK cannot fall back to the global
 * "express mode" endpoint.
 */
export class VertexGeminiProvider extends GeminiBackend {
  readonly location: string;

  constructor(
    opts: CommonOptions & { projectId: string; location: string; credentialsFile: string },
  ) {
    if (!EU_VERTEX_LOCATIONS.has(opts.location)) throw new NonEuRegionError(opts.location);
    const factory = opts.clientFactory ?? defaultClientFactory;
    super({
      name: 'vertex',
      trainingPolicy: 'no_training',
      client: factory({
        enterprise: true,
        project: opts.projectId,
        // Explicit: without it the SDK defaults to the non-regional "global" endpoint.
        location: opts.location,
        googleAuthOptions: {
          keyFilename: opts.credentialsFile,
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        },
      }),
      models: opts.models,
      embeddingModel: opts.embeddingModel,
      // Conservative until verified live: one input per embedding request.
      embedBatchSize: 1,
      timeoutMs: opts.timeoutMs,
      sleep: opts.sleep,
      maxRetries: opts.maxRetries,
    });
    this.location = opts.location;
  }
}
