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

export interface Provider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  listModels(): Promise<ModelInfo[]>;
  /** Main streaming entry point: an async iterator of normalized events ending with `stop`. */
  stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamEvent>;
  countTokens?(req: ChatRequest): Promise<number>;
}
