# Autonomous safety rails — completion checklist

**Status as of 2026-07-09:** Steps 1 & 2 are **code-complete and tested against the
live Postgres**, but **NOT live in the running services** (the running orchestrator
and cortex still have the pre-edit code — `./start` ran before these edits). This
doc is the punch list to finish them, plus the recommended follow-ups.

Context: these are the first two of three fixes from an architecture review of
Nova's reactive/proactive runtime. The three findings were:

1. **No idempotency on side-effecting tools** — recovery replays (reaper
   re-enqueue, checkpoint stage resume) could fire an irreversible tool twice.
   → **Built (step 1).**
2. **Cron fire-and-lose** — the scheduler advanced `schedule_next_at` before the
   work was durable; a crash silently dropped a scheduled run. → **Built (step 2).**
3. **No in-process wall-clock kill on the reasoning loop** — the reaper marks a
   hung task failed in the DB but does not cancel the running asyncio task.
   → **NOT started (step 3).**

---

## What's already done (do not redo)

### Step 1 — tool idempotency ledger
- `orchestrator/app/migrations/103_tool_execution_log.sql` — ledger table.
- `orchestrator/app/tool_idempotency.py` — `run_idempotent()` (claim → commit →
  rollback), `IDEMPOTENT_TOOLS` set, key helpers. Fails **open**.
- `orchestrator/app/tools/__init__.py` — wired into `execute_tool` dispatch: wrapped
  tools with a `task_id` in context route through the ledger.
- Wrapped set: `github_create_pr`, `github_push_branch`, `github_create_branch`,
  `git_commit`, `send_push`, `create_recommendation`. Deliberately NOT wrapped:
  `run_shell`, `write_file`, config CRUD, github_external (already consent-gated).
- Tests: `tests/test_tool_idempotency.py` (10) — all green.

### Step 2 — cron transactional outbox
- `orchestrator/app/migrations/104_goal_fire_outbox.sql` — outbox table, `UNIQUE
  (goal_id, fire_at)`, partial index. **Applied manually to the running DB**; it
  will re-run idempotently and get recorded in `schema_migrations` on the next
  orchestrator restart (no desync).
- `cortex/app/scheduler.py` — replaced `check_schedules()` with `enqueue_due_fires()`
  (advance clock + record fire in one txn, `FOR UPDATE SKIP LOCKED`),
  `drain_outbox()` (surface stimuli, park poison fires past `MAX_FIRE_ATTEMPTS=5`),
  `ack_fires()`.
- `cortex/app/cycle.py` — PERCEIVE now enqueues+drains; added `fire_ids` to `CycleState`.
- `cortex/app/loop.py` — acks fires only after a non-error cycle (at-least-once).
- Tests: `tests/test_goal_fire_outbox.py` (7) — all green.

### Test-infra fix (shared)
- `tests/_service_app.py` — NEW. Context manager to import ONE service's `app.*` in
  isolation (orchestrator/app is a namespace pkg, cortex/app is a regular pkg — they
  collide on `sys.modules` in one session). Both new test files use it.
- `tests/requirements.txt` — added `croniter>=1.0` (outbox test imports cortex scheduler).

---

## REQUIRED to complete

- [ ] **Make both features live.** Rebuild + restart the two services:
  ```bash
  make build && make up          # or: make watch (dev hot-sync)
  ```
  Only `orchestrator` and `cortex` changed, but a full `make up` is fine (idempotent).

