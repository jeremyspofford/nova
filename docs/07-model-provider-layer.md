# 07 — Model & Provider Layer

## 1. Goals

- One internal contract for all model providers, so the conversation engine, agent runtime,
  and coding agent never depend on a vendor SDK.
- Streaming, tool calling, multimodal input, structured output, reasoning levels, prompt
  caching, cancellation, retries, and cost accounting are uniform.
- Users can bring their own keys/OAuth, run local models, and define **virtual models**
  (named presets that route to a provider/model/params).

## 2. Provider adapter interface

Located in `packages/providers`. Every adapter implements:

```ts
export interface Provider {
  readonly id: string;                       // 'anthropic' | 'openai' | ...
  readonly capabilities: ProviderCapabilities;

  listModels(account: ProviderAccount): Promise<ModelInfo[]>;

  initAuth(account: ProviderAccount): AuthFlow;   // OAuth device/PKCE or api-key form

  refreshAuth(account: ProviderAccount): Promise<ProviderAccount>;

  /** Main streaming entry point. Returns an async iterator of normalized events. */
  stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamEvent>;

  /** Optional: embeddings for memory/indexing. */
  embed?(req: EmbedRequest, ctx: CallContext): Promise<EmbedResponse>;

  /** Optional: media generation. */
  generateImage?(req: ImageRequest, ctx: CallContext): Promise<ImageResponse>;

  countTokens?(req: ChatRequest): Promise<number>;
}

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  audioIn: boolean; audioOut: boolean; realtime: boolean;
  reasoning: false | 'levels' | 'budget';
  promptCache: 'none' | 'short' | 'long' | 'both';
  structuredOutput: boolean;
  imageGeneration: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
}
```

### Normalized streaming events

```ts
type StreamEvent =
  | { type: 'start'; messageId: string; model: string }
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argsDelta: string }
  | { type: 'tool_call_end'; index: number; args: unknown }
  | { type: 'citation'; url: string; title?: string; snippet?: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; cachedTokens?: number; costUsd?: number }
  | { type: 'stop'; reason: 'end' | 'tool_calls' | 'length' | 'cancelled' | 'error'; error?: AgentError };
```

## 3. Supported providers (v1)

| Provider | Auth | Streaming | Tools | Vision | Reasoning | Cache |
| --- | --- | --- | --- | --- | --- | --- |
| **Anthropic** | API key, OAuth | ✓ | ✓ | ✓ | levels/budget | short+long |
| **OpenAI** | API key, OAuth | ✓ | ✓ | ✓ | levels | short |
| **Google (Gemini)** | API key, OAuth | ✓ | ✓ | ✓ | budget | short |
| **OpenRouter** | API key | ✓ | ✓ (passthrough) | ✓ | passthrough | none |
| **Mistral** | API key | ✓ | ✓ | partial | none | none |
| **Local (llama.cpp / Ollama)** | none | ✓ | limited | partial | none | none |
| **OpenAI-compatible** | API key + base URL | ✓ | ✓ | per-server | none | none |

Adapters for Anthropic and OpenAI are P0; Google/OpenRouter and the OpenAI-compatible
generic adapter are P1; local is P1 (bundled `llama.cpp` server optional; Ollama detection).

## 4. Authentication

- **API key**: collected in a secure input, stored via keychain (`secret_ref`), never shown
  again; a "rotate" action replaces it.
- **OAuth**: PKCE (desktop) with a loopback redirect; or device-code flow. Tokens refreshed
  automatically; failures surface a re-auth card.
- **Local**: no auth; detect a running server at configured URL; health check.
- Credentials are only accessed in the main/core process. The renderer receives status only.

## 5. Request normalization

Internal `ChatRequest`:

```ts
interface ChatRequest {
  model: string;              // resolved native id
  messages: NormalizedMessage[];
  tools?: ToolSchema[];
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  temperature?: number; topP?: number; maxTokens?: number;
  reasoning?: { level: 'off'|'minimal'|'low'|'medium'|'high'|'xhigh'|'max' } | { budgetTokens: number };
  responseFormat?: { type: 'text' } | { type: 'json_schema'; schema: unknown };
  cacheHints?: { system?: boolean; tools?: boolean; history?: boolean };
  metadata?: Record<string, string>;
  signal: AbortSignal;
}
```

