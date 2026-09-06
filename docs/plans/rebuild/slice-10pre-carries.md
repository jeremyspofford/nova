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
- Suites after the fix wave: gateway 202 (was 138), core 1367, web 422 (was 343),
  tsc clean.

## Review fix wave (2026-09-05, opus whole-branch adversarial review: SHIP WITH FIXES)

Six findings fixed, all pinned by tests:

1. **Anthropic request invariants.** The Messages API rejects a first
   message that is not `user`, non-alternating roles, an empty array, and a
   `tool_result` with no `tool_use` in the request — and core's history
   window (8000 chars, newest-first, reversed) hands us an assistant row
   first about half the time once a conversation is long enough. The
   adapter now NORMALISES before sending (`normalize_messages`): leading
   assistant dropped, consecutive same-role merged into one message of
   blocks, orphan tool_results carried as text, an empty result refused
   here as a 400 rather than sent. `FakeAnthropic` now enforces the same
   rules, so the suite is load-bearing where it was not.
2. **The key is proven, not just the listing reached.** OpenRouter's
   `/models` is public, so a wrong key "verified". Verify now re-asks
   `/models` with a certainly-wrong key; if that also answers 200 the
   listing proved nothing, and a 1-token completion on the first listed
   model — through the same adapter a turn uses — is the proof: 401/403
   refuses the save, any other failure is stated on the row's
   `listing_note` ("the key is NOT proven; the first chat turn will tell").
3. **Every UI writes `ollama:<tag>`, never a bare id.** A bare id routes to
   the DEFAULT provider, which this slice made movable; Settings → Models,
   the chat ModelSelector and the Providers section all qualify now, and
   "current" comparisons accept a pre-registry bare value. Display stays
   the bare tag for local models.
4. **A provider name that is a local tag's prefix is refused** (`mistral`
   vs `mistral:7b`) — checked against what the bundled ollama LISTS at
   create time; an unreadable listing refuses the check loudly.
5. **Anthropic base URL includes `/v1`** like every other adapter (paths
   are `/messages`, `/models`); a bare origin typed for that adapter gets
   `/v1` appended; the form hint is adapter-specific.
6. **Sampling params dropped with a note** (a 400 on current Claude models).

Also: the listing's `max_tokens` (output cap) is remembered per model and
clamps a later completion; a listing that pages past 20×1000 rows is
refused rather than reported partial; `openrouter:` (a prefix and no
model) is a 400, never routed elsewhere; a refused listing is recorded on
the row (`listing=unknown` + the refusal); the caller's body is no longer
mutated; the create route checks duplicates before any verify round-trip;
the manual model-id input's label is unique per row.

Not changed, by decision: `api_key: ""` on an update keeps the stored key
(the form sends only changed fields; absent and empty both mean "keep");
`backends._origin` still strips only a trailing `/v1`, so the S1 wizard
view cannot re-save a default provider whose base URL ends otherwise
(gemini's `/v1beta/openai`) — it fails loudly, and the wizard step is a
carry below; the badge subquery per message row stays (fine at chat
sizes); a turn deleted by retention drops its badge (never invented).

## Owner walk 2026-09-06 and the second fix wave

Jeremy added his OpenRouter key and reported: "I don't know if it's
working, nor can I see or select any models." The gateway had verified the
key (a 1-token completion) and listed 430 models; the page showed neither
a verdict nor an obvious way to open the list (the provider NAME was the
click target). Fix 30443b5a: an explicit Show models / Hide models button
(Pick a model when unlisted), a verdict line, the new row opens itself,
and the key probe spends its token on the cheapest listed model.

A 70-agent adversarial workflow (four lenses, two refuters per finding; 33
raised, 21 survived) then found the fix's own critical: the verdict line
read `listing_note`, which EVERY listing fetch rewrites — and the auto-open
fetches within a second of the save — so "the key was proven…" became
"430 models listed" on the server at once, and a refused-later key would
have rendered a green "Verified". Also: amber-vs-green was a substring
match on prose; a 404 listing painted green with the key never sent
anywhere; `cheapest_model` ranked OpenRouter's `-1` router rows first
(`openrouter/auto`, verified on the live list); a 200 carrying an SSE
error frame counted as a proof; the wizard path saved no verdict.

Second wave (gateway migration 004): the verdict is ITS OWN STATE —
`key_proven` (true / false / NULL = never tested) + `verify_note`, written
only by a save and never by `record_listing`; every adapter returns a
structured `VerifyResult.key_proven` (Anthropic's listing needs the key →
true; ollama → NULL; no listing → NULL and "the key was not tested");
the probe requires a body with `choices` and no `error`; prices rank only
when finite and > 0 for BOTH fields; the wizard's PUT stores the same
verdict. Web: the line branches on `key_proven` ("Key verified" green /
"Checked" amber or neutral), a separate amber line shows a refused
listing, the row re-reads its server state after each listing fetch, and
the copy no longer says "press Use" over an empty list. Suites: gateway
207, web 432 (the refuted 12 were StrictMode double-fetch, taste, and
already-handled cases — recorded in the workflow journal).

LESSON (again): a UI line that composes "success" from two server fields
with different lifetimes is a claim the server never made. One field, one
writer, one meaning.

## Third wave (2026-09-06, the second refute pass — 5 findings, all fixed)

The refuters of the second workflow hit a session limit, so its five
lifecycle findings stand unrefuted and were fixed as T0 of S10a: the
wrong-key `/models` check is THREE-valued (401/403 = requires the key;
200 = public → probe; 429/5xx/transport = decides nothing → `key_proven`
NULL with the words); the Anthropic adapter DERIVES publicness the same
way instead of assuming its vendor's listing needs a key, and probes with a
1-token message when public; a save that ran no verify stamps NO
`verified_at` (so the page shows no status line rather than "Checked"
nothing checked); the page prints only the server's words (no invented
"the key was not tested"); the post-listing row refresh merges only the
listing/verdict fields, never `is_default`. Gateway 211 / web 435.

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
