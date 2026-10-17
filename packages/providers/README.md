# @nova/providers

The provider adapter contract (`docs/07` §2): normalized `ChatRequest` and `StreamEvent` types,
`collect()` to fold a stream (keeping partial output on cancel, FR-018), and the adapters.
Every adapter uses plain `fetch` + SSE (no vendor SDK), resolves its key per request, honours
the account's base URL (falling back to `DEFAULT_BASE_URLS`), and never throws from `stream()`:
every outcome ends with a `stop` event, and the key is scrubbed from any server message.

- `MockProvider` — deterministic, with scripted transcripts, timing control and error
  injection; used by tests, E2E journeys and the offline "Mock (offline)" account (`docs/16` §4).
- `OpenAICompatibleProvider` — chat completions for kinds `openai`
  (`https://api.openai.com/v1`), `openrouter` (`https://openrouter.ai/api/v1`), `ollama`
  (`http://127.0.0.1:11434/v1`), `llamacpp` (`http://127.0.0.1:8080/v1`, no key) and
  `openai_compatible` (any base URL). Local server kinds accept their bare address and add `/v1`.
  `reasoning` / `reasoning_content` deltas become reasoning, never content; tool-call fragments
  are accumulated and parsed at the end; usage is requested with `stream_options.include_usage`.
  Reasoning levels (`docs/07` §6): OpenAI gets `reasoning_effort` (off → `none`, xhigh/max →
  `high`); OpenRouter gets its `reasoning` object passed through (off → `{enabled: false}`,
  budgets → `max_tokens`); local kinds ignore it. Model lists: OpenAI's ids get per-family
  vision/reasoning flags; OpenRouter's modalities, supported parameters and prices are read;
  local kinds fall back to Ollama's `/api/tags`.
- `AnthropicProvider` — the Messages API (`x-api-key`, `anthropic-version: 2023-06-01`) at
  `<base>/v1/messages` and `<base>/v1/models` (default base `https://api.anthropic.com`; `/v1` is
  added when missing). The system prompt is split out; content maps to text / image /
  tool_use / tool_result blocks, consecutive same-role turns are merged and empty text is
  dropped. Thinking follows the model generation, from the models endpoint's reported
  capabilities when present, else the id: 4.6 and later use adaptive thinking with
  `output_config.effort` (levels map to low…max, clamped to what the model supports; "off"
  omits thinking, or uses the lowest effort where thinking cannot be disabled); 3.7 to 4.5 use
  `budget_tokens` (minimal 1024, low 2048, medium 8192, high 16384, xhigh/max 32000, kept below
  `max_tokens`); older models ignore reasoning. Sampling parameters and forced tool choice are
  dropped where the model or thinking rejects them. `speed: 'fast'` adds the fast-mode beta on
  the models that have it. Cache hints place `cache_control` breakpoints. Errors: 401/403 →
  `auth_missing`, 402 → `over_budget`, 429 → `rate_limited`, 529/5xx → retryable
  `provider_error`, 400 → `invalid_request` (or `context_length`), refusal → `content_filter`.

Shared behaviour (`docs/07` §9, §14): connect timeout 10 s, idle-stream timeout 90 s, retries
(default 2, exponential backoff with jitter, honouring `Retry-After`) before the first byte
only. When a retry is not waited out, the error carries `retryAfterMs`. The Hub builds its
adapters with `maxRetries: 0` because its router retries and falls back instead.

Tests: `test/conformance.ts` is the shared `ProviderConformance` suite (streaming text,
reasoning, tool calls, usage, error mapping, Retry-After, cancellation, images, dropped
connections, model lists) run for every kind against a local fake server replaying the recorded
fixtures in `fixtures/openai/` and `fixtures/anthropic/`.
