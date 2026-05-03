# T1-01: Approve → Execute Worker

**Tier:** 1  **Size:** L  **Blocks:** T1-02, T1-03  **Blocked by:** none

## Why this task exists

Closes G1 from `docs/audits/2026-05-03-readiness-assessment.md`. Today,
`decide_approval` in `orchestrator/app/capabilities/consent.py:173-221` flips
`approval_requests.status` to `approved` and returns `True`. Nothing else
happens. The agent that originally called `open_fix_pr(...)` received
`{"status":"consent_pending","approval_id":"..."}` as its tool result, finished
its turn, and is gone. No code path re-executes the approved tool.

The production-shape failure: a user watches a CI failure in the Pending
Approvals panel, clicks Approve, the row updates, and the PR is never opened.
The audit log shows `consent_request` then silence. The v1 acceptance criterion
"Approve the card. A PR opens against the failing branch" cannot pass without
this worker.

## Definition of "done" (the seam test)

**File:** `tests/test_capability_approve_execute.py`

**Test name:** `test_approve_triggers_tool_execution`

**Assertions in plain English:**
1. A `capability_credentials` row exists (builtin backend, provider_kind=github).
2. `execute_tool` is called with `tool_name="open_fix_pr"`, `blast_radius=MUTATE`. It
   returns `{"status":"consent_pending","approval_id":"<uuid>"}`.
3. The capability_audit table has one row with `event_type="consent_request"`.
4. `POST /api/v1/capabilities/approvals/<uuid>/decide` with `{"decision":"approve"}` is
   called against the running orchestrator.
5. Within 5 seconds, the capability_audit table gains a second row with
   `event_type="tool_call"` and `response_status="success"`, carrying the same
   `task_id` as the original consent_request row.
6. A second test, `test_reject_does_not_execute`, asserts that rejecting a pending
   approval does NOT produce a tool_call audit row within 5 seconds.
7. A third test, `test_expired_approval_is_not_executed`, creates an approval row
   with `expires_at = now() - 1 second` directly in the DB, then approves it; the
   worker must not execute it and must set `status='timeout'`.

