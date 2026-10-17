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
  fastTier: boolean;                       // a faster serving tier can be requested
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
  automatically; failures surface a re-auth card. OAuth is offered only where the provider
  publishes a flow for third-party applications, using a client id registered to Nova (or one
  the user registers for a self-hosted Hub).
- **No borrowed clients** (ADR-080, `docs/19` §5): Nova never reuses another application's
  OAuth client id, never presents itself as another client, and never offers sign-in with a
  subscription plan through another application's client or credentials.
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
  speed?: 'standard' | 'fast'; // 'fast' only when capabilities.fastTier is true
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
reasoning hide the selector (FR-024), and the router removes the parameter for them.

- **Anthropic.** Newer models take adaptive thinking with an effort level (with summarized
  reasoning so it can be shown); older ones that support it take `budget_tokens` scaled by
  level. A model that cannot turn thinking off maps `off` to its lowest effort. Sampling
  parameters a model rejects with thinking on are dropped, and a forced tool choice becomes
  `auto`. `speed: fast` uses the provider's fast mode where the model offers one.
- **OpenAI** maps levels to `reasoning_effort`; `xhigh`/`max` send `high`. **OpenRouter** passes
  reasoning through. Local kinds ignore reasoning.

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

### 8.1 Model presets (FR-221)

The simple model control is an ordered scale of presets from **Faster** to **Smarter**
(default three: Faster, Balanced, Smarter; Balanced selected). Each preset is a virtual model
whose target fixes provider, model, reasoning level and speed:

```json
{
  "alias": "preset:smarter",
  "strategy": "fallback",
  "preset": { "rank": 3, "label": "Smarter" },
  "targets": [
    { "provider": "anthropic", "model": "<configured-model-id>", "reasoning": "high", "speed": "standard" },
    { "provider": "local", "model": "<installed-local-model>", "reasoning": "medium" }
  ]
}
```

- Presets are generated at setup from the configured providers and are editable. An advanced
  panel shows and edits each preset's underlying choices. Until the user saves their own list
  (`models.presets`), the built-in three are regenerated from the models available now: chat
  models are scored by size markers in their ids (small, large, parameter counts) and reasoning
  support; Faster takes the lowest score, Smarter the highest, Balanced the middle; reasoning
  levels are off, medium and high; each falls back to a model of a different account or node
  when one exists. The offline Mock provider is used only when nothing else is configured.
- A preset whose targets are all unavailable is disabled with a tooltip; it never silently
  falls back to a different preset.
- Each assistant turn stores the preset and the resolved model and reasoning level (FR-023).
- **Presets never spawn sub-agents.** Delegation stays an explicit, visible tool call
  (`docs/09` §4).

## 9. Routing, retries, and limits

- **Router.** Every turn resolves its model reference through one router
  (`packages/core/src/routing`): `<accountId>/<modelId>`, `node:<nodeId>/<modelId>` or
  `preset:<id>` becomes an ordered list of targets. For local models the router also gathers
  the other local places serving the same model and orders all candidates by `routing.order`
  (FR-127). With `routing.allowCloud` off, every cloud target is dropped; OpenAI, Anthropic and
  OpenRouter accounts always count as cloud, and other kinds count as local only on loopback,
  private, `.local`/`.lan`/`.ts.net` or CGNAT hosts. A route with no target left fails closed.
- **Circuit breaker** per provider account or node: open after 3 consecutive transient
  failures; half-open probe after 30 s. Request errors (auth, invalid request, context length,
  content filter) do not count.
- **Retry** with exponential backoff + jitter for 429/5xx/network, at most 2 per target; respect
  `Retry-After` up to 10 s, else move to the next target. Retries live in the router, so
  adapters are built with their own retries off. Retry and fallback happen only before the first
  content event; after that an error ends the turn (ADR-089).
- **Timeouts**: connect 10 s, idle stream 90 s (configurable), total per-request cap.
- **Concurrency**: global semaphore + per-provider limit; queue with visible status.
- **Rate limit/over budget**: surface a non-destructive banner; offer to switch model or wait.
- **Cancellation**: `AbortSignal` propagates; partial output retained and marked incomplete.
- **Transport** (adapter-internal): where a provider offers a persistent socket transport, an
  adapter may open it lazily on a turn's first request, reuse it for that turn's later steps
  (sending incremental requests that reference the previous response), and fall back to HTTP
  streaming when the socket fails. The normalized event stream is identical either way, and the
  conformance suite (§15) runs both paths.

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

- Detect **Ollama** (`/api/tags`) and **llama.cpp server** (`/v1/models`) automatically
  (`GET /api/v1/providers/detect`: 127.0.0.1:11434, 127.0.0.1:8080 and any base URLs in
  `NOVA_DETECT_URLS`; 1.5 s per probe; no credentials; redirects refused).
- Allow a user-configured base URL for any OpenAI-compatible endpoint.
- Download/management of GGUF models is post-v1; v1 links to the user's installed server and
  provides a "test connection" flow.
- Local embeddings for the index run through the same adapter interface.

## 13. Media

- **Image input**: downscale/convert as needed; strip EXIF location by default (privacy).
- **Image generation**: provider-dependent; saved as artifacts with prompt metadata.
- **Voice** (FR-031): realtime adapter for providers offering it; otherwise STT → chat → TTS
  pipeline. Push-to-talk and hands-free, streaming transcription, barge-in and voice selection.
  Audio buffers are never persisted unless the user opts in.
  - **Voice as controller**: voice can start, check and steer runs and sessions in any mode. It
    uses the same Hub API calls as the UI (start, steer per FR-019, status), and its transcript
    appears in the thread. Spoken requests pass the policy engine like typed ones. Approvals
    are never granted by voice alone: the approval card is answered on a client screen.
  - **One session per user**: a user has at most one active voice session. Starting one on
    another device ends the previous session, which is told why.
- **Dictation** (FR-216): speech-to-text into the composer with punctuation cleanup and a user
  dictionary. Local STT engines are the default; audio is not stored. The text stays editable
  in the composer and is sent only when the user sends it.

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
