# Slice 10-pre — Cloud provider registry

Parent: the Master Roadmap, §S10-pre (added 2026-09-02 at Jeremy's request;
prerequisite for S10's routing/spend and S10a's cloud catalog). Inputs: the
gateway as S1/S2e left it (ONE `backend_config` row, "cloud" = one
OpenAI-compatible URL + key), v3's [[llm-provider-registry]] shape
(`slug:model`, one OpenAI-compat client — mined, not ported), and the
frontier check below. Slice type: ADDITIVE (gateway registry + adapters, two
small core changes, one new settings section). Size: M. Owner gate: the DoD
walk needs an OpenRouter key and an Anthropic key, which only the owner holds.
Lane: branch `slice/s10pre` in `.worktrees/s10pre`, off `rebuild/v4` at
25d5fc98; merges back into `rebuild/v4` when green.

Goal: the owner adds ANY provider as data — a name, a base URL, an auth shape
and a key — and its models are DISCOVERED, picked, chatted with and badged,
with no code change per vendor. Vendors are not the unit; PROTOCOLS are.

## Frontier facts (verified 2026-09-05, live docs + one live call)

- **Azure OpenAI v1 (GA since Aug 2025):** base `https://<resource>.openai.
  azure.com/openai/v1/` (also `<resource>.services.ai.azure.com/openai/v1/`),
  `api-key: <key>` header OR `Authorization: Bearer <Entra token>`, the body's
  `model` is the DEPLOYMENT name, no `api-version` parameter. Chat Completions
  is served for third-party models (DeepSeek, Grok) and OpenAI models alike.
  → plain OpenAI chat with an `api-key` header. Not a separate adapter.
- **AWS Bedrock:** `https://bedrock-runtime.<region>.amazonaws.com/openai/v1`
  with `Authorization: Bearer $AWS_BEARER_TOKEN_BEDROCK`; `GET …/openai/v1/
  models` EXISTS (the roadmap text said it did not — corrected); model ids
  carry a vendor prefix (`openai.gpt-oss-120b`). A second host,
  `bedrock-mantle.<region>.api.aws/v1`, is the same protocol. → plain OpenAI
  chat with a bearer key, region-templated preset. Not a separate adapter.
- **Gemini compat:** `https://generativelanguage.googleapis.com/v1beta/
  openai/`, bearer key, `/models` works, streaming + tools work, "still in
  beta" (preset carries the caveat).
- **OpenRouter:** `GET https://openrouter.ai/api/v1/models` is UNAUTHENTICATED
  and returned 431 rows on 2026-09-05, each with `context_length`,
  `pricing.{prompt,completion}` (USD per token, strings), `architecture`,
  `supported_parameters`, `top_provider.max_completion_tokens`. Anthropic
  models appear as `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`,
  `anthropic/claude-fable-5.1`. Chat base: `https://openrouter.ai/api/v1`.
- **Anthropic Messages API:** `POST /v1/messages` with `x-api-key` +
  `anthropic-version: 2023-06-01`; `max_tokens` REQUIRED; `system` is a
  top-level field; tools are `{name, description, input_schema}`; assistant
  tool calls are `tool_use` content blocks `{id, name, input}`; results go
  back as `tool_result` blocks `{tool_use_id, content}` in ONE user message
  (splitting them across messages is a documented anti-pattern). Streaming
  events: `message_start` (usage.input_tokens), `content_block_start`
  (`text` or `tool_use{id,name,input:{}}`), `content_block_delta`
  (`text_delta{text}` / `input_json_delta{partial_json}`),
  `content_block_stop`, `message_delta` (`delta.stop_reason` ∈ end_turn /
  tool_use / max_tokens / stop_sequence / refusal / pause_turn; cumulative
  `usage.output_tokens`), `message_stop`, `ping`, and `error`
  (`{"type":"error","error":{"type":"overloaded_error","message":…}}`).
  `GET /v1/models` lists `{id, display_name, created_at, …}` with
  `has_more`/`last_id` paging. Anthropic's own OpenAI-compat layer is stated
  "not production-ready" — hence the native adapter. Forced `tool_choice`
  (`any`/`tool`) is rejected by Fable 5.1: core never sends it; the adapter
  maps only `auto`/`none` and drops the rest with a span-visible note.
- **Consequence for the design:** the roadmap's "three genuine adapters"
  collapses to TWO wire protocols — `openai-chat` (OpenAI, OpenRouter, Groq,
  Cerebras, xAI, Mistral, DeepSeek, Together, Fireworks, DashScope, Gemini
  compat, Azure v1, Bedrock) and `anthropic-messages` — plus `ollama`, which
  is `openai-chat` for chat and `/api/tags` for listing. Vertex (OAuth2
  service-account tokens) stays deferred as the roadmap said.

