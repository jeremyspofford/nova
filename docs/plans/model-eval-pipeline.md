# Model eval pipeline: champion/challenger quality grading

Status: DECISIONS LOCKED (Jeremy, 2026-07-24 — see bottom)
Author: Fable, 2026-07-24. Feasibility code-verified same day (four
integration checks, file:line cited throughout). Consumed by
`turn-speed.md` Phase 3 as its quality gate; outlives that lane — this
is the standing answer to "can we swap agent X to model Y?" for any
future candidate, local or cloud. The previously assigned model is
always the champion; the candidate must beat or tie it to be promoted.

Extension (2026-07-24): a challenger need not be a different model —
the SAME model with a different system_prompt is a valid challenger.
The harness is identical (same fixtures, same contract checks, same
position-swapped judge); only the run label differs. This is the gate
`self-improvement.md` stage 2 uses for prompt/skill self-tuning
proposals.

## What gets graded (three layers, cheapest first)

1. **Deterministic contract checks** (code, no LLM): expected tools
   called; written memory topics have valid frontmatter, subject-specific
   tags (no `_GENERIC_TAGS` violations — the over-linking incident makes
   this mechanical), and update-in-place via item_id; rounds used;
   malformed-args count; tool-error count. Efficiency numbers (tokens,
   duration, per-round prompt growth) come free from the turn ledger.
2. **Pairwise LLM judge**: champion and challenger outputs for the SAME
   task on IDENTICAL tool inputs, anonymized as A/B, scored against a
   rubric (faithfulness to the fixture sources, completeness,
   memory-write quality), judged TWICE with positions swapped —
   disagreement between the two orderings marks the pair "too close to
   call" rather than averaging it away. Judge self-preference bias is
   real: default judge should be a different frontier model than either
   contestant (Decision 1).
3. **Jeremy as tiebreaker**: the UI's job is to make the eyeball check
   cheap — side-by-side diff of written topics and final reports, one
   screen, per-dimension scores, promote/reject.

## Architecture (all hooks code-verified)

### Runner (`backend/app/evals.py`, cloned from scheduler.run_one)

