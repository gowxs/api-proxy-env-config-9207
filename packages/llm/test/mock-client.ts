import type { GoogleGenAIOptions } from '@google/genai';
import type { GeminiClient } from '../src/index.ts';

export interface MockClient extends GeminiClient {
  options: GoogleGenAIOptions;
  generateCalls: unknown[];
  embedCalls: { model: string; contents: string[]; config: Record<string, unknown> }[];
}

type GenerateImpl = (params: unknown, call: number) => unknown;
type EmbedImpl = (
  params: { contents: string[]; config: Record<string, unknown> },
  call: number,
) => unknown;

export function mockClientFactory(
  impl: { generate?: GenerateImpl; embed?: EmbedImpl; get?: (model: string) => unknown } = {},
) {
  const created: MockClient[] = [];
  const factory = (options: GoogleGenAIOptions): GeminiClient => {
    const client: MockClient = {
      options,
      generateCalls: [],
      embedCalls: [],
      models: {
        generateContent: async (params) => {
          client.generateCalls.push(params);
          const r = impl.generate?.(params, client.generateCalls.length - 1) ?? okResponse('{}');
          if (r instanceof Error) throw r;
          return r as never;
        },
        embedContent: async (params) => {
          const p = params as unknown as {
            model: string;
            contents: string[];
            config: Record<string, unknown>;
          };
          client.embedCalls.push(p);
          const r = impl.embed?.(p, client.embedCalls.length - 1) ?? {
            embeddings: p.contents.map(() => ({ values: new Array(768).fill(0.5) })),
          };
          if (r instanceof Error) throw r;
          return r as never;
        },
        get: async ({ model }) => {
          const r = impl.get?.(model) ?? { name: model };
          if (r instanceof Error) throw r;
          return r;
        },
      },
    };
    created.push(client);
    return client;
  };
  return { factory, created };
}

export function okResponse(text: string, extra: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        content: { parts: [{ text: 'thinking…', thought: true }, { text }] },
        finishReason: 'STOP',
      },
    ],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 40, thoughtsTokenCount: 15 },
    modelVersion: 'served-model-001',
    ...extra,
  };
}

export function httpError(status: number): Error {
  return Object.assign(new Error(`got status ${status} with body containing SECRET PROMPT TEXT`), {
    status,
  });
}
