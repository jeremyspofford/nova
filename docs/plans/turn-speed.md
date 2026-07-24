# Turn speed: parallel mechanics + role-tiered models (v2)

Status: PROPOSED (decisions below need Jeremy's sign-off)
Author: Fable, 2026-07-24. v2 after an adversarial four-reviewer pass
against the codebase; v1's two boldest moves each hid a likely blocker.
Implement one phase per session with a cheaper model, in the order below —
the ordering is load-bearing (later phases depend on earlier gates).
Lane hygiene: own branch in `.worktrees/turn-speed`; the runner.py
restructure (Phases 1+4) lands as ONE reviewed change; freeze other lanes
off `runner.py`/`router_chat.py` until it merges (speaker-id, guarded
actions, and acp-coding-delegation all touch this hot loop).

## Why (measured, not guessed)

Trace `7e274b97` (2026-07-24, the Laguna research turn, 483.4s):
15 sequential LLM calls = 468.4s = **96.9%** (all openrouter glm-5.2,
~30–50 tok/s, completions 2–3.5k tokens, prompts growing 17k → 32k);
all 33 tool calls = 14.5s = 3%; overhead ~1s. Shape: orchestrator 31s →
ingestion dispatch 204.6s → model-manager dispatch 216.9s (back-to-back)
→ synthesis 30s. The lever is LLM time: fewer calls, faster models where
the volume is, overlap where independent. Do NOT optimize traces/DB/
narration (<1%) or shared HTTP pools (~seconds).

## Hard requirements (Jeremy, 2026-07-24)

No output-quality degradation. No added cost. No new failed-call modes.
No reliability regression. Every phase below carries the rails that keep
it inside these constraints; where an outcome is empirical (Phase 3), a
gate decides and the fallback position is "keep today's behavior."

## Target architecture

- **Orchestrator (`main`)**: stays on the operator-chosen frontier model.
  It speaks to the user and synthesizes (~60s of the 483s turn).
- **Specialist tool loops**: local on the 3090 by default IF AND ONLY IF
  the Phase 3 gates pass; otherwise they stay on cloud and the mechanical
  wins (Phases 0–2, 4) still apply. Explicit allowlist only — ingestion,
  model-manager, news-summarizer. **memory-curator (destructive grants)
  and guardian (consent steward) are excluded by name and stay on the
  frontier model.**
- **Utility roles**: already local (compaction qwen2.5:3b, voice
  qwen3:8b) — unchanged.

## Phase 0 — Zero-risk wins (ship first)

STATUS: DONE 2026-07-24 — implemented on branch `turn-speed`, live-verified
via rig (prompt order asserted, malformed-args stub test, real SSE turn,
cached_tokens confirmed in turn_spans), diff-reviewed (no blockers; span
result_head parity fixed), merged to main.

1. **Pass findings forward** (prompt-only, biggest single win/risk
   ratio): orchestrator guidance — when a later dispatch depends on an
   earlier result, include the relevant findings in the dispatch
   message. Model-manager re-ran 15 searches over ground ingestion had
   just covered (~2 minutes of the measured turn).
2. **Clock block → end of the FACTS section** (immediately after
   `_speaker_block`, runner.py:348–350) — NOT the end of the prompt: the
   last-word register slots are load-bearing (documented voice-model
   incident; small models obey the end of the prompt). This extends the
   cacheable prefix over role/model/platform/entities/mcp blocks.
   Honesty note: cross-turn cache benefit is unproven-but-free (entities
   block churns on a 15s TTL anyway); measure before claiming it.
3. **Record cache telemetry**: capture `prompt_tokens_details.cached_tokens`
   (and provider equivalents) into the llm_call span so the Turn
   Inspector can prove or disprove caching effects.
   Review follow-up (2026-07-24, post-implementation): the stable
   specialists index sits AFTER the clock, so it re-prefills uncached
   every turn. If the ledger shows real cross-turn cache hits, consider
   moving the clock below the specialists index in Phase 2 (still
   before memories, never past LAST WORD) — decide from cached_tokens
   data, not by assertion.
4. **Malformed tool-args fix**: today `json.JSONDecodeError → args={} →
   execute anyway` (silent wrong-tool-invocation, e.g. write_memory with
   no content). Return a "malformed arguments" tool result to the model
   instead. Strictly better on every model; prerequisite for Phase 3
   where Q4 models fumble JSON more often.

Verify: real chat two-specialist turn shows findings in dispatch #2's
message; voice turn confirms register behavior unchanged after the clock
move.

## Phase 1 — Parallel same-round tool calls (read-only whitelist)

`runner.py:526` runs the round's calls in a for-loop of awaits. Change,
with these NON-NEGOTIABLE rails (each traces to a review finding):

- **Whitelist, not blacklist**: gather ONLY read-only/idempotent tools —
  `web_search, fetch_url, get_weather, search_memory, read_memory_item,
  list_agents, list_models, list_followed_sources, list_stale_topics`.
  Everything else (write_memory, delete_memory_item, ingest_media,
  follow/poll, manage_*, remember_speaker, raise_recommendation,
  notify_operator, pull_model, ALL MCC/MCP tools, http_call POSTs) runs
  sequentially in the model's call order — same-round ordering is a
  contract the model relies on (create-then-append memory sequences, the
  per-chunk ingest flow), and serialized-anyway writes gain zero
  wall-clock from parallelism.
- **Cancellation contract** (the v1 blocker): there is NO cancellation
  handling anywhere today — a client disconnect/interject closes the
  generator (GeneratorExit / CancelledError; trace.py:124 merely
  observes it), and interject makes this the COMMON path (ChatPanel
  aborts the fetch and fires the next turn immediately). The gather must
  run inside try/finally: on unwind, cancel every pending child task and
  AWAIT them (suppressing CancelledError) before re-raising; stamp their
  open span rows status=cancelled with finished_at; never yield after
  GeneratorExit. Without this, orphaned tasks keep billing cloud tokens
  and writing memory after the user hit stop, with no audit rows.
- **Tool-result guarantee**: per-task try/except that ALWAYS yields a
  result string, and a finally that appends a tool message for EVERY
  tool_call id — a missing tool response is a provider 400 that kills
  the turn mid-research.
- **Per-tool concurrency caps**: `web_search` capped at 1–2 concurrent
  (SearXNG proxies rate-limited upstream engines; a 5-query burst
  returns empties, then storms the DDG HTML fallback from one IP —
  degraded results and possible IP block hurting SUBSEQUENT turns).
  `fetch_url` may use the full semaphore (distinct hosts; this is where
  the timeout-stacking insurance lives).
- **Legible events**: carry the args brief on tool_result events (start
  events already have it) so five parallel "✓ web_search" lines are
  distinguishable; keep audit-row ordering stable (seq or awaited
  insert).
- Flag: `agents.tool_concurrency` (default = current behavior until the
  verify passes; settings reads are live per-turn on the serving
  instance — note: a second test-rig backend only loads settings at
  startup).

Verify: multi-fetch round shows overlapping spans in the Turn Inspector;
an interject fired mid-gather leaves no stray tasks (`asyncio.all_tasks`),
trace status=cancelled, no memory writes after the cancel timestamp; a
round with one deliberately failing fetch + one healthy call completes
with both tool messages present; repeated 5-search rounds show no
empty-result/fallback-rate regression vs sequential baseline.

## Phase 2 — Intra-turn overflow protection (context hygiene)

Reframed from v1: this is OVERFLOW PROTECTION, not aggressive trimming —
v1's "reuse the 24k history budget" would have trimmed the measured
baseline turn itself (32k > 24k), degrading the exact turn we're
protecting; and `context.budget_ollama` (6000) would gut local
specialists. Rules:

- Ceiling = `min(model's real context − completion headroom,
  agents.intraturn_budget)` with the new setting defaulted WELL above
  observed peaks (e.g. 60k tokens for cloud). Trimming engages only
  where the alternative is provider-side overflow — strictly better,
  never worse.
- Trim by in-place content replacement ONLY on messages with
  `role=="tool"` AND string content; never remove/reorder messages
  (orphaned tool_calls pairing = provider 400); oldest first, down to
  ~70% of ceiling in one pass (hysteresis — repeated trims also
  invalidate any provider prefix cache round after round).
- **Exempt dispatch results** (the specialist's distilled report is
  often the oldest large tool message at synthesis time — trimming it
  starves the final answer of the turn's entire product). Trim raw
  web_fetch/web_search results first.
- Estimator: chars//3 (conservative; CJK/code underestimation leads to
  silent local truncation otherwise), skip `content=None`, count only
  text parts of list content, count image parts as ~1k tokens each (a
  base64 photo otherwise reads as ~250k "tokens" and triggers trimming
  on any attachment turn). Log a trace field at 80% of ceiling.
- Unit test: round-trip a trimmed transcript through the request builder
  asserting every tool_call_id keeps its tool message; an image-turn
  test asserting no trimming below the real ceiling.

Verify: re-run a long research turn — prompt_tokens plateau instead of
growing monotonically, and the final report quality matches baseline
(same sources cited).

## Phase 3 — Local specialist tier (gated, empirical)

The v1 premise "qwen3:30b-a3b Q4 fits the 3090 with room" FAILS
arithmetic on the real box: ~18.6GB weights + ~3GB KV@32k + ~1–1.5GB
buffers ≈ 23GB vs ~20.7GB free with whisper resident → CPU-offloaded
MoE decode at or below cloud speed. So Phase 3 is gate-driven, and its
model choice is empirical, not asserted:

- **Candidates**: (a) qwen3:30b-a3b at num_ctx ~16k (KV ~1.5GB — REQUIRES
  Phase 2 shipped first so 16k is survivable), (b) a 14b-class model at
  Q4 that co-resides with the voice model. The gate decides.
- **Fit gate (hard)**: after pull, load at target num_ctx WITH whisper
  resident and require ollama logs to show ALL layers GPU-offloaded. Any
  CPU offload = fail.
- **num_ctx plumbing (prerequisite)**: Nova's client sends no
  `options.num_ctx` and compose sets no OLLAMA_CONTEXT_LENGTH — the
  server default silently TRUNCATES oversized prompts from the HEAD
  (i.e. the system prompt) — the worst possible silent-quality failure.
  Pass num_ctx per ollama-target call; add a client-side estimate that
  errors LOUDLY when the prompt exceeds it. Raise ollama read timeout to
  ≥300s (model_warmer already knows loads take up to 300s; the blanket
  120s would fire spuriously on cold loads).
- **Error classification (prerequisite for fallback)**: openai_compat
  yields one undifferentiated error string today. Add classes:
  `connect_failed` / `http_status` (incl. 404 model-not-pulled) /
  `mid_stream`. Fallback to the main agent's model fires ONLY on
  connect-class/404 before the first byte; NEVER auto-retry after
  partial output (double-billing + duplicated side effects) — surface
  the error. Guard: resolve the fallback model first; if it lands on the
  SAME base URL (keyless local-first install → main is also ollama),
  fail fast instead of doubling time-to-failure. Debounced operator
  notification when fallback engages repeatedly (honest receipts;
  otherwise the cost win silently evaporates and Jeremy budgets on $0
  turns that aren't).
- **Voice contention scenario (gate)**: trigger a voice turn WHILE a
  specialist dispatch runs; voice latency must stay acceptable (voice is
  the most latency-sensitive daily path; a 19GB evict/reload cycle
  stalls it 20–60s under WSL2). keep_chat_model_warm stays off alongside
  a 30b specialist.
- **Quality gate (A/B, not fidelity-only)**: run the champion/challenger
  pipeline from `model-eval-pipeline.md` (champion = glm-5.2,
  challenger = the local candidate): deterministic contract checks on
  the WRITTEN MEMORY TOPICS (tag hygiene, dedup, item_id
  update-in-place — the generic-tag over-linking incident proves
  violations are durable, not cosmetic), pairwise judge on identical
  tool fixtures, Jeremy's side-by-side eyeball as tiebreaker; PLUS
  compare orchestrator round count + total openrouter tokens vs
  baseline — a thin local report that makes the orchestrator
  re-research in 30k-token cloud rounds costs MORE than all-cloud.
  Disqualify on: any empty-args execution, >8 rounds on the scripted
  task, or degraded topic writes. (If the eval pipeline isn't built yet
  when Phase 3 arrives, run the same checks manually — the pipeline is
  the durable version of this gate, not a prerequisite.)
- Per-agent flips via Settings → Agents (instantly revertible); seed no
  local defaults on installs whose hardware is unknown.
- **New setting**: `agents.max_dispatches_per_turn` (default 3),
  enforced in the runner loop with a polite error-string result (same
  pattern as the depth-limit message) — no per-turn dispatch budget
  exists today at all, and Phase 4's "batch your dispatches" guidance
  must not become unbounded fan-out.

If the gates fail: specialists stay on cloud; Phases 0–2 and 4 still
deliver ~280–380s on the measured turn. That is the explicit fallback
position, not a failure of the lane.

## Phase 4 — Concurrent sibling dispatches (after Phase 3 on purpose)

Ordered after Phase 3 so any prompting-induced extra dispatches are
local/cheap, not extra glm-5.2 sub-turns. Mechanics:

- Same-round dispatch calls run concurrently ONLY when their agents
  resolve to DIFFERENT backends. Two dispatches on the same ollama
  endpoint run sequentially (ollama serializes generation → dispatch #2
  would die at the 120s first-byte timeout — a new failed-call mode —
  and alternating prompts on one KV slot destroys prefix reuse, adding
  10–30s prefill per round). Cloud+cloud and cloud+local pairs overlap.
- **Task-per-dispatch**: create each child's pump task INSIDE its own
  `trace.span("dispatch")` context (task creation copies the context) —
  a single-task round-robin merge corrupts the contextvar parent chain
  and mis-attributes every child span. Merge through one asyncio.Queue.
  Verify: every child span's parent chain ends at its own dispatch span.
- Same cancellation contract as Phase 1 (cancel-and-await pump tasks in
  try/finally) plus a wall-clock cap per dispatch via `asyncio.wait_for`
  (copy the scheduler's kill-switch pattern, scheduler.py:31–57).
- Prompting: batch INDEPENDENT dispatches in one message; dependent ones
  still sequential with findings passed forward (Phase 0).
- Events interleave with agent-name labels (existing UI convention).

Verify: two-dispatch turn shows overlapping dispatch spans; kill the
client mid-turn — no stray tasks, both children cancelled, spans marked;
same-ollama pair provably serializes.

## Phase 5 — Stream specialist text (perceived latency)

Depth-1 text deltas are dropped today (runner.py:492), so multi-minute
dispatches look frozen. Rails (v1's wording was a blocker in disguise:
routed through the activity path, a 200s dispatch at ~10 deltas/s would
insert ~2,000 fire-and-forget DB rows, evict real history out of
load_history's 200-row window, and replay as history spam forever):

- `sub_text` is a NEW TOP-LEVEL runner event type mapped to a NEW SSE
  key, explicitly EXCLUDED from activity persistence and from the orb's
  CustomEvent channel; batch emission per sentence or ~250ms.
- Old clients ignore unknown SSE keys (api.ts else-if chain) — additive
  and version-skew-safe with the baked :8080 build, but ship backend
  emit + frontend accordion rendering together and rebuild web.
- Forward through all three nesting layers via one shared predicate,
  tagged with agent name; TTS consumes only `type=="text"` (sub_text
  must never reach speech).

Verify: long dispatch streams text into the accordion; a follow-up turn
confirms history is NOT polluted; voice turn confirms TTS unaffected.

## Explicit non-goals

Trace/DB micro-optimization; shared httpx pools (fold into Phase 1 only
if trivial); background/job-id dispatches; multi-hop model chains;
parallelizing mutating tools.

## Decisions for Jeremy (PROPOSED until signed off)

1. **Specialist model**: decided BY THE GATES between qwen3:30b-a3b@16k
   and a 14b-class co-resident — sign off on the candidate list, not a
   winner. (Laguna XS stays a Coder-agent candidate only.)
2. **Mid-stream local failure**: fail with the error visible (my rec) vs
   one logged cloud retry (accepts double-billing that call).
3. **Fallback-to-cloud**: auto with visible note + debounced repeat
   alert (my rec) vs hard-fail when local is down.
4. **`agents.max_dispatches_per_turn` default 3** — confirm.
5. **Orchestrator model**: unchanged — confirm.

## Expected end state on the measured turn

Baseline 483s → Phases 0–2 ≈ 280–380s all-cloud (findings-forwarding is
most of it) → with Phase 3 passing its gates + Phase 4, roughly
120–200s, with the specialist bulk off the cloud bill. Every phase is
independently revertible (settings flag or per-agent model field), and
each phase's verify step runs the real chat flow per the definition of
done.
