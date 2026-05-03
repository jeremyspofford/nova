# T2-04: Cortex Daily Webhook Health Ping

**Tier:** 2  **Size:** S  **Blocks:** none  **Blocked by:** none

## Why this task exists

Closes G11 from `docs/audits/2026-05-03-readiness-assessment.md`. Spec §9.1
specifies: "cortex maintain drive runs daily, pinging each `github_webhooks`
row's hook_id." No code in `cortex/app/drives/maintain.py` does this. A webhook
whose GitHub hook_id was silently invalidated (account permissions changed, repo
transferred, hook deleted via the GitHub UI) will never be detected. Nova continues
to believe it is receiving events when it is not. The polling fallback catches most
failures, but the "webhook is down" state is never surfaced to the user.

Production-shape failure: a user's GitHub PAT expires. The webhook stops receiving
events. Nova still shows the webhook as `verified` in the dashboard. The user
never sees an alert and doesn't know why triage has slowed to the polling interval.

## Definition of "done" (the seam test)

**File:** `tests/test_capability_webhook_health_wiring.py`

**Test name:** `test_maintain_drive_marks_failed_webhook_and_alerts`

**Assertions in plain English:**
1. A `github_webhooks` row exists with `status='verified'` and a valid `hook_id`.
2. The test configures a `fake_github` server that returns 404 for the
   `POST /repos/{owner}/{repo}/hooks/{hook_id}/pings` endpoint.
3. The new `_ping_webhooks(ctx)` function in `maintain.py` is called.
4. After the call, `github_webhooks.status` for that row is `'failed'`.
5. A stimulus `github.webhook_failed` was emitted with `{"hook_id": ..., "repo": ...}`
   as payload.
6. The `last_pinged_at` timestamp on the row was updated.

**Second test:** `test_healthy_webhook_stays_verified` — fake_github returns 204
for the ping. After `_ping_webhooks()`, the row stays `verified` and no stimulus
is emitted.

Tests call the function under test directly (not via cortex HTTP), using the real
postgres pool. `fake_github` fixture stands in for `api.github.com`.

## Files this task will touch

- **`orchestrator/app/capabilities/router.py`** — add admin endpoint
  `POST /api/v1/capabilities/webhooks/ping-all` that: fetches all
  `github_webhooks` rows with `status IN ('active','verified')`, for each:
  resolves the credential secret, calls `POST /repos/{owner}/{repo}/hooks/{id}/pings`
  via httpx, updates the row's `status` and `last_pinged_at`, returns a summary
  dict. This is called by cortex's maintain drive.

- **`cortex/app/drives/maintain.py`** — add `async def _ping_webhooks(ctx)` that
  calls `GET /api/v1/capabilities/webhooks/ping-all` on the orchestrator (authenticated
  via the cortex API key / admin secret). For each failed ping in the response,
  emit a `github.webhook_failed` stimulus. Wire into `assess()` under the same
  time gate as `_run_verify_chain()` (daily window 2-4 AM UTC or explicit stimulus).

- **`tests/test_capability_webhook_health_wiring.py`** — new file, 2 tests.

## Implementation outline

1. Write `POST /api/v1/capabilities/webhooks/ping-all` in `capabilities/router.py`:
   - Fetch all `github_webhooks` rows with `status IN ('active','verified')`.
   - For each, decrypt the `encrypted_secret` via `cred_db.get_secret()` (already
     exists).
   - Call `POST https://api.github.com/repos/{owner}/{repo}/hooks/{hook_id}/pings`
     with `Authorization: token {secret}` via `httpx.AsyncClient`.
   - If response is 204: update `last_pinged_at = now()`. No status change.
   - If response is not 204 (404 → hook not found, 401/403 → auth failure):
     update `status='failed'`, `last_pinged_at=now()`.
   - Return `{"pinged": n, "failed": [{"hook_id": ..., "repo": ..., "status_code": ...}]}`.

2. In `cortex/app/drives/maintain.py`, add `_ping_webhooks(ctx)` following the
   same pattern as `_run_verify_chain()`.

3. Update `assess()` to call both under the time gate.

4. Write 2 integration tests. Use `fake_github_url` as `api_base` override
   (the orchestrator's ping-all endpoint must accept an `api_base` override for
   tests — add it as an optional query param `api_base` gated by admin-only access).

## Behaviors the implementation must NOT change

- The webhook receiver (`POST /api/v1/webhooks/github`) must not be affected.
- Existing `tests/test_capability_webhooks.py` (5 tests) must still pass.
- The `github_webhooks.status` state machine transitions must only move in the
  defined direction: `verified → failed` on ping failure, never `failed → verified`
  via ping (re-verification requires re-registration, which goes through the consent
  gate per T1-02).

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. New health tests
pytest tests/test_capability_webhook_health_wiring.py -v

# 2. Existing webhook tests still pass
pytest tests/test_capability_webhooks.py -v

# 3. Cortex drive tests still pass
pytest tests/test_drive_scheduling.py tests/test_cortex_loop.py -v

# 4. Hit the ping-all endpoint directly
curl -s -X POST http://localhost:8000/api/v1/capabilities/webhooks/ping-all \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" | python3 -m json.tool

# 5. Verify webhook rows (check any 'failed' rows are as expected)
docker compose exec postgres psql -U nova nova -c \
  "SELECT repo, status, last_pinged_at FROM github_webhooks ORDER BY last_pinged_at DESC LIMIT 10;"
```

## Out of scope

- Auto-re-bootstrap of failed webhooks (spec §9.1 mentions this but it requires
  the full T1-02 consent path to be solid first). Surface the failure, let the
  user decide to re-register via the dashboard.
- Pinging webhooks more frequently than daily. The polling fallback is the real
  safety net at higher cadence.
- Per-webhook alert deduplication (don't emit a new stimulus on every daily ping
  if the webhook is already `failed` — skip pinging `failed` rows).

## Risks / unknowns

- The GitHub ping endpoint requires `admin:repo_hook` scope on the PAT. If the
  credential doesn't have this scope (it was created with only `repo`), the ping
  returns 403. Handle 403 the same as 404: mark as `failed`. Surface the scope
  issue in the response so the user knows what to fix.
- `cortex/app/drives/maintain.py` currently uses `get_orchestrator()` from
  `cortex/app/clients.py` to call the orchestrator. Confirm the client's base URL
  and auth header before adding the new endpoint calls.
