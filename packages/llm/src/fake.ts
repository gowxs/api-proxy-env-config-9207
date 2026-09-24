import { createHash } from 'node:crypto';
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
  type TrainingPolicy,
} from '@noctiv/core';

export type FakeResponder = (
  req: GenerateRequest,
  callIndex: number,
) => string | Partial<GenerateResponse>;

/**
 * Deterministic provider for tests and local development without an API key.
 * Embeddings are hashed bag-of-words vectors, so texts sharing words are
 * closer than texts that don't — enough for retrieval tests.
 */
export class FakeProvider implements LlmProvider, EmbeddingProvider {
  readonly name = 'fake' as const;
  readonly trainingPolicy: TrainingPolicy;
  readonly models: Record<ModelTier, string> = { fast: 'fake-fast', quality: 'fake-quality' };
  readonly model = 'fake-embedding';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  readonly calls: GenerateRequest[] = [];
  readonly embedCalls: { texts: string[]; task: EmbeddingTask; origin: DataOrigin }[] = [];
  private readonly responder: FakeResponder;

  constructor(opts: { responder?: FakeResponder; trainingPolicy?: TrainingPolicy } = {}) {
    this.responder = opts.responder ?? (() => '{}');
    this.trainingPolicy = opts.trainingPolicy ?? 'no_training';
  }

  async generate(req: GenerateRequest): Promise<GenerateResponse> {
    assertOriginAllowed(this.name, this.trainingPolicy, req.origin);
    const out = this.responder(req, this.calls.length);
    this.calls.push(req);
    const partial = typeof out === 'string' ? { text: out } : out;
    return {
      text: partial.text ?? '',
      finishReason: partial.finishReason ?? 'STOP',
      usage: partial.usage ?? { inputTokens: 100, outputTokens: 50, thinkingTokens: 0 },
      model: partial.model ?? this.models[req.tier],
    };
  }

  async embed(texts: string[], task: EmbeddingTask, origin: DataOrigin): Promise<EmbedResponse> {
    assertOriginAllowed(this.name, this.trainingPolicy, origin);
    this.embedCalls.push({ texts, task, origin });
    return {
      vectors: texts.map(fakeEmbedding),
      usage: {
        inputTokens: texts.reduce((n, t) => n + Math.ceil(t.length / 4), 0),
        outputTokens: 0,
        thinkingTokens: 0,
      },
      model: this.model,
    };
  }
}

export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const h = createHash('sha256').update(word).digest();
    v[h.readUInt16BE(0) % EMBEDDING_DIMENSIONS]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
