# Slice 10 — Spend tracking + routing by role: close-out and carries

Plan: ~/.claude/plans/ethereal-cooking-dusk.md (approved 2026-09-08).
Branch `slice/s10` in `.worktrees/s10a`, cut from the merge of `rebuild/v4`
(S9 scheduling) into `slice/s10a` (c840083c — a real merge, not a
fast-forward; the tool registry, capability phrases and offer classes had
both sides). Commits: 6a061616 gateway ledger, 883021b4 core attribution,
040c7114 Spend page, a1… BYOK fix, 439ca017 gateway router, 00f34501 core
routing, f7b326c9 Routing UI, then three fixes from the live walk
(5017b748 and before). Deployed 2026-09-08 from the branch's commits.

Decisions with Jeremy (2026-09-08): past a cap, fall back to local and
say so; owner-set roles with ordered fallback chains (chat, scheduled,
judge; coding and vision reserved); caps monthly per provider plus a
total, in `nova.timezone`; agents as first-class configurable things are
NOT this slice (a role is the unit; an agent later is a row that names a
role and rides the same chains).

## What shipped

- **The ledger (gateway, migration 005).** One `usage_events` row per
  completion / refusal / probe: provider, model, purpose (chat, scheduled,
  judge, redirect, eval, probe, verify), role, turn, PERSON, tokens
  (prompt, completion, cache read/write), duration, `local`, `cost_usd` +
  `cost_basis`, `metered` (derived: both counts present — a provider that
  stated nothing is NULL, never zero), status, route link and reason.
  CHECKs refuse dollars on a local row and a cost without its basis.
  `usage.observe` relays every byte and holds back only the upstream
  `[DONE]` so one synthetic usage chunk (counts + cost + basis + provider +
  local + metered + recorded + route) precedes it; core reads it off the
  span. Written when the stream ends; a client-abandoned stream is a row
  with status 499; a failed write is logged, counted and said in the
  chunk (`recorded:false`).
- **Prices, in precedence.** The provider's own reported cost
  (OpenRouter's `usage.cost` — and for a **BYOK key**, found live, its
  `cost_details.upstream_inference_cost`, since OpenRouter's own figure
  is then 0) → the owner's entered price → the listing's price (recorded
  at save time from the listing the verify already fetched, and on every
  catalogue fetch — a chat call never fetches a listing) → the dated
  curated list (`curated_prices.json`, Anthropic, validated on load,
  seeded on Anthropic provider create) → nothing (the model is listed as
  unpriced). Cache reads/writes billed at their multipliers.
- **Usage asked for.** openai-chat sends `stream_options.include_usage`
  (+ OpenRouter's `usage:{include:true}`); a 400 naming the field is
  retried once without and remembered (`providers.usage_supported`);
  ollama 0.33.1 honours it (verified live). Anthropic: system as text
  blocks with the prompt-cache breakpoint on the first (stable) block
  and on the last tool; cache counts read.
- **Attribution (core).** `turns.person_id` (migration 020);
  `peers.attribution_headers` stamps turn / person / purpose / role /
  timezone on every completion. The judge and redirect rounds record
  `llm_call` spans of their own now (purpose judge/redirect) — they cost
  money and were invisible. The stream gains one `usage` frame per turn;
  GET messages carries `cost_usd` and `route_reason`.
- **The router (gateway, migration 006).** `routes(role, chain)`; the
  request's explicit model is link 1 and the chain holds the fallbacks;
  empty scheduled/judge → the chat chain; a bare local id is the default
  provider's model (a live bug, pinned). Before any call: skip a walled
  provider (a refusal 401/402/403/429/5xx walls it 1 h → 6 h → 24 h; a
  clean completion clears; the owner can clear), an over-cap provider
  (recorded spend, live — never called), an uninstalled local model. No
  runnable and no local link → the stated cross-tier standby. A live
  refusal walls and the same request falls to the next link. Every
  decision past link 1 rides `X-Nova-Route` and the usage chunk; core
  streams a `route` frame and the bubble shows the gateway's sentence.
  An explicit-model call with no role (evals) over its cap is a 402 and
  never a substitute; a suite is refused before it STARTS when its
  provider is capped or walled.
- **Surfaces.** `/spend`: tiles with bases, month vs cap, GPU minutes as
  their own unit, "what the totals leave out" (unmetered, unpriced,
  refusals, unrecorded), bars per day, provider cards with cap editors,
  rollups by model / purpose / person / role, refusals, an owner price
  editor. Settings → Routing: per role the chain with each link's live
  verdict and "what would answer right now", walls with "Try it again";
  the chat picker lists every provider's models grouped. Activity shows
  cost, basis, cache, purpose per llm_call span.
- **Her tools.** `spend_report` (every number with its basis in words;
  local minutes "not money") and `route_explain` (the answer first, then
  the walk; reads chat.model itself for the chat role). Registry 24 → 26.
  A new narration claim, `stated_spend`: a ledger word with a dollar
  figure and no spend_report span this turn is corrected in its own
  words.
- Suites: gateway 423, core 1728, web 629, tsc clean.

## Walked live (2026-09-08, owner session minted in nova_core)

- Local turn → usage frame 7,706 in / 19 out, `local`, no dollars; the
  judge round its own row. OpenRouter turn on gpt-oss-20b → first
  `cost 0` (BYOK) → fixed → **$0.000488 provider-reported**, the judge
  $0.000014; `/api/v1/spend` names the owner, America/New_York.
- Chain `chat → [ollama:qwen3:8b]`, cap openrouter $0.0001 → explain:
  over_cap → ollama; the turn's route frame: "fell back to link 2
  (ollama:qwen3:8b) — openrouter … over its monthly cap"; OpenRouter never
  called; ledger rows carry link 2.
- In her words on the FALLBACK 8B model: both tools called, but she
  called the fallback "the default" and the OpenRouter charge "all
  local" — two findings: `route_explain` was called without the chat
  model (now read by the tool) and a stated spend figure with no ledger
  read had no guard (now `stated_spend`). Retried with no tool calls at
  all on the same small model: a fabricated "$0.0005 on local models" —
  the new guard is the line of code for that. On the restored 27B: both
  tools, correct on both counts, and she corrected her earlier claim.
- A bare `chat.model` (qwen3.8:27b) was read by the walk as "no such
  provider" and fell to the 8B — fixed, pinned.

## Carries

- **Anthropic direct** has no provider on the live stack yet; the curated
  prices seed on create. Verify `cache_read_tokens > 0` on a second turn
  when one exists (the fake cannot model caching).
- **True GPU seconds** (`/api/chat` durations) — `duration_ms` is wall
  time incl. model load, labelled so.
- **Concurrent calls** can overshoot a cap by their own cost (stated on
  the page); no estimated reservations, by design.
- **Small models misread tool results** even when they call them; the
  guards catch the claims they make (spend figures, pulls, removes), not
  every misreading. A judge-model role could route the honesty checks to
  a stronger model — the role exists.
- **Reserved roles** coding / vision have no caller; `model_check_update`
  stays without a role.
- `rebuild/v4` merge of `slice/s10`: a merge, not a fast-forward, once the
  S9 session's tree is clean.
