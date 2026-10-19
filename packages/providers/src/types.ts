// Provider adapter contract (docs/07 §2, §5). The conversation engine, agent runtime and coding
// agent depend only on these types, never on a vendor SDK.
import type { ProviderErrorCode } from '@nova/shared';

export type ReasoningLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  audioIn: boolean;
  audioOut: boolean;
  realtime: boolean;
  reasoning: false | 'levels' | 'budget';
  promptCache: 'none' | 'short' | 'long' | 'both';
  structuredOutput: boolean;
  imageGeneration: boolean;
  /** A faster serving tier can be requested with `ChatRequest.speed` (docs/07 §2, §5). */
  fastTier?: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}

export interface ModelInfo {
  id: string;
  label: string;
  capabilities: Partial<ProviderCapabilities>;
  costIn?: number;
  costOut?: number;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: string; data: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | {
      type: 'tool_result';
      callId: string;
      content: ContentPart[];
      isError?: boolean;
      untrusted: true;
    };

export interface NormalizedMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: ContentPart[];
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: NormalizedMessage[];
  tools?: ToolSchema[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  reasoning?: { level: ReasoningLevel } | { budgetTokens: number };
  /** `fast` asks for a faster serving tier; adapters ignore it unless the model has one. */
  speed?: 'standard' | 'fast';
  responseFormat?: { type: 'text' } | { type: 'json_schema'; schema: unknown };
  cacheHints?: { system?: boolean; tools?: boolean; history?: boolean };
  metadata?: Record<string, string>;
  signal: AbortSignal;
}

export interface AgentErrorShape {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  action?: string;
  /** How long the provider asked to wait before retrying (from Retry-After), when it said. */
  retryAfterMs?: number;
}

export type StopReason = 'end' | 'tool_calls' | 'length' | 'cancelled' | 'error';

export type StreamEvent =
  | { type: 'start'; messageId: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsDelta: string }
  | { type: 'tool_call_end'; index: number; args: unknown }
  | { type: 'citation'; url: string; title?: string; snippet?: string }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      cachedTokens?: number;
      costUsd?: number;
    }
  | { type: 'stop'; reason: StopReason; error?: AgentErrorShape };

export interface CallContext {
  /** Opaque id for logs and traces. */
  requestId: string;
}

/** One image to generate (FR-030, docs/07 §2). `size` is `<width>x<height>`. */
export interface ImageRequest {
  model: string;
  prompt: string;
  size: string;
  signal: AbortSignal;
}

/** A generated image as base64, with the prompt as the provider rewrote it when it did. */
export interface GeneratedImageData {
  data: string;
  mime?: string;
  revisedPrompt?: string;
}

export interface ImageResponse {
  model: string;
  images: GeneratedImageData[];
}

export interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  listModels(): Promise<ModelInfo[]>;
  /** Main streaming entry point: an async iterator of normalized events ending with `stop`. */
  stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamEvent>;
  countTokens?(req: ChatRequest): Promise<number>;
  /**
   * Optional: image generation (FR-030). Present only on adapters with an images call; the
   * provider's `imageGeneration` capability and the model's say whether it can be used.
   */
  generateImage?(req: ImageRequest, ctx: CallContext): Promise<ImageResponse>;
}