## Definition of done (operator-visible, real stack, walked live)

1. Settings → Providers: pick the OpenRouter preset, paste one key → the
   row saves ONLY after the gateway verified it live → its model list
   appears (hundreds, live, with context length and price) → pick one → a
   chat turn answers and the reply is badged `openrouter:<model>`; the
   llm_call span carries `served_by=openrouter:<model>` and the token usage
   the provider reported.
2. Add an UNKNOWN OpenAI-compatible provider by base URL + key with no code
   change (walked with a second OpenRouter row under a different name, or
   any compat endpoint the owner has) → same flow.
3. Anthropic via the native adapter: key → `/v1/models` listing → pick
   `claude-opus-5` → a turn that CALLS A TOOL (read a workspace file, fetch
   a URL) round-trips: the tool call arrives as an OpenAI `tool_calls`
   fragment stream, core dispatches it, the result goes back as
   `tool_result`, the reply completes; badge `anthropic:claude-opus-5`.
4. A wrong key is refused at save with the provider's own reason; the row
   never lands. A provider whose `/models` is 404 (manual model ids) saves
   with "listing unavailable — type a model id" stated, never a fake
   empty list.
5. A model id whose provider prefix is not registered, or a provider deleted
   while selected, fails the turn with a STATED reason — never a silent
   fallback to another provider (rail 20).
6. `GET /admin/providers` never returns a key; logs never carry one
   (extends `test_secrets_not_logged`).
