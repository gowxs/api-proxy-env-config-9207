import { EMBEDDING_DIMENSIONS, TrainingDataPolicyError, type GenerateRequest } from '@noctiv/core';
import { describe, expect, it } from 'vitest';
import {
  GoogleAiStudioProvider,
  LlmError,
  NonEuRegionError,
  VertexGeminiProvider,
  type ClientFactory,
} from '../src/index.ts';
import { httpError, mockClientFactory, okResponse } from './mock-client.ts';

const models = { fast: 'gemini-3.5-flash-lite', quality: 'gemini-3.8-flash' };
const noSleep = async () => {};
const studio = (factory: ClientFactory, embeddingModel = 'gemini-embedding-001') =>
  new GoogleAiStudioProvider({
    apiKey: 'test-key',
    models,
    embeddingModel,
    timeoutMs: 5_000,
    clientFactory: factory,
    sleep: noSleep,
  });
const vertex = (factory: ClientFactory, location = 'europe-west4') =>
  new VertexGeminiProvider({
    projectId: 'noctiv-prod',
    location,
    credentialsFile: '/secrets/sa.json',
    models,
    embeddingModel: 'gemini-embedding-001',
    timeoutMs: 5_000,
    clientFactory: factory,
    sleep: noSleep,
  });

const request = (patch: Partial<GenerateRequest> = {}): GenerateRequest => ({
  tier: 'quality',
  origin: 'test_mailbox',
  system: 'SYSTEM RULES',
  parts: [
    { kind: 'kb_context', text: 'KB BLOCK' },
    { kind: 'untrusted_email', text: 'EMAIL BLOCK' },
  ],
  responseJsonSchema: { type: 'object' },
  maxOutputTokens: 1024,
  ...patch,
});

describe('GoogleAiStudioProvider (free tier)', () => {
  it('is configured for the Developer API with an API key, explicitly not Vertex', () => {
    const { factory, created } = mockClientFactory();
    const p = studio(factory);
    expect(created[0]!.options).toEqual({ enterprise: false, apiKey: 'test-key' });
    expect(p.trainingPolicy).toBe('may_train_on_data');
  });

  it.each(['customer_data'] as const)('refuses %s before any network call', async (origin) => {
    const { factory, created } = mockClientFactory();
    const p = studio(factory);
    await expect(p.generate(request({ origin }))).rejects.toBeInstanceOf(TrainingDataPolicyError);
    await expect(p.embed(['hello'], 'query', origin)).rejects.toBeInstanceOf(
      TrainingDataPolicyError,
    );
    expect(created[0]!.generateCalls).toHaveLength(0);
    expect(created[0]!.embedCalls).toHaveLength(0);
  });

  it.each(['test_mailbox', 'test_fixture'] as const)('accepts %s', async (origin) => {
    const { factory } = mockClientFactory();
    await expect(studio(factory).generate(request({ origin }))).resolves.toMatchObject({
      text: '{}',
    });
  });
});

