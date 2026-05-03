# T2-05: Fix ci_triage_agent allowed_tools Phantom Names

**Tier:** 2  **Size:** S  **Blocks:** none  **Blocked by:** none

## Why this task exists

Closes G3 from `docs/audits/2026-05-03-readiness-assessment.md`. Migration
`073_ci_triage_agent_pod.sql:30-31` specifies `get_run_details` and `get_check_runs`
in the Task Agent's `allowed_tools`. Neither tool exists — the actual tool names
in `orchestrator/app/tools/github_external_tools.py` are `get_workflow_run` and
`get_run_logs` (and 10 others). When the Task Agent calls `get_run_details(...)`,
the dispatcher returns `"Unknown tool 'get_run_details'. Available: [...]"`. The
agent wastes a turn recovering, which degrades triage quality and wastes LLM budget.

This is the smallest Tier 2 fix — a single migration that corrects the names.

## Definition of "done" (the seam test)

**File:** `tests/test_ci_triage_pod_allowed_tools.py`

**Test name:** `test_ci_triage_task_agent_allowed_tools_are_registered`

**Assertions in plain English:**
1. Query the `pod_agents` table for the row where `pod_id = (SELECT id FROM pods
   WHERE name='ci_triage_agent')` and `role='task'`.
2. For each name in `allowed_tools`, verify it exists in the set of all registered
   tool names (`orchestrator/app/tools/__init__.py:ALL_TOOLS`).
3. The names `get_run_details` and `get_check_runs` must NOT be present.
4. The names `get_workflow_run` and `get_run_logs` must be present.

The test calls the orchestrator via HTTP: `GET /api/v1/pods` or `GET /api/v1/agents`
to fetch the pod's agents, then checks the `allowed_tools` list. It also calls
`GET /api/v1/tools` (or equivalent) to get the full registered tool list.
Real DB, no mocks.

## Files this task will touch

- **`orchestrator/app/migrations/07X_ci_triage_allowed_tools_fix.sql`** — next
  available migration number. Contains:
  ```sql
  UPDATE pod_agents
  SET allowed_tools = array_replace(
      array_replace(allowed_tools, 'get_run_details', 'get_workflow_run'),
      'get_check_runs', 'get_run_logs'
  )
  WHERE pod_id = (SELECT id FROM pods WHERE name = 'ci_triage_agent')
    AND role = 'task';
  ```
  Idempotent: if the names are already corrected, `array_replace` is a no-op.

- **`tests/test_ci_triage_pod_allowed_tools.py`** — new file, 1 test.

## Implementation outline

1. Determine the next migration number.
2. Write the single-statement migration.
3. Apply it: restart the orchestrator or run `docker compose exec orchestrator
   python -c "from app.db import init_db; import asyncio; asyncio.run(init_db())"`.
4. Write the test.

## Behaviors the implementation must NOT change

- No other `pod_agents` rows must be modified by this migration.
- The Context, Guardrail, and Decision agent rows for `ci_triage_agent` must have
  their `allowed_tools` unchanged.
- Migration 073 must not be modified — it is already applied.

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. Confirm migration applied
docker compose exec postgres psql -U nova nova -c \
  "SELECT role, allowed_tools FROM pod_agents pa
   JOIN pods p ON pa.pod_id = p.id
   WHERE p.name = 'ci_triage_agent' AND pa.role = 'task';"
# Expected: get_workflow_run and get_run_logs present; get_run_details and get_check_runs absent

# 2. Run the new test
pytest tests/test_ci_triage_pod_allowed_tools.py -v

# 3. Confirm the dispatcher doesn't return "Unknown tool" for the new names
# (Requires a running orchestrator)
curl -s -X POST http://localhost:8000/api/v1/tools/dispatch \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name":"get_run_details","arguments":{}}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin); assert 'Unknown tool' in str(r) or 'get_run_details' in str(r); print(r)"
# After fix: "get_run_details" call should return "Unknown tool" confirming it's gone
# and get_workflow_run should succeed (with a missing repo arg error, not "Unknown tool")
```

## Out of scope

- Reviewing whether `list_workflow_runs` should be in `allowed_tools` for the Task
  Agent. The existing list in migration 073 includes many valid tools; only the two
  phantom names are corrected here.
- Updating the system prompt in 073 which mentions "fetching workflow details" —
  the prompt is close enough; the tool rename does not break its meaning.

## Risks / unknowns

- `array_replace` requires PostgreSQL 9.3+. This stack uses PostgreSQL 16 — no
  concern.
- If the `pod_agents.allowed_tools` column is of type `TEXT[]`, `array_replace` works
  directly. Confirm with `\d pod_agents`.
- If a previous migration already corrected these names on the running instance
  (manual fix not captured in a migration), the `array_replace` is a no-op and
  the migration is still safe to apply.
