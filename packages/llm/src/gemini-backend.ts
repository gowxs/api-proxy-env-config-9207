import type {
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import {
  assertOriginAllowed,
  EMBEDDING_DIMENSIONS,
  type DataOrigin,
  type EmbeddingProvider,
  type EmbeddingTask,
  type EmbedResponse,
  type GenerateRequest,
  type GenerateResponse,
  type LlmProvider,
  type ModelTier,
  type ProviderName,
  type TrainingPolicy,
} from '@noctiv/core';
import { classifyError, LlmError } from './errors.ts';
import { EMBEDDING_MODELS_WITH_TASK_TYPE, THINKING_LEVEL } from './models.ts';

/** The part of the @google/genai client we use (narrow for testing). */
export interface GeminiClient {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
    embedContent(params: EmbedContentParameters): Promise<EmbedContentResponse>;
    get(params: { model: string }): Promise<unknown>;
  };
}

export interface GeminiBackendOptions {
  name: ProviderName;
  trainingPolicy: TrainingPolicy;
  client: GeminiClient;
  models: Record<ModelTier, string>;
  embeddingModel: string;
  /** Inputs per embedContent request. */
  embedBatchSize: number;
  /**
   * Upper bound of estimated tokens per embedding request. The free tier's
   * per-minute token limit rejects large batches outright (a 100-chunk
   * website batch, ~52k tokens, got HTTP 429 every time; found live).
   */
  embedBatchTokens?: number;
  /** Retries for an embedding request hitting a per-minute rate limit. */
  embedRateLimitRetries?: number;
  timeoutMs: number;
  /** Retries for rate limits / 5xx / timeouts, on top of the first attempt. */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Never wait longer than this for one retry, whatever the server suggests. */
const MAX_RETRY_WAIT_MS = 60_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function l2normalize(v: number[]): number[] {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

/** Rough token estimate for APIs that don't report embedding usage. */
export function estimateTokens(texts: string[]): number {
  return texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0);
}

/**
 * Shared implementation for both Gemini backends. They differ only in how the
 * client is constructed (API key vs. service account + EU region) and in
 * their training policy.
 */
export class GeminiBackend implements LlmProvider, EmbeddingProvider {
  readonly name: ProviderName;
  readonly trainingPolicy: TrainingPolicy;
  readonly models: Record<ModelTier, string>;
  readonly model: string;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly client: GeminiClient;
  private readonly opts: GeminiBackendOptions;

  constructor(opts: GeminiBackendOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.trainingPolicy = opts.trainingPolicy;
    this.client = opts.client;
    this.models = opts.models;
    this.model = opts.embeddingModel;
  }

  private guard(origin: DataOrigin): void {
    assertOriginAllowed(this.name, this.trainingPolicy, origin);
  }

  private async withRetry<T>(
    call: () => Promise<T>,
    policy: { retries?: number; rateLimitRetries?: number; rateLimitWaitMs?: number } = {},
  ): Promise<T> {
    const retries = policy.retries ?? this.opts.maxRetries ?? 2;
    const sleep = this.opts.sleep ?? defaultSleep;
    let rateLimited = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (e) {
        const err = classifyError(this.name, e);
        // Per-minute limits clear within a minute: wait them out (bounded), separately
        // from the short retry budget for outages and timeouts.
        if (err.kind === 'rate_limited' && policy.rateLimitRetries !== undefined) {
          if (rateLimited >= policy.rateLimitRetries) throw err;
          const wait = Math.max(
            err.retryAfterMs ?? 0,
            (policy.rateLimitWaitMs ?? 20_000) * 2 ** rateLimited,
          );
          rateLimited++;
          attempt--;
          await sleep(Math.min(wait, MAX_RETRY_WAIT_MS));
          continue;
        }
        if (!err.retryable || attempt >= retries) throw err;
        const backoff = 1_000 * 2 ** attempt + Math.floor(Math.random() * 250);
        await sleep(Math.min(Math.max(backoff, err.retryAfterMs ?? 0), MAX_RETRY_WAIT_MS));
      }
    }
  }

