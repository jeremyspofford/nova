# NEXT — lane dispatcher for parallel Claude Code sessions

Jeremy: open a fresh Claude Code session per lane and say
"implement lane N from docs/plans/NEXT.md". One lane per session, ever.
Sessions: this file is your work order. Read your lane's plan doc FULLY
before writing code — the rails in it are non-negotiable, they came from
an adversarial review. Project memory (MEMORY.md) and CLAUDE.md load
automatically; trust them.

## Standing rules (every lane)

- Own branch + worktree under `.worktrees/<lane>` (gitignored). ALWAYS
  `git -C` — cwd resets have shipped wrong commits to main before.
- Parallel sessions share the main checkout's git index: never `git add
  -A`, commit only your own paths by explicit pathspec, and check
  `git show --stat` after every commit.
- Verify per the plan doc's phase "Verify:" block, in a parallel rig
  (one-off backend container: worktree source mount, scratch memory dir,
  own INSTANCE_ID_FILE, port 8001+) — never deploy your worktree to the
  live stack. Clean any test rows you create in the shared Postgres.
- Leave the final change UNCOMMITTED in your worktree and summarize —
  Jeremy reviews and decides when to commit/push (standing rule). The
  exception is nothing: do not commit unprompted.
- Do not touch files outside your lane's declared surface. runner.py and
  router_chat.py belong to lane 1 until it merges.

## Lane 1 — turn-speed Phase 1: parallel read-only tools + cancellation

- Plan: `docs/plans/turn-speed.md` → "Phase 1" (rails are mandatory:
  read-only whitelist ONLY, cancel-and-await contract, tool-result
  guarantee per tool_call id, web_search concurrency cap 1–2, span
  cleanup, `agents.tool_concurrency` flag defaulting to current
  behavior).
- Worktree EXISTS: `.worktrees/turn-speed`, branch `turn-speed`
  (Phase 0 already merged to main from it — pull/rebase on latest main
  first).
- Surface: `backend/app/agents/runner.py` (owns it),
  `backend/app/settings_store.py` (new setting), tests.
- Model: STRONGEST available (claude-opus-5 or Fable). This is subtle
  asyncio cancellation work in the hottest loop in the codebase; the
  plan explicitly exempts it from the cheaper-model convention.
- Verify: the four checks in the plan's Phase 1 Verify block, including
  the interject-mid-gather test (no stray tasks via asyncio.all_tasks,
  trace status cancelled, no post-cancel memory writes).

## Lane 2 — model-eval-pipeline Phase 1: harness core

- Plan: `docs/plans/model-eval-pipeline.md` → "Phases" item 1.
- New worktree: `.worktrees/eval-pipeline`, branch `eval-pipeline`.
- Surface: `backend/app/memory/memory.py` (OkfMemory base_dir param),
  `backend/app/tools/builtin.py` (_mem(ctx) helper, 4 call sites),
  NEW `backend/app/evals.py`, NEW `backend/app/tools/fixtures.py`,
  migration `050_...` (source CHECK widening only in this phase).
- DEFERRED until lane 1 merges (do NOT touch runner.py):
  the `memory_override` kwarg on run_agent, its ctx plumbing, and the
  prompt-assembly/narration-write routing. Build everything else;
  stub the integration behind a TODO(lane-1-merge) and verify what is
  verifiable without it (memory sandbox isolation, fixtures
  record/replay via direct execute_tool calls).
- Model: claude-opus-5.
- Exit: champion/challenger pair runs from a CLI/endpoint call with
  real memory untouched (hash data/memory before/after).

## Lane 3 (optional) — eval suites + fixture corpora authoring

- Plan: `docs/plans/model-eval-pipeline.md` → "Eval suites — ALL roles".
- New worktree: `.worktrees/eval-suites`, branch `eval-suites`.
- Surface: NEW files only — `backend/app/evals/tasks/` (task specs per
  role: ingestion, model-manager, news-summarizer first) and authored
  fixture corpora (canned search results + page bodies per task).
  Zero shared-file conflicts by construction.
- Model: claude-opus-5 (or sonnet-5 — this is authoring, not systems
  work).
- Exit: task specs + fixtures reviewable as data; no code wiring
  (lane 2 consumes them).

## Sequencing after these

turn-speed Phase 2 (overflow trimming) needs lane 1 merged.
eval-pipeline Phase 2 (grading/storage/worker) needs lane 2 merged.
turn-speed Phase 3 (local specialist tier) needs Phase 2 + the eval
gate. Do not start any of these in parallel with their prerequisite.