- Invoke `run_agent({**agent, "model": challenger}, [{"role":"user",
  "content": task_prompt}], dispatch_depth=1, automation="eval:<task>")`
  and drain the generator — the copied-dict override is the exact
  shipped voice-override pattern (router_chat.py:98-100); run_agent
  never re-reads the agents table (model consumed only at
  runner.py:484/487 and the prompt's model block); no SSE consumer
  needed (scheduler.py:42-52 is the template); `asyncio.wait_for` for
  the per-task budget.
- `dispatch_depth=1` strips dispatch_to_agent (runner.py:442) — REQUIRED,
  because `_run_dispatch` re-fetches agents from the DB (runner.py:631)
  so a model swap would not propagate to sub-agents anyway.
- **Guard**: assert `effective_model(challenger) == challenger` before
  the run — llm/router.py:17-30 silently swaps unconfigured cloud models
  to the local fallback with only a log line; without the assert an eval
  would grade the fallback while reporting the challenger's name.
- Wrap each run in `trace.turn("eval", automation="eval:<task>",
  model=...)` so per-round usage lands in the ledger and runs are
  distinguishable. The `automation` free-text column is the zero-
  migration tag slot.

### Memory sandbox (eval runs must never touch real memory)

Three additive edits: `OkfMemory(base_dir=None)` (memory.py:24-27
currently hardcodes the root; singleton at :437 unchanged); a
`_mem(ctx)` helper in tools/builtin.py used by the four memory tools;
a `memory_override` kwarg on run_agent carried in ctx AND used for the
prompt-assembly reads (memory.context/skills_context/soul) and the
narration-detector journal write (runner.py:606-610 — small challenger
models trip the narrate-without-tools detector OFTEN; unrouted, it
journals to REAL memory).
Rails: fail-safe direction — set `ctx["eval_run"]=True` and make
_write_memory hard-error if the flag is set but the override is missing
(the natural `ctx.get("memory") or memory` fallback silently writes real
memory otherwise). Never drive evals through the HTTP chat route
(router_chat.py:206/211 journals to the singleton). Call `startup()` on
the scratch instance (seeds soul.md, builds the BM25 index over the
task's pre-seeded fixture corpus — also what makes write-time link_pass
deterministic). Exclude delete_memory_item from eval toolsets
(memory.py:360-361 reaches into the real media_ingests ledger).

### Tool record/replay (identical inputs across contestants)

- Shim at the TOP of `tool_registry.execute_tool` (registry.py:308) —
  the documented single dispatch point for every tool family; record
  BEFORE trace redaction (ledger stores only 500-char heads — traces are
  NOT usable as fixtures).
- Mode carried in a **contextvar** (trace.py idiom), NOT the ctx dict —
  ctx is rebuilt per sub-turn and only `automation` propagates.
- Fixture key: sha256 of tool name + canonical-JSON args, one JSON file
  per key. **Exact-hash replay WILL miss** — the challenger writes its
  own query strings — so replay falls back to a per-tool, per-task
  default fixture (a pre-authored canned corpus: N search results, M
  page bodies). That fallback IS the fairness mechanism: both
  contestants research the same frozen mini-web.
- Pin per run: `agents.max_tool_rounds` (read live, runner.py:477); same
  toolset comes free from the copied dict (allowed_tools read from the
  dict, registry.py:194).
- Never in eval toolsets even in record mode: pull_model,
  notify_operator, request_operator_confirmation, remember_speaker
  (real side effects).
- Fixture dir needs a compose volume line (backend mounts only
  ./data/memory today) + `docker compose up -d backend`.

### Storage + worker (migration 050 — next free number, verified)

- **Widen the turn_traces source CHECK** to include 'eval'
  (028_turn_traces.sql:10-11 allows chat/automation/compaction only;
  trace._flush swallows insert errors with log.exception — an 'eval'
  trace today would SILENTLY VANISH).
- `eval_runs` (agent, champion_model, challenger_model, status,
  verdict JSONB, timestamps) + `eval_results` (per task-pair: contract
  scores, judge scores both orderings, trace FKs). Verdicts live in
  their OWN tables — trace retention prunes turn_traces at 14 days, so
  trace FKs are ON DELETE SET NULL, never load-bearing.
- `eval_worker.py` clones ingest_worker's loop (SKIP LOCKED claim,
  orphan reset, error containment) so multi-minute evals run in the
  background and survive restarts; claim-locking keeps multi-instance
  fleets safe.
- **Filter `source='eval'` out of observability_summary
  (router_system.py:214-240) and the Recent turns list
  (router_chat.py:309-319)** — both aggregate all sources today; an
  eval batch would skew error rates, p50/p95, and est_cost on the board.

### Judge fairness details

Strip the "## Model (live)" block leakage: judge sees only task, fixture
sources, and the two outputs — never raw prompts (each contestant's
system prompt names its own model). Champion/challenger run back-to-back
so the TTL-cached prompt blocks (platform 300s, entities 15s) match.

### UI (Library → Models, NOT Settings)

The models UI lives at `frontend/src/components/library/ModelsTab.tsx`
(SettingsPage.tsx:13 explicitly excludes Models). Add an "Evals" panel:
pick agent + challenger → queue run → history table (champion vs
challenger, per-dimension scores, cost/speed deltas) → side-by-side
artifact diff → Promote button (writes the agents table via the existing
update path; Decision 2). Phone path needs the web image rebuilt.

## Eval suites — ALL roles (LOCKED: Jeremy 2026-07-24)

Every agent role gets a suite, current and future — not just the
specialists. Small and frozen: 4–6 tasks per role, versioned in-repo
(`backend/app/evals/tasks/`); scores are only comparable within a suite
version. Two execution classes:

- **Live-tool roles** (read-mostly toolsets): record/replay as designed.
- **Replay-only roles** (toolsets that mutate Postgres — agent-creator,
  agent-manager, skill-manager, tool-creator): fixtures are AUTHORED,
  never recorded; replay mode serves canned results so nothing executes,
  and grading asserts on the CALLS (well-formed specs, correct diffs, no
  destructive overreach) from the event transcript plus judge scoring of
  proposal quality. No DB sandbox needed because nothing mutating runs.