  /** Batches by count and by estimated tokens (at least one text per batch). */
  private embedBatches(texts: string[]): string[][] {
    const maxCount = this.opts.embedBatchSize;
    const maxTokens = this.opts.embedBatchTokens ?? Number.POSITIVE_INFINITY;
    const batches: string[][] = [];
    let current: string[] = [];
    let tokens = 0;
    for (const t of texts) {
      const n = estimateTokens([t]);
      if (current.length && (current.length >= maxCount || tokens + n > maxTokens)) {
        batches.push(current);
        current = [];
        tokens = 0;
      }
      current.push(t);
      tokens += n;
    }
    if (current.length) batches.push(current);
    return batches;
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    this.guard(req.origin);
    const model = this.models[req.tier];
    const response = await this.withRetry(() =>
      this.client.models.generateContent({
        model,
        contents: [{ role: 'user', parts: req.parts.map((p) => ({ text: p.text })) }],
        config: {
          systemInstruction: req.system,
          responseMimeType: 'application/json',
          responseJsonSchema: req.responseJsonSchema,
          maxOutputTokens: req.maxOutputTokens,
          thinkingConfig: { thinkingLevel: THINKING_LEVEL[req.tier] as never },
          abortSignal: AbortSignal.timeout(this.opts.timeoutMs),
        },
      }),
    );

    const candidate = response.candidates?.[0];
    const text = (candidate?.content?.parts ?? [])
      .filter((p) => !p.thought && typeof p.text === 'string')
      .map((p) => p.text)
      .join('');
    const meta = response.usageMetadata;
    return {
      text,
      finishReason:
        candidate?.finishReason ??
        (response.promptFeedback?.blockReason
          ? `BLOCKED:${response.promptFeedback.blockReason}`
          : null),
      usage: {
        inputTokens: meta?.promptTokenCount ?? 0,
        outputTokens: meta?.candidatesTokenCount ?? 0,
        thinkingTokens: meta?.thoughtsTokenCount ?? 0,
      },
      model: response.modelVersion ?? model,
    };
  }

  async embed(texts: string[], task: EmbeddingTask, origin: DataOrigin): Promise<EmbedResponse> {
    this.guard(origin);
    const vectors: number[][] = [];
    const taskType = EMBEDDING_MODELS_WITH_TASK_TYPE.has(this.model)
      ? task === 'query'
        ? 'RETRIEVAL_QUERY'
        : 'RETRIEVAL_DOCUMENT'
      : undefined;

    for (const batch of this.embedBatches(texts)) {
      const response = await this.withRetry(
        () =>
          this.client.models.embedContent({
            model: this.model,
            contents: batch,
            config: {
              outputDimensionality: this.dimensions,
              ...(taskType ? { taskType } : {}),
              abortSignal: AbortSignal.timeout(this.opts.timeoutMs),
            },
          }),
        { rateLimitRetries: this.opts.embedRateLimitRetries ?? 3 },
      );
      const got = response.embeddings ?? [];
      if (got.length !== batch.length) {
        throw new LlmError(this.name, 'invalid_request');
      }
      for (const e of got) {
        const values = e.values ?? [];
        if (values.length !== this.dimensions) {
          throw new Error(
            `${this.name}: embedding model ${this.model} returned ${values.length} dimensions, expected ${this.dimensions}`,
          );
        }
        // Truncated (Matryoshka) embeddings are not unit length; normalize so
        // cosine and inner-product rankings agree across providers.
        vectors.push(l2normalize(values));
      }
    }
    return {
      vectors,
      usage: { inputTokens: estimateTokens(texts), outputTokens: 0, thinkingTokens: 0 },
      model: this.model,
    };
  }

  /** Confirms every configured model is served to this project/region. */
  async checkModels(): Promise<{ model: string; ok: boolean; error?: string }[]> {
    const names = [...new Set([...Object.values(this.models), this.model])];
    return Promise.all(
      names.map(async (model) => {
        try {
          await this.client.models.get({ model });
          return { model, ok: true };
        } catch (e) {
          return { model, ok: false, error: classifyError(this.name, e).message };
        }
      }),
    );
  }
}
