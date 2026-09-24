/**
 * Provider-neutral LLM interfaces (PLAN.md §5). Implementations live in
 * packages/llm; everything else depends only on these types.
 */

/**
 * Prompt parts are typed so providers can keep untrusted content in its own
 * delimited block (PLAN.md §3.5).
 */
export type PromptPart =
  | { kind: 'instruction'; text: string }
  | { kind: 'untrusted_email'; text: string }
  | { kind: 'kb_context'; text: string };

export interface BuiltPrompt {
  system: string;
  parts: PromptPart[];
}

/**
 * Where the data in a request comes from. Every model call must say so,
 * because free-tier providers may use submitted data for training:
 *  - test_mailbox:  a mailbox the operator flagged is_test_mailbox
 *  - test_fixture:  synthetic data from tests and evaluations
 *  - customer_data: anything from a real tenant (mail, knowledge base)
 */
export type DataOrigin = 'test_mailbox' | 'test_fixture' | 'customer_data';

/** Whether the provider's terms allow the vendor to train on submitted data. */
export type TrainingPolicy = 'may_train_on_data' | 'no_training';

export type ModelTier = 'fast' | 'quality';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** Reasoning tokens; billed as output. */
  thinkingTokens: number;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}

export function totalTokens(u: TokenUsage): number {
  return u.inputTokens + u.outputTokens + u.thinkingTokens;
}

export interface GenerateRequest {
  tier: ModelTier;
  origin: DataOrigin;
  system: string;
  parts: PromptPart[];
  /** JSON Schema the response must follow (providers pass a supported subset). */
  responseJsonSchema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface GenerateResponse {
  /** Raw response text; the caller validates it. Empty if the model returned nothing. */
  text: string;
  /** Provider's reason for stopping ("STOP", "MAX_TOKENS", "SAFETY", …). */
  finishReason: string | null;
  usage: TokenUsage;
  model: string;
}

export type ProviderName = 'google_ai_studio' | 'vertex' | 'fake';

export interface LlmProvider {
  readonly name: ProviderName;
  readonly trainingPolicy: TrainingPolicy;
  readonly models: Record<ModelTier, string>;
  generate(req: GenerateRequest): Promise<GenerateResponse>;
}

export type EmbeddingTask = 'query' | 'document';

export interface EmbedResponse {
  /** L2-normalized vectors, one per input, each exactly `dimensions` long. */
  vectors: number[][];
  usage: TokenUsage;
  model: string;
}

export interface EmbeddingProvider {
  readonly name: ProviderName;
  readonly trainingPolicy: TrainingPolicy;
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[], task: EmbeddingTask, origin: DataOrigin): Promise<EmbedResponse>;
}

/** Must equal kb_chunks.embedding's vector(N) (checked by a database test). */
export const EMBEDDING_DIMENSIONS = 768;