7. The wizard and Settings → Models keep working unchanged: bare model ids
   route to the default (bundled ollama) provider; `PUT /admin/backend`
   (the wizard's engine step) still saves through the registry.
8. Restart the gateway → providers, keys and the default survive (DB rows,
   not process state).

## Architecture

**Registry (gateway, migration 003).** `providers(name PK slug, adapter ∈
{ollama, openai-chat, anthropic-messages}, base_url, auth_shape ∈ {none,
static-bearer, api-key-header}, api_key, model_note, preset, builtin,
is_default, verified_at, listing ∈ {available, unavailable, unknown},
listing_note, created_at, updated_at)`; exactly one `is_default=true`
(partial unique index). The bundled `ollama` row is seeded at startup
(`builtin=true`, base_url resolved LIVE from OLLAMA_URL, never the column —
S1's rule kept), cannot be deleted, is the default until the owner picks
another. `backend_config` is CONVERTED by the migration (kind=remote → row
`remote`; kind=cloud → row named from its `provider` column or `cloud`, with
`/v1` appended to the stored URL since registry base URLs INCLUDE the
version path, the OPENAI_BASE_URL convention) and then dropped. Keys live in
the column exactly as `backend_config.api_key` did — the secrets store is a
later slice; masking + never-log are pinned.

**Model identity = `provider:model`.** The gateway resolves a request's
`model` by splitting on the FIRST colon: if the prefix names a registered
provider → that provider, remainder is the model; otherwise the WHOLE string
is a model on the default provider (so `qwen3.8:27b` keeps working, and so
does every `chat.model` value already stored). `X-Nova-Served-By` is always
the canonical `provider:model`. No substitution ever: an unregistered
explicit provider cannot occur (falls to default by construction), but a
provider that fails answers with its own status and reason, never another
provider's answer (pinned).

**Adapters (gateway/app/adapters/).** A small protocol: `headers(row)`,
`completions(app, row, body) → upstream response`, `relay(upstream) →
OpenAI SSE bytes`, `list_models(app, row) → Listing | ListingUnavailable`,
`verify(app, row)`. `openai-chat` is today's passthrough (byte relay,
mid-stream error chunk, identity-encoding guard) with the auth header derived
from `auth_shape` (`Authorization: Bearer` or `api-key`). `ollama` = the same
chat path against OLLAMA_URL + `/api/tags` listing. `anthropic-messages`
TRANSLATES: request (system fold, tool_calls → tool_use, tool messages →
one tool_result user message, tools → input_schema, max_tokens default
16000 when absent) and response (SSE events → OpenAI chunks: text deltas,
tool_use start → `tool_calls[{index,id,type,function{name,arguments:""}}]`,
input_json_delta → argument fragments, stop_reason → finish_reason
{end_turn:stop, tool_use:tool_calls, max_tokens:length, refusal:
content_filter}, usage → a final usage chunk, then `[DONE]`; an `error`
event → the OpenAI error chunk core already understands). Non-streaming
(`stream:false`, the probe path) translates the whole message. A non-200
Anthropic reply is relayed as `{"error":{"message","type"}}` with its status.

**Listing is DERIVED and labelled.** `GET /admin/providers/{name}/models`
fetches live and returns `{source: name, fetched_at, models: [{id, name?,
context_length?, pricing?{prompt,completion}}]}` — S10a's rail adopted now:
never an unlabelled number. A 404/405 on `/models` is `ListingUnavailable`
(the row records it; the UI offers a model-id field); a 401 is a REFUSAL
(bad key) and fails verify.

**Verify-before-save.** POST/PUT run the adapter's `verify`: the listing
call where the provider has one; where it does not (404/405), reachability +
auth are what was proven and the row says so. A verify that cannot prove the
key is a save that does not happen (502 with the provider's reason).

**Presets (`providers_presets.json`)** are convenience only: name, label,
adapter, base_url (with `{region}`/`{resource}` placeholders the UI fills),
auth_shape, docs_url, model_note, quirks. OpenRouter first; then OpenAI,
Anthropic, Groq, Cerebras, xAI, Mistral, DeepSeek, Together, Fireworks,
DashScope (intl/us/cn), Gemini-compat, Azure v1, Bedrock. Presets never gate
anything: "custom" is base_url + auth_shape + key + go.

**Core.** proxies.py forwards the six provider routes 1:1 (ruling R8: the
browser only talks to core). The turn stream gains one frame,
`{"served_by": "provider:model"}`, emitted when the gateway's header is read
(old clients ignore unknown frame keys by contract, S2-R6). Assistant rows
gain `turn_id` (migration 018) so `GET messages` can return `served_by`
DERIVED from the turn's last llm_call span — the badge on reload reads the
trace, never a stored claim.

**Web.** `ProvidersSection` in Settings (list, add-from-preset or custom,
verify-on-save with the stated reason, per-row live model list with
context/price, "Use" → `putSetting('chat.model', 'name:id')`, delete with
confirm; the ollama row is shown, not editable). `MessageBubble` shows the
served-by badge when present. `api.ts` gains the provider calls and the
`served_by` field. The ModelSelector is untouched (cloud picking lives in
Settings this slice; a grouped selector is S10's routing UI).

## Tasks

### T1 — Registry + openai-chat/ollama adapters + routing (M)
Migration 003 (convert + drop `backend_config`), `providers.py` (CRUD,
default, seed, mask), `adapters/{base,ollama,openai_chat}.py`, resolve in
`data_plane.py`, `PUT/GET /admin/backend` re-implemented over the registry,
admin routes for providers + presets + listing, `providers_presets.json`.
Tests: migration converts each legacy kind; routing by prefix / bare /
default; served-by canonical; verify refuses 401, accepts 404-as-manual;
delete refuses builtin and refuses the default; keys masked in every read
and absent from logs; probe/suggest/pull still read the default row.

### T2 — anthropic-messages adapter (M, the risk)
Request translation + streaming/non-streaming response translation, driven
through the gateway's real data plane against an ASGI fake Anthropic that
replays the documented event shapes (text, tool_use, error event, non-200).
Pinned: a two-round tool call round-trips byte-for-byte into core's
`ToolCallBuffer` shape; usage lands as an OpenAI usage chunk; `max_tokens`
always present; consecutive tool messages fold into one user message.

### T3 — core: passthroughs, served-by frame, turn-linked messages (S)
proxies.py routes; chat.py emits the frame and stores `turn_id`; migration
018; `GET messages` joins the served-by fact; tests through the real ASGI
turn against the fake gateway.

### T4 — web: Providers section + badge (M)
`ProvidersSection` + tests (DI seam like ModelsSection), `api.ts`,
`MessageBubble` badge, `streamChat` event, reducer. `SettingsPage` mounts
the section (one import + one element — the only shared-file edit).

### T5 — deploy + DoD walk (S)
Build gateway/core/web from HEAD, `up -d`, migrations auto-run; then the
owner's walk (DoD 1–8). Carries doc.

## Rails touched
5 (unverifiable step fails loudly: verify-before-save, listing labelled),
6 (badge derived from the trace), 10 (service token unchanged), 20 (no
silent cross-provider fallback — pinned), 19 (`test_secrets_not_logged`
extended, not routed around).

## Out of scope (named so they are not silently dropped)
Mode switch + spend meters (S10); live local catalog/provenance (S10a);
secrets store; Vertex OAuth2; grouped ModelSelector; wizard engine step
redesign (kept working via the registry-backed `PUT /admin/backend`).
