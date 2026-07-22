# Named local-inference endpoints — multi-backend

> **SUPERSEDED / CLOSED (2026-07-22).** Shipped, broader, as the LLM **provider
> registry** — commit `68b9e72`. This plan was local-only (`local:name/model`);
> the delivered feature covers cloud **and** local under one `slug:model`
> scheme via a DB-backed `llm_providers` registry (`backend/app/llm/providers.py`,
> migration `042_llm_providers.sql`) and the Settings → Models → **Providers**
> UI. LM Studio / vLLM / llama.cpp are covered by the built-in presets; a single
> `OpenAICompatClient` serves every provider. Persistent reachability (this
> plan's health/last_error dots) also shipped. Kept below for the still-useful
> traps (host.docker.internal, LM Studio server-first, the 11434 shadow).
> Not carried over: block-delete-when-pinned (the registry uses graceful local
> fallback instead).

Implementation plan (authored 2026-07-15 with Fable). Goal: users run LM
Studio, llama.cpp, vLLM — not just Ollama. All serve OpenAI-compatible
APIs (our existing client already speaks it); only Ollama has a pull API
(the others manage their own downloads). The pull/list tool contracts are
already backend-scoped in anticipation — this plan adds the registry
those scopes point at.

## Design

### Data model

New table `inference_endpoints` (next free migration):
- `name text unique` — user-facing handle ("lmstudio", "workstation-vllm")
- `kind text` — `ollama | openai_compat` (kind gates capabilities:
  pull/delete only for ollama)
- `base_url text` — e.g. `http://host.docker.internal:1234/v1`
- `enabled bool`, `api_key text null` (some vLLM deploys want one; stored
  via the admin-secrets pattern, never echoed to the UI after save)
- `created_at`, `last_seen_at timestamptz null`, `last_error text null`

Seed migration: the bundled ollama entry (the Phase-1 pool work already
seeds a bundled-ollama row — CONVERGE with that, don't create a parallel
registry; if the pool's table already fits, extend it instead of adding a
twin. Check `backend/app/migrations/` 015–018 and the pool code before
writing the migration — this is the one open codebase question in this
plan).

### Model addressing

Today models address as `ollama:<model>` / openrouter ids. Extend to
`local:<endpoint-name>/<model>` for non-bundled endpoints; `ollama:` stays
as an alias for the bundled endpoint (no breaking rename — every stored
agent model string keeps working). `effective_model` in
`backend/app/llm/router.py` resolves the endpoint name → base_url and
hands the OpenAI-compat client the right base + key.

### Health / discovery

- On save and on a 60 s cycle (leader-only once remote-shared-state
  lands): `GET {base_url}/models` — update `last_seen_at`/`last_error`
  and cache the served model list.
- `list_models` tool + `/api/v1/models?full=true` grow an `endpoint`
  field; the Models page groups by endpoint with reachability dots
  (operator-visible outcomes rule: an unreachable endpoint shows WHY —
  the stored `last_error` — not just a red dot).
- LM Studio trap (known, in memory): it's never GPU-detectable and hides
  behind its own UI; docs copy should say "start the LM Studio server
  first". Host-reachability trap: from inside compose,
  `localhost` is the container — docs + UI placeholder must suggest
  `host.docker.internal` (and the compose file needs
  `extra_hosts: host-gateway` on backend if not already present).
  The container-shadows-host Ollama port trap (11434) is documented in
  memory — surface it in the endpoint form's help text.

### UI

Settings → Inference (or the Models page — wherever the bundled-inference
controls already live; follow the existing pattern): endpoint list + add/edit
form (name, kind, url, key, test button that calls the health check
inline). `_require_edit_mode` gates writes. Pull buttons render only for
`kind=ollama` endpoints.

### Chains/pools interaction

Phase-2 of the models plan (role→chains) composes on top: a chain entry
can reference any endpoint's model. Keep this plan independent — registry
+ addressing + health only. Don't build chain logic here.

## Phases

1. Registry table (or pool-table extension — resolve the convergence
   question first), CRUD API, Settings UI with test button. Verify: add a
   real LM Studio endpoint from the UI, green dot, models listed.
2. `local:` addressing through `effective_model` + agent model dropdown
   grouped by endpoint. Verify: assign an agent a LM Studio model, chat
   through :5173, answer arrives; unplug the endpoint, next turn fails
   with a readable error naming the endpoint.
3. Tools: scope `pull_model`/`list_models` by endpoint param; model-
   manager can list any endpoint, pull only on ollama kinds. Verify via
   chat-driven tool calls.

## Traps

- Never let a saved api_key round-trip to the browser (write-only field,
  masked display).
- Endpoint deletion with agents pinned to its models: block with a clear
  error listing the pinned agents (no silent fallback — accuracy-first,
  per the llm-gateway lane's philosophy).
- Timeouts: local endpoints on sleeping laptops hang — 3 s connect
  timeout on health, 10 s on first token, and the failure path must
  surface in chat as a normal error event, not a stalled stream.
