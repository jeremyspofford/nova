# T2-03: Wire verify_chain into Cortex Maintain Drive

**Tier:** 2  **Size:** S  **Blocks:** none  **Blocked by:** none

## Why this task exists

Closes G10 from `docs/audits/2026-05-03-readiness-assessment.md`. The function
`verify_chain()` in `orchestrator/app/capabilities/audit.py:123-170` walks the
per-tenant hash chain and returns a `ChainResult`. No caller in the codebase
invokes it. Spec §8.2 promised: "Nightly maintain drive job re-walks each
tenant's chain; any break is reported as a security event." The audit-tamper
detection claim in the docs is aspirational without this.

Production-shape failure: a compromised row in `capability_audit` goes
undetected indefinitely. The hash-chain field exists and is cryptographically
valid, but nobody is watching it.

## Definition of "done" (the seam test)

**File:** `tests/test_capability_verify_chain_wiring.py`

**Test name:** `test_maintain_drive_detects_tampered_audit_row`

**Assertions in plain English:**
1. Three audit rows are inserted for `DEFAULT_TENANT` via `audit.write_audit_event()`.
2. One row's `response_summary` is directly updated in postgres (bypass the
   append-only RULE by using a superuser connection or by temporarily granting
   UPDATE directly in the test — confirm the RULE blocks app-role UPDATEs but
   a superuser can still update for test purposes).
3. The cortex `maintain` drive's `assess()` function is called with a context that
   includes a `security.verify_chain` stimulus (or the nightly schedule fires —
   but since this is an integration test, call the new function directly).
4. The result `DriveResult.proposed_action` contains `"audit_chain_broken"` or the
   stimulus emitted is `security.audit_chain_broken`.
5. `docker compose logs orchestrator --since 1m | grep audit_chain_broken` shows
   an ERROR-level log.

**Second test:** `test_maintain_drive_reports_healthy_chain` — after inserting 5
valid audit rows, calling the verify_chain path returns `is_valid=True` and no
security stimulus is emitted.

Tests call `audit.verify_chain(pool, tenant_id=DEFAULT_TENANT)` directly and also
call the maintain drive's new code path. Real postgres, no mocks.

## Files this task will touch

- **`cortex/app/drives/maintain.py`** — add a new async function
  `_run_verify_chain(ctx: DriveContext)` that:
  1. Gets the orchestrator's DB pool (via `get_pool()` imported from cortex's DB
     module — confirm cortex connects to the same postgres instance; check
     `cortex/app/db.py`).
  2. Queries `SELECT DISTINCT tenant_id FROM capability_audit` to get all tenants
     with audit rows.
  3. For each tenant, calls `await audit.verify_chain(pool, tenant_id=tenant_id)`.
  4. If `result.is_valid is False`, logs `ERROR` with `broken_at=result.broken_at`
     and emits a stimulus `security.audit_chain_broken` with payload
     `{"tenant_id": str(tenant_id), "broken_at_id": str(result.broken_at)}` via
     `orchestrator/app/stimulus.py:emit_stimulus`.
  5. Returns `{"checked": n_tenants, "broken": n_broken}`.
  Call `_run_verify_chain(ctx)` from within `assess()` — but only when the
  current UTC hour is between 2 and 4 AM (nightly window) OR when a
  `security.verify_chain` stimulus is present in `ctx`. This prevents hammering
  the DB on every drive cycle.

- **`cortex/app/drives/maintain.py`** — modify `assess()` to call
  `_run_verify_chain(ctx)` under the time-gate condition.

- **`cortex/app/drives/maintain.py`** — update the `SERVICES` list: the `audit`
  module import needs to be available in cortex's environment. The audit module
  lives in `orchestrator/app/capabilities/audit.py`. Either: (a) add an HTTP
  endpoint `POST /api/v1/capabilities/audit/verify-chain` to the orchestrator and
  call it from cortex via HTTP (preferred — maintains service boundaries), or (b)
  import the orchestrator's audit module directly (only works if cortex and
  orchestrator share a Python path, which they do not in Docker). Use option (a).

