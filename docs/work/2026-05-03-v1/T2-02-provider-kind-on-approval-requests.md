# T2-02: provider_kind Column on approval_requests

**Tier:** 2  **Size:** S  **Blocks:** none  **Blocked by:** none

## Why this task exists

Closes G4 from `docs/audits/2026-05-03-readiness-assessment.md`. In
`orchestrator/app/capabilities/consent.py:207`, `decide_approval()` hardcodes:

```python
"github",  # FIXME: derive from approval row context
```

when inserting into `consent_rules.provider_kind`. The `approval_requests` table
(migration 070) has no `provider_kind` column, so the actual provider for a
given approval cannot be read back without a join. When a second provider (Cloudflare,
AWS, Slack) lands in M12, any user who approves-and-remembers a Cloudflare MUTATE
call will get a `consent_rules` row with `provider_kind='github'` — causing
unexpected auto-approvals of GitHub tools matching the same `tool_name`.

The FIXME comment at `consent.py:207` is a load-bearing blocker for M12. This
task removes it.

## Definition of "done" (the seam test)

**File:** `tests/test_capability_provider_kind_propagation.py`

**Test name:** `test_provider_kind_stored_and_used_in_consent_rule`

**Assertions in plain English:**
1. `consent.gate()` is called with `provider_kind="github"` and `tool_name="open_fix_pr"`,
   `blast_radius=MUTATE`. An approval row is created.
2. `SELECT provider_kind FROM approval_requests WHERE id = <approval_id>` returns
   `"github"`.
3. `decide_approval()` is called with `remember=True` and a `rule_scope` dict.
4. The resulting `consent_rules` row has `provider_kind="github"` — matching the
   value from the approval row, not a hardcode.
5. Second call: `consent.gate()` with `provider_kind="cloudflare"` and the same
   `tool_name`. Approval row created with `provider_kind="cloudflare"`.
6. `decide_approval()` with `remember=True` creates a `consent_rules` row with
   `provider_kind="cloudflare"`.
7. Verify the "github" rule does NOT auto-approve a "cloudflare" MUTATE call for
   the same tool_name — `consent.gate()` with `provider_kind="cloudflare"` still
   returns `action="pending"` because the rule is scoped to github.

Test calls the DB functions directly (via `asyncpg` pool fixture), not HTTP.
Real postgres, no mocks.

## Files this task will touch

- **`orchestrator/app/migrations/07X_approval_requests_provider_kind.sql`** — add
  `provider_kind TEXT` column to `approval_requests` with
  `ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS provider_kind TEXT`. No
  CHECK constraint in the migration (it will be validated by the application layer).
  Idempotent.

- **`orchestrator/app/capabilities/consent.py`** — `gate()` function: add
  `provider_kind: str | None` to the INSERT into `approval_requests`. The column
  already exists on the gate() signature; propagate it to the INSERT. Change the
  INSERT SQL at line 76-91 to include `provider_kind`.

- **`orchestrator/app/capabilities/consent.py`** — `decide_approval()` at lines
  193-210: remove the hardcoded `"github"` string. Instead: read `provider_kind`
  from the `row` fetched at line 185 (`SELECT * FROM approval_requests ...`). Use
  `row["provider_kind"] or "github"` as the fallback for rows created before this
  migration (backwards compatibility for existing rows with NULL provider_kind).
  Remove the `# FIXME` comment.

- **`tests/test_capability_provider_kind_propagation.py`** — new file, 1 test with
  7 assertions as described above.

## Implementation outline

1. Determine the next migration number. Write the `ADD COLUMN IF NOT EXISTS` migration.

2. Update `consent.gate()`: the `provider_kind` parameter is already on the
   function signature (line 41). Add it to the INSERT columns list and bind
   parameters. No other changes to `gate()`.

3. Update `decide_approval()`: replace line 207 `"github"` with
   `row["provider_kind"] or "github"` (the `or "github"` handles rows created by
   older code with a NULL column).

4. Write the test. The test can use the `pool` fixture from `conftest.py` (the
   existing tests in `test_capability_consent.py` show this pattern).

5. Confirm the FIXME comment is removed.

## Behaviors the implementation must NOT change

- All 11 existing tests in `tests/test_capability_consent.py` must pass. Those
  tests pass `provider_kind="github"` to `consent.gate()` — the INSERT change is
  additive and backward-compatible.
- `test_remember_creates_consent_rule` at line 123 of `test_capability_consent.py`
  must still create a working rule. The only change is that `provider_kind` is now
  stored from the approval row instead of hardcoded — result is identical for
  tests that pass `provider_kind="github"`.
- The `_find_matching_rule()` function at line 94 of `consent.py` already queries
  by `provider_kind` (line 120). No change needed there.

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. Apply migration
docker compose exec postgres psql -U nova nova -c "\d approval_requests" | grep provider_kind

# 2. New test
pytest tests/test_capability_provider_kind_propagation.py -v

# 3. Existing consent tests all pass
pytest tests/test_capability_consent.py -v

# 4. Confirm FIXME is gone
grep -n "FIXME" orchestrator/app/capabilities/consent.py
# Expected: no output

# 5. Confirm provider_kind is written to DB on a live approval creation
curl -s -X POST http://localhost:8000/api/v1/capabilities/approvals/test-trigger \
  2>/dev/null || true
# Then inspect the most recent approval row:
docker compose exec postgres psql -U nova nova -c \
  "SELECT tool_name, provider_kind, status FROM approval_requests ORDER BY created_at DESC LIMIT 3;"
```

## Out of scope

- Adding `provider_kind` to the dashboard Pending Approvals panel display. The
  column is internal plumbing; the panel shows tool_name + args_redacted which is
  sufficient for v1.
- Validating provider_kind against an enum. Keep it TEXT in v1; a CHECK constraint
  can be added when the second provider lands.
- `G5` (`_DEFAULT_USER` in the consent_rules insert). That is addressed in T2-01
  which resolves the full auth context; this task only removes the `provider_kind`
  FIXME.

## Risks / unknowns

- Rows in `approval_requests` created before this migration will have
  `provider_kind = NULL`. The `or "github"` fallback in `decide_approval()` handles
  these. But `_find_matching_rule()` passes `provider_kind` to the WHERE clause —
  a NULL in the DB will cause a miss against a rule with `provider_kind='github'`.
  If this matters for existing rows, backfill with:
  `UPDATE approval_requests SET provider_kind='github' WHERE provider_kind IS NULL AND tool_name IN ('open_fix_pr','comment_on_pr','register_webhook','unregister_webhook');`
  Add this to the migration.
