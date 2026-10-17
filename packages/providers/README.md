# @nova/providers

The provider adapter contract (`docs/07` §2): normalized `ChatRequest` and `StreamEvent` types,
`collect()` to fold a stream (keeping partial output on cancel, FR-018), and two adapters:

- `MockProvider` — deterministic, with scripted transcripts, timing control and error
  injection; used by tests, E2E journeys and the offline "Mock (offline)" account (`docs/16` §4).
- `OpenAICompatibleProvider` — chat completions over SSE with plain `fetch`, for kinds
  `openai` (default `https://api.openai.com/v1`), `ollama` (default
  `http://127.0.0.1:11434/v1`) and `openai_compatible` (any base URL). `reasoning` /
  `reasoning_content` deltas become reasoning, never content; tool-call fragments are
  accumulated and parsed at the end; usage is requested with `stream_options.include_usage`.
  Errors map to the `docs/07` §14 codes (401/403 → `auth_expired` or `auth_missing`, 429 →
  `rate_limited` or `over_budget`, context overflow → `context_length`, 5xx and network →
  retryable). Retries (2, exponential backoff with jitter, honouring `Retry-After`) happen only
  before the first byte. Connect timeout 10 s, idle-stream timeout 90 s. `stream()` never
  throws: every outcome ends with a `stop` event, and the API key is scrubbed from any server
  message. `listModels()` uses `/models`, falling back to Ollama's `/api/tags`.

Fixtures for the adapter conformance tests are recorded SSE streams in `fixtures/openai/`.