- **`orchestrator/app/capabilities/router.py`** — add a new admin endpoint
  `POST /api/v1/capabilities/audit/verify-chain` that calls `audit.verify_chain()`
  for all tenants and returns `{"tenants": [{"tenant_id": ..., "is_valid": ...,
  "row_count": ..., "broken_at": ...}]}`. Admin-only. No auth change needed
  since cortex calls it with the cortex API key.

- **`tests/test_capability_verify_chain_wiring.py`** — new file, 2 tests.

## Implementation outline

1. Write the orchestrator HTTP endpoint
   `POST /api/v1/capabilities/audit/verify-chain`. It queries all distinct
   `tenant_id` values from `capability_audit`, calls `verify_chain()` for each,
   and returns the results.

2. In `cortex/app/drives/maintain.py`, write `_run_verify_chain(ctx)` that:
   - Calls the orchestrator endpoint via `get_orchestrator().post(
     "/api/v1/capabilities/audit/verify-chain", ...)`.
   - Parses the response. For any tenant where `is_valid=False`, emits the
     `security.audit_chain_broken` stimulus.

3. Wire `_run_verify_chain(ctx)` into `assess()` under a time gate: only run if
   `2 <= datetime.utcnow().hour <= 4` or `ctx.stimuli_of_type("security.verify_chain")`.

4. Write 2 integration tests. For test 1: directly insert a tampered row using the
   postgres superuser (`nova` user has superuser privileges in the dev setup — verify
   with `\du` in psql) to bypass the RULE. Then call the HTTP endpoint and assert.

## Behaviors the implementation must NOT change

- `audit.verify_chain()` function signature and return type (`ChainResult`) must not
  change — `tests/test_capability_audit.py` tests it directly.
- The maintain drive's existing service health-check logic and triage dispatch must
  not be affected. The new code is additive.
- `tests/test_cortex_loop.py` and `tests/test_drive_scheduling.py` must still pass.

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. New wiring tests
pytest tests/test_capability_verify_chain_wiring.py -v

# 2. Existing audit tests still pass
pytest tests/test_capability_audit.py tests/test_capability_audit_query.py -v

# 3. Cortex drive tests still pass
pytest tests/test_drive_scheduling.py tests/test_cortex_loop.py -v

# 4. Hit the new orchestrator endpoint
curl -s -X POST http://localhost:8000/api/v1/capabilities/audit/verify-chain \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" | python3 -m json.tool

# 5. Confirm maintain drive calls the endpoint (check cortex logs after its next cycle)
docker compose logs cortex --since 5m | grep -E "verify_chain|audit_chain"
```

## Out of scope

- Real-time tamper alerting (dashboard notification, email). The stimulus
  `security.audit_chain_broken` is the alert; a notification UI is a separate task.
- Cross-tenant chain coordination. Each tenant's chain is independent; no change.
- Modifying the `RULE` that blocks UPDATEs/DELETEs — it is working correctly.

## Risks / unknowns

- Cortex and orchestrator are separate services. Cortex must not import orchestrator
  Python modules directly. The HTTP endpoint approach is correct but requires the
  cortex API key to be accepted by the orchestrator's admin auth. Verify that
  `settings.cortex_api_key` in cortex matches an accepted auth credential in
  orchestrator. If cortex uses `X-Admin-Secret`, use that header. Check
  `cortex/app/clients.py` for how cortex authenticates to orchestrator.
- The `nova` postgres user may not be a superuser. Check with `SELECT
  pg_has_role(current_user, 'superuser')`. If not superuser, the test cannot bypass
  the RULE with that user. Use `ALTER TABLE ... DISABLE RULE` in the test setup
  and `ENABLE RULE` in teardown — or insert the tampered row via a direct asyncpg
  connection with a superuser (`postgres` user).