The test uses the running orchestrator over HTTP (no in-process calls, no mocks).
The `underlying` tool callable is a fake async function registered for the test
that records invocations — this is the boundary fake (fake replaces GitHub API
endpoint, not Nova's own code). All orchestrator, postgres, redis layers are real.

## Files this task will touch

- **`orchestrator/app/capabilities/consent.py`** — `decide_approval()`: after
  flipping status to `approved`, push a message to the Redis execute queue
  (`nova:queue:approved_executions`) containing the approval_id. Do not execute
  inline — the approval endpoint is synchronous; execution happens in the worker.

- **`orchestrator/app/capabilities/executor.py`** — add `execute_approved(pool,
  approval_id)` function that re-hydrates the original tool call from the
  `approval_requests` row (`tool_name`, `tool_kind`, `args_redacted`, `task_id`,
  `tenant_id`) and the `tool_context` stored alongside it, then calls the
  underlying tool through the same `execute_tool` path minus the consent gate
  (gate is already decided). Write the `tool_call` audit row with the original
  `task_id`. On failure, write audit row with `response_status="error"`.

- **`orchestrator/app/capabilities/approval_worker.py`** — new file. BRPOP loop
  on `nova:queue:approved_executions`. For each dequeued approval_id, call
  `execute_approved()`. Runs as an `asyncio.create_task` in the orchestrator
  lifespan. Concurrency limit: `asyncio.Semaphore(3)`. Dead-letter on 3
  consecutive errors for the same approval_id (LPUSH to
  `nova:queue:approved_executions:dead`). Worker must close its Redis connection
  in the lifespan shutdown path.

- **`orchestrator/app/capabilities/router.py`** — `decide_approval` endpoint
  (lines 127-147): no interface change. The push to the Redis queue happens
  inside `consent.decide_approval()` so the endpoint stays thin.

- **`orchestrator/app/migrations/074_approval_execute_queue.sql`** — add
  `tool_context JSONB` column to `approval_requests` so the worker can
  re-hydrate execution context (tenant_id, user_id, task_id, credential_id,
  actor_kind, actor_id, provider_kind, target) without a cross-table join chain.
  This is NOT the args (those are in `args_redacted`) — this is the routing
  envelope. Migration must be idempotent (`ADD COLUMN IF NOT EXISTS`).

- **`orchestrator/app/main.py`** — in the lifespan `startup` block (around line
  154), add `asyncio.create_task(approval_worker_loop(), name="approval-worker")`.
  In the `shutdown` block, cancel and await it. Close its Redis connection via
  `close_approval_worker_redis()`.

- **`tests/test_capability_approve_execute.py`** — new file, 3 tests described above.

## Implementation outline

1. Write migration 074: `ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS
   tool_context JSONB`. Run `make up` to apply.

2. Modify `consent.gate()` to accept a `tool_context: dict` parameter and store it
   in the new column on INSERT. Callers are `capabilities/executor.py:execute_tool()`
   — pass the already-available tenant_id, user_id, task_id, credential_id,
   actor_kind, actor_id, provider_kind, target as the tool_context dict.

3. Modify `consent.decide_approval()`: after the UPDATE sets status to `approved`,
   call `await redis_enqueue_approval(approval_id)`. Use a lazily-initialized
   aioredis connection on Redis db2 (same db as orchestrator). Key:
   `nova:queue:approved_executions`. LPUSH the approval_id string.

4. Write `executor.execute_approved(pool, approval_id)`:
   - Fetch the `approval_requests` row (tenant_id, tool_name, tool_kind,
     args_redacted, task_id, tool_context, status).
   - If status != 'approved', log WARNING and return (idempotent).
   - Resolve tool_context → look up the `ToolCallable` for `tool_name` from
     `orchestrator/app/tools/github_external_tools.py` via a new
     `get_underlying_callable(tool_name) -> ToolCallable` helper.
   - Resolve the credential secret via `credentials.get_secret(pool, tenant_id,
     credential_id, actor)`.
   - Call the underlying callable directly (skip consent gate — already approved).
   - Write `capability_audit` row with `event_type="tool_call"`,
     `task_id` from the original row.
   - If the tool raises, write `event_type="tool_call"`, `response_status="error"`,
     re-raise to let the worker dead-letter it.

5. Write `approval_worker.py` with a `BRPOP_TIMEOUT = 5.0` second loop. On each
   dequeued item, call `execute_approved()`. Wrap in try/except; track consecutive
   failures per approval_id in a local dict; dead-letter at 3.

6. Wire into `main.py` lifespan.

7. Write the 3 integration tests. Tests must call the real HTTP endpoint
   (`POST /api/v1/capabilities/approvals/{id}/decide`) and then poll the DB for
   the expected audit row, with a 5-second timeout and 100ms poll interval.

## Behaviors the implementation must NOT change

- `execute_tool()` interface and return contract (`consent_pending` / `user_rejected`
  / result dict) must remain unchanged — callers in `tools/__init__.py:268-284`
  depend on it.
- `decide_approval()` must still return `bool` (True if decided, False if not found
  or already decided) — `router.py:141-146` depends on this.
- Existing consent tests in `tests/test_capability_consent.py` (11 tests) must all
  still pass — they test the gate and decision path, not the worker.
- The approval endpoint's HTTP response must remain `{"status":"ok"}` — the
  dashboard's `ApprovalCard.tsx` checks for this.
- The queue worker loop in `orchestrator/app/queue.py` must be unaffected.
- Redis db assignment: approval worker uses db2 (orchestrator's db). Do NOT use
  db1 (shared config) or db0 (memory-service).

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. Apply migrations cleanly
docker compose exec orchestrator python -c "from app.db import init_db; import asyncio; asyncio.run(init_db())"

# 2. Confirm new column exists
docker compose exec postgres psql -U nova nova -c "\d approval_requests" | grep tool_context

# 3. Run the new test file
pytest tests/test_capability_approve_execute.py -v

# 4. Confirm existing consent tests still pass
pytest tests/test_capability_consent.py -v

# 5. Confirm audit trail shape: consent_request row then tool_call row for same task_id
# (Replace <task_id> with one captured from test output)
docker compose exec postgres psql -U nova nova -c \
  "SELECT event_type, response_status, tool_name FROM capability_audit WHERE task_id='<task_id>' ORDER BY timestamp;"

# 6. Confirm worker is running and has no panics
docker compose logs orchestrator --since 2m | grep -E "approval-worker|execute_approved|ERROR"

# 7. Full integration suite must still pass
make test
```

## Out of scope

- Chat-bridge or Telegram/Slack approval paths (T1-02 depends on this completing first;
  chat-bridge approval is spec §12, v1.5+).
- DESTRUCT-tier tool execution (no DESTRUCT tools in v1).
- Retry logic for transient GitHub API failures (retries are the responsibility of
  the underlying tool, not the approval worker).
- MCP tool execution via the approved path (M12, deferred per assessment).
- Encryption key rotation (T2 territory per roadmap item 9).

## Risks / unknowns

- `args_redacted` stores the redacted version of args (secrets masked). The
  `open_fix_pr` tool needs the real args (branch name, patch content, base). Confirm
  whether the redaction in `orchestrator/app/capabilities/redactor.py` masks any
  fields that `open_fix_pr` actually needs at execution time. If it does, the
  tool_context needs to store a separate `args_for_execution` field — escalate
  rather than guess.
- The `execute_approved` function resolves the underlying callable by tool_name.
  Currently `tools/__init__.py` routes github_external calls through
  `_dispatch_github_external_via_capabilities()`. The worker bypasses that wrapper.
  Confirm the right callable to invoke is `github_external_tools.execute_tool(name,
  args, secret=secret, api_base=api_base)` directly. Check `tools/__init__.py:245-251`.
- If migration 074 already exists (e.g. another branch added it), write a new
  migration 075 instead. Never modify an already-applied migration file.
