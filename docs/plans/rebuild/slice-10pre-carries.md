# Slice 10-pre — Cloud provider registry: close-out and carries

Plan: slice-10pre-providers.md. Commits on `slice/s10pre`, merged into
`rebuild/v4` at 4e7ed03c on 2026-09-05: T1+T2 ad5ed63b (gateway registry +
adapters), T3 edaa7d77 (core badge + passthroughs), T4 5a6af9b5 (web).

## What shipped

- **Providers are data.** `providers` (gateway migration 003): name, adapter,
  base_url, auth_shape, key, default_model, listing state. The builtin
  `ollama` row is seeded at startup and resolves its address live from
  OLLAMA_URL. Exactly one default (partial unique index) — the provider a
  BARE model id routes to. The S1 `backend_config` row was converted (remote
  → `remote`, cloud → its provider slug or `cloud`, `/v1` appended) and the
  table dropped; `PUT/GET /admin/backend` (the wizard's engine step) is a
  derived VIEW over the registry, unchanged on the wire.
- **Two wire protocols, not N vendors.** Frontier check 2026-09-05: Azure's
  v1 surface and Bedrock's runtime endpoint are plain OpenAI chat with a
  bearer or `api-key` header, and Bedrock DOES serve `GET /models` (the
  roadmap text said it did not). So `openai-chat` covers OpenAI, OpenRouter,
  Groq, Cerebras, xAI, Mistral, DeepSeek, Together, Fireworks, DashScope,
  Gemini compat, Azure, Bedrock; `anthropic-messages` is the one translating
  adapter (system fold, tool_use/tool_result, streamed input_json_delta →
  indexed OpenAI tool_calls fragments, usage chunk, stop_reason map, error
  event → the OpenAI error chunk core already reads). Vertex (OAuth2) stays
  deferred.
- **Model identity `provider:model`**, split on the FIRST colon against the
  LIVE provider-name set, so `qwen3.8:27b` still reads bare. The gateway's
  `X-Nova-Served-By` is always canonical; core puts it on the llm_call span
  as before, emits ONE `served_by` frame per answered turn, and links
  assistant rows to their turn (core migration 018) so `GET messages`
  returns the badge DERIVED from the span — never a stored claim.
- **Verify-before-save with the provider's own words.** A 401 refuses the
  save; a 404/405 on `/models` saves as `listing=unavailable` with the note
  "type a model id"; every listing is labelled `{source, fetched_at}`.
- **No silent substitution (rail 20).** A provider's failure is relayed with
  its own status; pinned by a test that proves ollama never saw the request.
- **Web:** Settings → Providers (presets fill, custom is URL + auth + key,
  placeholder presets cannot save unfilled, live listing with context/price
  only where stated, manual model id when unlisted, Use → `chat.model`,
  Remove with confirm, Make default) and the reply badge in the bubble.
- Suites: gateway 186 (was 138), core 1367, web 396 (was 343), tsc clean.

## Owner-owed (the DoD walk)

1. Settings → Providers → OpenRouter preset → key → list appears → Use one →
   a chat turn badges `openrouter:<model>`; Activity's llm_call span carries
   `served_by` and the provider's token usage.
2. Anthropic preset → key → pick `claude-opus-5` → a turn that reads a
   workspace file or fetches a URL round-trips through a tool call.
3. A wrong key at save is refused in the provider's words.
4. AI Quality re-measure on a cloud model (the harness takes any model id
   the gateway routes, so `openrouter:…` works there too — unverified live).

## Carries

- **The pre-commit hook targets v3's `frontend/`** (`.githooks/pre-commit`
  runs `npm --prefix frontend`), which has no node_modules in a fresh
  worktree, so every v4 commit either skips it (NOVA_SKIP_HOOKS=1, loud) or
  runs v3's checks. It should run `apps/web` typecheck + vitest and the
  three service ruff checks. Small, S16 (installer/updater polish) or sooner.
- **Wizard engine step.** The onboarding wizard still speaks S1's
  {kind, url, provider, model, api_key}; it works through the view, but the
  registry is the real model. Fold the wizard's cloud step into "pick a
  preset + key" (S10 UI).
- **ModelSelector (chat input) lists local models only.** Cloud picking
  lives in Settings → Providers this slice; a grouped selector (local /
  each provider) is S10's routing UI. The selector shows a
  provider-qualified current model correctly; it just cannot pick one.
- **Settings → Models "Current" marker** compares bare slugs, so with a
  provider-qualified `chat.model` no local row is marked current (correct,
  but the section could say "current model is openrouter:…").
- **Usage for openai-chat providers** is recorded only when the provider
  volunteers it in the stream; the gateway does not inject
  `stream_options.include_usage` (some providers reject unknown params).
  S10's meters should measure per provider and add it where supported.
- **Anthropic adapter, media:** image/audio content parts are dropped with
  a translation note in the gateway log; there is no vision path anywhere
  in v4 yet (S7/S12).
- **Anthropic adapter, prompt caching:** no `cache_control` breakpoints are
  set. Core's system prompt + tool list are a stable prefix; S10 (spend)
  should add a breakpoint after `tools`/`system` and read
  `cache_read_input_tokens` into the span.
- **Listing pagination bound:** the Anthropic listing loop stops after 20
  pages of 1000 — a hard ceiling stated in code; today's list is ~a dozen.
- **`GET messages` badge subquery** is a correlated subquery per row; fine
  at chat sizes, revisit if transcripts grow past thousands of rows.
- **Secrets store** (a later slice) should take over `providers.api_key`;
  until then the key is stored as `backend_config.api_key` always was
  (masked on every read, never logged — pinned).
- **`legacy_view.url` strips a trailing `/v1`** so the wizard sees its
  origin back; a provider whose base URL genuinely ends in `/v1/v1` would
  round-trip wrong through the S1 view only (not through the registry).