describe('VertexGeminiProvider (paid, EU)', () => {
  it('uses the regional EU endpoint with a service account, never an API key', () => {
    const { factory, created } = mockClientFactory();
    const p = vertex(factory);
    expect(created[0]!.options).toEqual({
      enterprise: true,
      project: 'noctiv-prod',
      location: 'europe-west4',
      googleAuthOptions: {
        keyFilename: '/secrets/sa.json',
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    });
    expect(created[0]!.options).not.toHaveProperty('apiKey');
    expect(p.trainingPolicy).toBe('no_training');
  });

  it.each(['us-central1', 'global', 'europe-west2', 'europe-west6', 'asia-northeast1', ''])(
    'refuses non-EU location %j',
    (location) => {
      const { factory } = mockClientFactory();
      expect(() => vertex(factory, location)).toThrow(NonEuRegionError);
    },
  );

  it('processes customer data', async () => {
    const { factory } = mockClientFactory();
    await expect(
      vertex(factory).generate(request({ origin: 'customer_data' })),
    ).resolves.toMatchObject({ text: '{}' });
  });
});

describe('generate (shared Gemini mapping)', () => {
  it('sends the system prompt separately and the parts in order as one user turn', async () => {
    const { factory, created } = mockClientFactory({ generate: () => okResponse('{"a":1}') });
    const r = await studio(factory).generate(request());
    const call = created[0]!.generateCalls[0] as {
      model: string;
      contents: unknown;
      config: Record<string, unknown>;
    };
    expect(call.model).toBe('gemini-3.8-flash');
    expect(call.contents).toEqual([
      { role: 'user', parts: [{ text: 'KB BLOCK' }, { text: 'EMAIL BLOCK' }] },
    ]);
    expect(call.config).toMatchObject({
      systemInstruction: 'SYSTEM RULES',
      responseMimeType: 'application/json',
      responseJsonSchema: { type: 'object' },
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingLevel: 'LOW' },
    });
    expect(call.config.abortSignal).toBeInstanceOf(AbortSignal);
    expect(r).toEqual({
      text: '{"a":1}',
      finishReason: 'STOP',
      usage: { inputTokens: 120, outputTokens: 40, thinkingTokens: 15 },
      model: 'served-model-001',
    });
  });

  it('uses the fast model for the fast tier', async () => {
    const { factory, created } = mockClientFactory();
    await studio(factory).generate(request({ tier: 'fast' }));
    expect((created[0]!.generateCalls[0] as { model: string }).model).toBe('gemini-3.5-flash-lite');
  });

  it('never returns thought parts as answer text', async () => {
    const { factory } = mockClientFactory({ generate: () => okResponse('{"ok":true}') });
    expect((await studio(factory).generate(request())).text).toBe('{"ok":true}');
  });

  it('reports a blocked prompt as empty text with the block reason', async () => {
    const { factory } = mockClientFactory({
      generate: () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
    });
    expect(await studio(factory).generate(request())).toMatchObject({
      text: '',
      finishReason: 'BLOCKED:SAFETY',
    });
  });

  it('retries rate limits and server errors with backoff, then succeeds', async () => {
    const { factory, created } = mockClientFactory({
      generate: (_p, i) => (i === 0 ? httpError(429) : i === 1 ? httpError(503) : okResponse('{}')),
    });
    await expect(studio(factory).generate(request())).resolves.toMatchObject({ text: '{}' });
    expect(created[0]!.generateCalls).toHaveLength(3);
  });

  it('does not retry invalid requests, and errors never carry prompt text', async () => {
    const { factory, created } = mockClientFactory({ generate: () => httpError(400) });
    const err = await studio(factory)
      .generate(request())
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ kind: 'invalid_request', retryable: false, status: 400 });
    expect(String((err as Error).message)).not.toMatch(/SECRET|PROMPT|EMAIL BLOCK/);
    expect(created[0]!.generateCalls).toHaveLength(1);
  });

  it("waits as long as Google's RetryInfo asks (capped at 60 s)", async () => {
    const waits: number[] = [];
    const body = (s: string) =>
      Object.assign(new Error(`{"error":{"details":[{"retryDelay":"${s}"}]}}`), { status: 429 });
    const { factory } = mockClientFactory({
      generate: (_p, i) => (i === 0 ? body('33s') : i === 1 ? body('600s') : okResponse('{}')),
    });
    const p = new GoogleAiStudioProvider({
      apiKey: 'k',
      models,
      embeddingModel: 'gemini-embedding-001',
      timeoutMs: 5_000,
      clientFactory: factory,
      sleep: async (ms) => void waits.push(ms),
    });
    await p.generate(request());
    expect(waits).toEqual([33_000, 60_000]);
  });

  it('does not retry an exhausted daily quota', async () => {
    const daily = Object.assign(
      new Error(
        '{"error":{"details":[{"violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]},{"retryDelay":"24s"}]}}',
      ),
      { status: 429 },
    );
    const { factory, created } = mockClientFactory({ generate: () => daily });
    await expect(studio(factory).generate(request())).rejects.toMatchObject({
      kind: 'quota_exhausted',
      retryable: false,
    });
    expect(created[0]!.generateCalls).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const { factory, created } = mockClientFactory({ generate: () => httpError(429) });
    await expect(studio(factory).generate(request())).rejects.toMatchObject({
      kind: 'rate_limited',
    });
    expect(created[0]!.generateCalls).toHaveLength(3);
  });
});

