import { EnvError } from '@noctiv/core';
import { describe, expect, it } from 'vitest';
import {
  createProviders,
  DEFAULT_MODELS,
  FakeProvider,
  GoogleAiStudioProvider,
  resolveLlmConfig,
  VertexGeminiProvider,
} from '../src/index.ts';
import { mockClientFactory } from './mock-client.ts';

const GCP = { GCP_PROJECT_ID: 'noctiv-prod', GOOGLE_APPLICATION_CREDENTIALS: '/secrets/sa.json' };
const KEY = { GEMINI_API_KEY: 'AIza-test-key-123' };

describe('resolveLlmConfig: provider selection', () => {
  it('uses Vertex when GCP credentials are present, even if an API key is too', () => {
    expect(resolveLlmConfig({ ...GCP, ...KEY })).toMatchObject({
      provider: 'vertex',
      projectId: 'noctiv-prod',
      location: 'europe-west4',
      credentialsFile: '/secrets/sa.json',
    });
  });

  it('uses Google AI Studio when only GEMINI_API_KEY is present', () => {
    expect(resolveLlmConfig(KEY)).toMatchObject({
      provider: 'google_ai_studio',
      apiKey: KEY.GEMINI_API_KEY,
    });
  });

  it('needs both GCP variables for Vertex; a project id alone falls back to the API key', () => {
    expect(resolveLlmConfig({ GCP_PROJECT_ID: 'p', ...KEY }).provider).toBe('google_ai_studio');
  });

  it('honours an explicit LLM_PROVIDER but requires its credentials', () => {
    expect(resolveLlmConfig({ ...GCP, ...KEY, LLM_PROVIDER: 'google_ai_studio' }).provider).toBe(
      'google_ai_studio',
    );
    expect(() => resolveLlmConfig({ ...KEY, LLM_PROVIDER: 'vertex' })).toThrow(
      /GCP_PROJECT_ID: required for vertex/,
    );
  });

  it('fails clearly with no provider configured, and never picks the fake one implicitly', () => {
    expect(() => resolveLlmConfig({})).toThrow(EnvError);
    expect(() => resolveLlmConfig({})).toThrow(/no LLM provider configured/);
  });

  it('allows the fake provider only outside production', () => {
    expect(resolveLlmConfig({ LLM_PROVIDER: 'fake', NODE_ENV: 'test' }).provider).toBe('fake');
    expect(() => resolveLlmConfig({ LLM_PROVIDER: 'fake', NODE_ENV: 'production' })).toThrow(
      /not allowed in production/,
    );
  });

  it.each(['GOOGLE_GEMINI_BASE_URL', 'GOOGLE_VERTEX_BASE_URL'])(
    'refuses to start when %s would redirect traffic',
    (v) => {
      expect(() => resolveLlmConfig({ ...GCP, [v]: 'https://proxy.example.test' })).toThrow(
        new RegExp(`${v}: must not be set`),
      );
    },
  );

  it('never puts secret values in configuration errors', () => {
    try {
      resolveLlmConfig({ GEMINI_API_KEY: 'AIza-SECRET', LLM_PROVIDER: 'vertex' });
    } catch (e) {
      expect(String(e)).not.toContain('AIza-SECRET');
    }
  });

  it('defaults to the pinned models and 60 s timeout; env can override', () => {
    expect(resolveLlmConfig(KEY).common).toEqual({
      models: { fast: DEFAULT_MODELS.fast, quality: DEFAULT_MODELS.quality },
      embeddingModel: DEFAULT_MODELS.embedding,
      timeoutMs: 60_000,
    });
    expect(resolveLlmConfig({ ...KEY, LLM_MODEL_QUALITY: 'gemini-x' }).common.models.quality).toBe(
      'gemini-x',
    );
  });
});

describe('createProviders', () => {
  it('builds the matching provider and a secret-free description', () => {
    const { factory } = mockClientFactory();
    const studio = createProviders(resolveLlmConfig(KEY), { clientFactory: factory });
    expect(studio.llm).toBeInstanceOf(GoogleAiStudioProvider);
    expect(studio.embeddings).toBe(studio.llm);
    expect(studio.description).toEqual({
      provider: 'google_ai_studio',
      trainingPolicy: 'may_train_on_data',
      models: {
        fast: DEFAULT_MODELS.fast,
        quality: DEFAULT_MODELS.quality,
        embedding: DEFAULT_MODELS.embedding,
      },
    });
    expect(JSON.stringify(studio.description)).not.toContain(KEY.GEMINI_API_KEY);

    const v = createProviders(resolveLlmConfig(GCP), { clientFactory: factory });
    expect(v.llm).toBeInstanceOf(VertexGeminiProvider);
    expect(v.description).toMatchObject({
      provider: 'vertex',
      trainingPolicy: 'no_training',
      location: 'europe-west4',
    });

    expect(createProviders(resolveLlmConfig({ LLM_PROVIDER: 'fake' })).llm).toBeInstanceOf(
      FakeProvider,
    );
  });

  it('refuses a non-EU GCP_LOCATION at startup', () => {
    expect(() =>
      createProviders(resolveLlmConfig({ ...GCP, GCP_LOCATION: 'us-central1' }), {
        clientFactory: mockClientFactory().factory,
      }),
    ).toThrow(/not an EU region/);
  });
});