Per-role task archetypes:

- **main (orchestrator)**: dispatch orchestration with CANNED dispatch
  results — requires a small additional hook: `_run_dispatch`
  (runner.py:615-653) honors the eval contextvar and serves a fixture
  instead of running the child (dispatch is runner-inlined and never
  passes execute_tool, so the standard shim can't see it). Tasks:
  batch-independent-dispatches behavior, findings-forwarding compliance
  (both validate turn-speed Phase 0/4 prompting), synthesis faithfulness
  from two canned specialist reports, answer-vs-dispatch judgment.
- **ingestion**: research-and-write-topic (fixture mini-web +
  tag/dedup assertions), update-existing-topic (pre-seeded scratch
  corpus), follow/poll flow.
- **model-manager**: hardware-fit against a frozen catalog snapshot,
  recommend-and-justify.
- **news-summarizer**: digest from fixture articles — faithfulness, no
  narration slips (the past-tense detector's patterns double as checks).
- **guardian**: consent scenarios with expected allow/deny outcomes,
  including the dispatches-are-hearsay rule and authoritative-card
  grounding — judgment tasks, scripted well.
- **memory-curator**: dedup/merge/delete on a pre-seeded scratch corpus;
  the delete check asserts REAL removal from the scratch store, not
  marker text (the "[Deleted]" faking incident is literally the test
  case).
- **agent-creator / agent-manager / skill-manager / tool-creator**:
  replay-only class above.
- **Future agents** (e.g. the Coder agent from acp-coding-delegation):
  coverage is a standing requirement, not an afterthought — an agent
  with no suite shows "unevaluated" in the Evals panel; creating or
  editing an agent offers seed-task generation from its description +
  toolset (generic template, hand-refined); and the
  regression-becomes-a-task rule applies to every role, so each suite
  grows from real failures.

## What this does NOT cover (honest limits)

Scripted suites measure task competence, not conversational feel over
weeks. A challenger can pass and still disappoint on some real-world
pattern the suite lacks — when that happens, capture the failing case
AS a new suite task (the suite grows from real regressions). Judge
scores are ordinal steering, not truth; the promote decision stays
human.

## Phases (one per session; all roles in scope, built in this order)

1. **Harness core**: OkfMemory(base_dir) + memory_override + eval-flag
   failsafe; evals.py runner with the effective_model guard; source
   CHECK widening; fixtures contextvar shim (record + replay + default
   fallback + replay-only mode). Exit: a champion/challenger pair runs
   from a CLI/endpoint call, real memory untouched (verified by hashing
   data/memory before/after), two trace ids returned.
2. **Grading + storage**: contract checkers; pairwise judge with
   position swap; migration 050 tables; eval_worker; observability
   filters. Exit: queued eval produces a stored verdict with
   per-dimension scores; board/Recent turns show no eval pollution.
3. **Specialist suites + UI**: author + record the ingestion,
   model-manager, and news-summarizer suites; Evals panel in ModelsTab
   with diff view, "unevaluated" badges for suite-less agents, and
   Promote. Exit: full walk of the click path
   (discoverable-by-navigation rule); turn-speed Phase 3 gate = "run
   this pipeline, challenger = local candidate."
4. **Remaining roles + future-agent coverage**: guardian and
   memory-curator suites; the replay-only suites for
   creator/manager/tool roles; the `_run_dispatch` fixture hook + main
   orchestrator suite; seed-task generation on agent create/edit. Exit:
   every current agent shows a suite in the Evals panel; a
   freshly-created test agent gets offered seed tasks.

## Decisions (LOCKED: Jeremy, 2026-07-24)

1. **Judge model**: a different frontier model than either contestant
   (via OpenRouter; judge calls are few and cheap), position-swapped.
2. **Promote button**: one-click write to the agents table from the
   Evals panel — same field Settings already edits, instantly
   revertible.
3. **Suite scope**: ALL roles, current and future — not specialists
   only. New agents must gain coverage (unevaluated badge + seed-task
   generation); build order is phases 3→4 above, end state is full
   coverage.