- [ ] **Confirm migration 104 recorded** after orchestrator restart:
  ```bash
  docker compose exec -T postgres psql -U nova -d nova -tAc \
    "SELECT version FROM schema_migrations WHERE version LIKE '104%';"
  ```
  (Should return `104_goal_fire_outbox`. The manual apply won't block re-run.)

- [ ] **Re-run both test files against the restarted stack** (they import source
      from disk, but this confirms the DB tables/behavior match live):
  ```bash
  cd tests && uv run --with-requirements requirements.txt pytest \
    test_tool_idempotency.py test_goal_fire_outbox.py -v
  ```
  Expect 17 passed.

- [ ] **Verify end-to-end (use the `verify` skill — drive the real flow, don't stop at tests):**
  - *Idempotency, live:* dispatch a pipeline task through the running orchestrator that
    calls a wrapped tool (e.g. a cortex/self-mod task that hits `git_commit` or
    `send_push`), confirm a `tool_execution_log` row appears with `status='done'`.
    Then confirm a forced replay (re-enqueue the same task id, or re-run the stage)
    returns the cached result instead of acting twice. Check:
    ```bash
    docker compose exec -T postgres psql -U nova -d nova -c \
      "SELECT tool_name,status,left(result,60),created_at FROM tool_execution_log ORDER BY created_at DESC LIMIT 10;"
    ```
  - *Outbox, live:* with `features.brain_enabled` on, seed/observe a due scheduled
    goal (e.g. temporarily set an existing cron goal's `schedule_next_at` to now) and
    watch a `goal_fire_outbox` row go `pending → done`, and cortex logs
    "Scheduled fires: N enqueued, M drained":
    ```bash
    docker compose exec -T postgres psql -U nova -d nova -c \
      "SELECT goal_id,status,attempts,fire_at,dispatched_at FROM goal_fire_outbox ORDER BY created_at DESC LIMIT 10;"
    docker compose logs cortex --tail 50 | grep -i "scheduled fires\|fire"
    ```
  - The 11:00 UTC "Morning briefing" goal is the natural real-world exercise once live.

---

## RECOMMENDED (do after the required set is green)

- [ ] **Fix the pre-existing test collision** (surfaced this session; fails on the
      clean tree too — NOT caused by our work). `tests/test_drive_scheduling.py` does a
      **module-level** `sys.path.insert(0, cortex)` that shadows orchestrator's
      namespace `app` and breaks `tests/test_daily_briefing.py`'s 3 `send_push` tests
      whenever they run together. Fix: move `test_drive_scheduling.py` (and any other
      module-level `from app.*` importer) onto `tests/_service_app.py`. Repairs 3
      pre-existing `make test` failures. Verify with:
      ```bash
      cd tests && uv run --with-requirements requirements.txt pytest \
        test_daily_briefing.py test_drive_scheduling.py -p no:randomly -q
      ```

- [ ] **Full suite sanity:** run `make test` and confirm no NEW failures beyond the
      known-broken set. (Suite has ~8 known auth/flaky failures per prior notes.)

- [ ] **Operator visibility for the new tables** (nice-to-have, aligns with the
      "operator-visible outcomes" principle):
  - A stale-`in_progress` ledger claim means a tool's fate is unknown — surface these
    (they are deliberately NOT auto-swept; there's a partial index
    `idx_tool_execution_log_inflight` for querying them).
  - Surface `goal_fire_outbox` rows in `status='failed'` (poison fires parked past
    `MAX_FIRE_ATTEMPTS`) — otherwise a permanently-crashing scheduled goal is silent.
  - Cheapest: a small admin/diagnostics query or a Grafana panel; no new UI required.

- [ ] **Docs** (per CLAUDE.md code→docs mapping):
  - `orchestrator/app/tools/` changed → check `website/.../nova/docs/mcp-tools.md`
    (note idempotency semantics for destructive tools).
  - cortex has no docs yet; the outbox is an architecture-level durability change —
    consider a changelog entry in `website/src/content/changelog/` grouping steps 1–2,
    and an architecture note if/when cortex docs are started.

---

## NEXT (separate work — step 3)

- [ ] **In-process wall-clock kill on the reasoning loop.** Today the reaper marks a
      hung agent session `failed` in the DB but its docstring says it does NOT cancel
      the running asyncio task; `cancel_event` in `executor._heartbeat_loop` only fires
      on heartbeat *write* failure, not on runtime exceeding the timeout. A task that
      keeps heartbeating while looping in tool calls burns tokens unbounded.
      Fix direction: wrap each stage in `asyncio.wait_for(run_stage(...),
      timeout=pod.timeout_seconds)` and add a `max_tool_iterations` cap in the agent
      turn loop (`orchestrator/app/pipeline/executor.py`, agent runner). The reaper
      becomes the backstop, not the primary timeout. The idempotency ledger (step 1)
      makes any resulting retry safe.

---

## Gotchas to remember

- **Nothing is live until orchestrator + cortex are rebuilt/restarted.** Tests pass by
  importing source from disk; the running containers still have old code.
- **Migration 104 was applied by hand** to the running DB; idempotent re-run on
  restart records it in `schema_migrations`. Fine.
- **`app` package collision is real:** orchestrator/app = namespace pkg, cortex/app =
  regular pkg (empty `__init__.py`). Any test importing service code directly MUST use
  `tests/_service_app.py`, never a module-level `sys.path.insert + from app...`.
- **Idempotency keying is (task_id, tool_name, canonical_args)** with no ordinal —
  "at most once per task per identical args." Correct for the wrapped set; wrong for
  repeatable tools, which is why they're excluded.
- **Outbox is at-least-once** by design (a missed briefing is worse than a rare
  duplicate); duplicate side effects are bounded by the step-1 ledger.