describe('embed', () => {
  const unnormalized = () => ({
    values: Array.from({ length: 768 }, (_, i) => (i === 0 ? 3 : i === 1 ? 4 : 0)),
  });

  it(`requests ${EMBEDDING_DIMENSIONS} dimensions with retrieval task types and returns unit vectors`, async () => {
    const { factory, created } = mockClientFactory({
      embed: (p) => ({ embeddings: p.contents.map(unnormalized) }),
    });
    const p = studio(factory);
    const q = await p.embed(['where is my order?'], 'query', 'test_fixture');
    await p.embed(['Shipping takes 5 days.'], 'document', 'test_fixture');
    expect(created[0]!.embedCalls.map((c) => c.config)).toMatchObject([
      { outputDimensionality: 768, taskType: 'RETRIEVAL_QUERY' },
      { outputDimensionality: 768, taskType: 'RETRIEVAL_DOCUMENT' },
    ]);
    expect(q.vectors[0]!.slice(0, 2)).toEqual([0.6, 0.8]);
    expect(q.model).toBe('gemini-embedding-001');
    expect(q.usage.inputTokens).toBeGreaterThan(0);
  });

  it('omits the task type for models that do not accept one', async () => {
    const { factory, created } = mockClientFactory();
    await studio(factory, 'gemini-embedding-2').embed(['x'], 'query', 'test_fixture');
    expect(created[0]!.embedCalls[0]!.config).not.toHaveProperty('taskType');
  });

  it('batches: 100 inputs per request on the Developer API, 1 on Vertex', async () => {
    const a = mockClientFactory();
    await studio(a.factory).embed(
      Array.from({ length: 250 }, (_, i) => `t${i}`),
      'document',
      'test_fixture',
    );
    expect(a.created[0]!.embedCalls.map((c) => c.contents.length)).toEqual([100, 100, 50]);
    const b = mockClientFactory();
    await vertex(b.factory).embed(['a', 'b', 'c'], 'document', 'customer_data');
    expect(b.created[0]!.embedCalls.map((c) => c.contents.length)).toEqual([1, 1, 1]);
  });

  it('rejects vectors of the wrong dimension (both providers must match the database)', async () => {
    const { factory } = mockClientFactory({
      embed: () => ({ embeddings: [{ values: new Array(3072).fill(0.1) }] }),
    });
    await expect(studio(factory).embed(['x'], 'query', 'test_fixture')).rejects.toThrow(
      /3072 dimensions, expected 768/,
    );
  });

  it('rejects a response with a different number of vectors than inputs', async () => {
    const { factory } = mockClientFactory({ embed: () => ({ embeddings: [] }) });
    await expect(studio(factory).embed(['x'], 'query', 'test_fixture')).rejects.toBeInstanceOf(
      LlmError,
    );
  });

  it('both providers produce vectors of the same dimension', () => {
    expect(studio(mockClientFactory().factory).dimensions).toBe(
      vertex(mockClientFactory().factory).dimensions,
    );
  });
});

describe('checkModels', () => {
  it('reports which configured models are served', async () => {
    const { factory } = mockClientFactory({
      get: (m) => (m === 'gemini-3.8-flash' ? httpError(404) : { name: m }),
    });
    expect(await studio(factory).checkModels()).toEqual([
      { model: 'gemini-3.5-flash-lite', ok: true },
      {
        model: 'gemini-3.8-flash',
        ok: false,
        error: 'google_ai_studio request failed: not_found (HTTP 404)',
      },
      { model: 'gemini-embedding-001', ok: true },
    ]);
  });
});