Adapter responsibilities: map normalized messages/tools to the vendor wire format; map
vendor errors to `AgentError`; map usage/cost; honor `signal`; emit normalized events.

## 6. Reasoning levels

Levels map to provider-specific settings:

| Nova level | Anthropic | OpenAI | Gemini | Local |
| --- | --- | --- | --- | --- |
| off | thinking disabled | reasoning_effort none | thinking off | off |
| minimal/low/medium/high | budget tokens scaled | low/medium/high | budget scaled | n/a |
| xhigh/max | max budget | high (max if supported) | max budget | n/a |

The effective level is stored per message and shown in the UI. Models that do not support
reasoning hide the selector (FR-024).

## 7. Tool calling

- Tools are described once via JSON Schema and converted per provider.
- Parallel tool calls are supported where capable; otherwise serialized with a note.
- Streaming tool arguments are accumulated and validated against the schema before execution.
- Errors from tool execution are returned to the model as structured `tool_result` parts with
  `is_error: true`, never thrown into the stream.
- **MCP tools** and **plugin tools** are namespaced `server.tool` / `plugin.tool` to avoid
  collisions; the model sees a stable canonical name.

## 8. Virtual models (presets)

A virtual model is a named configuration:

```json
{
  "alias": "fast-local",
  "strategy": "single",
  "target": { "provider": "local", "model": "qwen2.5-coder:14b", "reasoning": "off" }
}
```

Strategies:

- `single` — one target.
- `fallback` — ordered targets; move to next on transient error/rate limit/timeout.
- `cheapest` / `best` — pick target by cost or capability for the request class.
- `parallel` — (P2) run N targets and return the first acceptable or a vote.

Virtual models appear in the picker alongside native models and are fully local.

## 9. Routing, retries, and limits

- **Circuit breaker** per provider account: open after N consecutive failures; half-open probe.
- **Retry** with exponential backoff + jitter for 429/5xx/network; respect `Retry-After`.
- **Timeouts**: connect 10 s, idle stream 90 s (configurable), total per-request cap.
- **Concurrency**: global semaphore + per-provider limit; queue with visible status.
- **Rate limit/over budget**: surface a non-destructive banner; offer to switch model or wait.
- **Cancellation**: `AbortSignal` propagates; partial output retained and marked incomplete.

## 10. Prompt caching

- Compute a stable cache key over the system prompt, tool schema, and message prefix.
- Set provider cache hints when supported; persist the cache breakpoint in the thread.
- Never cache content that includes secrets or temporary chats.
- Report cached-token savings in usage insights.

## 11. Cost & usage accounting

- Every streamed response writes a `usage_event` with input/output/cached tokens, latency,
  provider, model, and an estimated cost from `model_pref.cost_*` (user-overridable).
- Aggregations power FR-114 (profile insights) and FR-116 (spend caps).
- For local models, cost is 0 but token counts and latency are recorded.

## 12. Local models

- Detect **Ollama** (`/api/tags`) and **llama.cpp server** (`/v1/models`) automatically.
- Allow a user-configured base URL for any OpenAI-compatible endpoint.
- Download/management of GGUF models is post-v1; v1 links to the user's installed server and
  provides a "test connection" flow.
- Local embeddings for the index run through the same adapter interface.

## 13. Media

- **Image input**: downscale/convert as needed; strip EXIF location by default (privacy).
- **Image generation**: provider-dependent; saved as artifacts with prompt metadata.
- **Voice**: realtime adapter for providers offering it; otherwise STT → chat → TTS pipeline.
  Audio buffers are never persisted unless the user opts in.

## 14. Errors

```ts
type AgentErrorCode =
  | 'auth_missing' | 'auth_expired' | 'rate_limited' | 'over_budget'
  | 'context_length' | 'content_filter' | 'timeout' | 'network'
  | 'invalid_request' | 'provider_error' | 'cancelled' | 'unsupported';
```

Each error carries: code, message (user-safe), provider detail (redacted), retryable flag,
and a suggested action (e.g., "Switch model", "Reconnect account", "Reduce context").

## 15. Contract tests

- **Recorded fixtures** per provider for streaming, tool calls, errors, and usage.
- A `ProviderConformance` test suite runs against every adapter with a mock server.
- Live smoke tests (opt-in, env-gated) verify real auth + one round trip; never in CI by
  default.
- Adding a provider requires: adapter, capability matrix, fixtures, conformance pass, docs.
