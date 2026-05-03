# T1-02: register_webhook Through Consent Gate

**Tier:** 1  **Size:** M  **Blocks:** T1-03  **Blocked by:** T1-01

## Why this task exists

Closes G2 from `docs/audits/2026-05-03-readiness-assessment.md`. The
`POST /api/v1/webhooks/github/register` endpoint in
`orchestrator/app/webhooks_router.py:36-72` calls `_register_webhook(...)` directly
— supplying an admin-resolved secret — without going through
`capabilities.executor.execute_tool`. The `register_webhook` tool is classified
`BlastRadius.MUTATE` in `github_external_tools.py:222`, so every first-time
webhook creation silently bypasses the consent gate the spec §9.1 promised to
exercise. No approval card is created; no audit row with `event_type=consent_request`
is written; and the auto-bootstrap consent rule (scoped to re-registrations for
that repo) is never created.

Production-shape failure: a user adds a watched repo with "Webhook + polling
fallback" mode, clicks Register in the dashboard modal, and the webhook is created
without any approval card appearing — no demonstration of the consent platform at
setup time, no audit trail, no auto-rule for re-bootstraps.

This task also depends on T1-01 because the consent gate will create an
`approval_requests` row, and the only useful path for the user is the approve →
execute worker delivering the actual webhook creation. Without T1-01, approving
the card would do nothing.

## Definition of "done" (the seam test)

**File:** `tests/test_capability_webhooks_consent.py`

**Test name:** `test_register_webhook_surfaces_approval_card`

**Assertions in plain English:**
1. A `capability_credentials` row (github, PAT) exists.
2. A watched repo row exists pointing at that credential.
3. `POST /api/v1/webhooks/github/register` is called with `repo`, `target_url`,
   `credential_id`.
4. The response HTTP status is 202 (Accepted, not 201 Created) — the webhook
   creation is pending consent.
5. The response body contains `{"status":"consent_pending","approval_id":"<uuid>"}`.
6. `GET /api/v1/capabilities/approvals` returns exactly one pending approval for
   `tool_name="register_webhook"` and `blast_radius="mutate"`.
7. `POST /api/v1/capabilities/approvals/<uuid>/decide` with `{"decision":"approve",
   "remember":true, "rule_scope":{"target_glob":"repos/owner/repo/*"}}` returns 200.
8. Within 5 seconds, `github_webhooks.status` for the repo transitions to `active`
   or `verified` (using a fake-github server at boundary).
9. A `consent_rules` row exists with `tool_name="register_webhook"` and
   `scope_match.target_glob` scoped to that specific repo, `source="user_remember"`.
10. Second test `test_register_webhook_auto_approved_by_rule`: if a consent_rule
    for `register_webhook` scoped to the same repo already exists, the register
    endpoint returns 201 immediately and no pending approval is created.

Test uses the running orchestrator (real HTTP), real postgres and redis, and a
`fake_github` pytest fixture (from `tests/fixtures/fake_github.py`) standing in for
`api.github.com`. No mocks of Nova's internal code.

## Files this task will touch

- **`orchestrator/app/webhooks_router.py`** — `register_webhook` endpoint (lines
  36-72): stop calling `_register_webhook()` directly. Instead, call
  `capabilities.executor.execute_tool()` with `tool_name="register_webhook"`,
  `blast_radius=BlastRadius.MUTATE`, `tool_kind="native"`, the resolved
  `credential_id`, and `args={"repo":..., "target_url":..., "events":...,
  "credential_id":str(credential_id)}`. The `underlying` callable wraps
  `_register_webhook`. Return 202 when result is `consent_pending`; return 200/201
  when the tool executed synchronously (auto-approved via rule).

- **`orchestrator/app/webhooks_router.py`** — change `WebhookRegisterRequest`
  response model: when consent is pending, return `{"status":"consent_pending",
  "approval_id":"<uuid>"}` with HTTP 202. When auto-approved, return the existing
  result dict with HTTP 201.

- **`orchestrator/app/migrations/075_approval_webhook_tool_context.sql`** — if
  migration 074 (tool_context column) was added by T1-01, this migration may be a
  no-op or can be skipped. Confirm the column exists before writing a new
  migration; if it does, this task requires no new migration.

- **`tests/test_capability_webhooks_consent.py`** — new test file, 2 tests described
  above.

- **`tests/fixtures/fake_github.py`** — if this file doesn't yet exist, create it.
  Minimal FastAPI app implementing `POST /repos/{owner}/{repo}/hooks` → returns
  `{"id": 99999, "active": true}` and `DELETE /repos/{owner}/{repo}/hooks/{id}` →
  204. The fixture is a session-scoped pytest async fixture that starts the server
  on a free port and passes the base URL to tests via a `fake_github_url` fixture.

- **`dashboard/src/pages/settings/ConnectedServicesSection.tsx`** — the
  `registerWebhook` API call currently expects a 201 and the webhook row back.
  Update it to handle 202 with `approval_id`: show a toast "Approval pending —
  check Pending Approvals" and link to `/approvals`. No modal close on 202.

## Implementation outline

1. Confirm the `tool_context` column exists on `approval_requests` (T1-01 must be
   done). If it does not, this task cannot proceed — escalate.

2. Refactor `register_webhook` endpoint to build a `tool_context` dict and call
   `capabilities.executor.execute_tool()`:
   - `tenant_id` = hardcoded DEFAULT_TENANT for now (same as before; G6 addressed
     in T2-01)
   - `user_id` = DEFAULT_USER
   - `task_id` = None (setup-time action, no associated pipeline task)
   - `actor_kind` = "human"
   - `actor_id` = "admin"
   - `credential_id` = body.credential_id
   - The `underlying` callable calls `_register_webhook(args, secret=secret,
     api_base=api_base)`.

3. Update response handling: if `result["status"] == "consent_pending"`, return
   `JSONResponse({"status":"consent_pending","approval_id":result["approval_id"]},
   status_code=202)`. Otherwise return `JSONResponse(result, status_code=201)`.

4. Create `tests/fixtures/fake_github.py` if absent. Implement the minimum GitHub
   API surface needed: `POST /repos/.../hooks` returns hook JSON; `DELETE
   /repos/.../hooks/{id}` returns 204.

5. Write `tests/test_capability_webhooks_consent.py` with 2 tests. Use
   `NOVA_ADMIN_SECRET` and `ORCHESTRATOR_URL` from conftest. The `fake_github_url`
   must be passed as `api_base` in the `WebhookRegisterRequest` so the orchestrator
   calls the fake, not `api.github.com`.

6. Update `ConnectedServicesSection.tsx`: handle HTTP 202 in the webhook register
   response — display toast, do not close modal, link to `/approvals`.

7. Confirm the auto-bootstrap consent rule (created when the user clicks "Approve
   and remember" in step 7 of the seam test) has `scope_match.target_glob` scoped
   to `"repos/{owner}/{repo}/*"` — this is the "auto re-bootstrap" rule from
   spec §9.1. The scope must NOT be `"*"` (P3 in the assessment). The
   `target_glob` should be inferred from `args["repo"]`.

## Behaviors the implementation must NOT change

- `DELETE /api/v1/webhooks/github/{hook_id}` (unregister) is not touched — it is an
  admin-direct path and is acceptable in v1. Only `register` goes through the gate.
- `POST /api/v1/webhooks/github` (the receiver endpoint for incoming events) is
  NOT touched — it is already HMAC-validated and has no consent concern.
- Existing webhook tests in `tests/test_capability_webhooks.py` (5 tests) must
  still pass — those test the receiver path, not the register path.
- `tests/test_capability_cortex_wiring.py` (7 tests) must still pass.
- `ConnectedServicesSection.tsx` must still handle the happy-path 201 (auto-approved
  via rule) identically to before.

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. New consent flow tests
pytest tests/test_capability_webhooks_consent.py -v

# 2. Existing webhook receiver tests still pass
pytest tests/test_capability_webhooks.py -v

# 3. Cortex wiring tests still pass
pytest tests/test_capability_cortex_wiring.py -v

# 4. Dashboard TypeScript compiles cleanly
cd /home/jeremy/workspace/nova/dashboard && npm run build 2>&1 | tail -20

# 5. End-to-end: call the register endpoint and verify 202 is returned
curl -s -o /dev/null -w "%{http_code}" \
  -X POST http://localhost:8000/api/v1/webhooks/github/register \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"repo":"jeremyspofford/nova-test-cap","target_url":"https://example.invalid/hook","credential_id":"<your-cred-id>","api_base":"http://localhost:<fake_port>"}'
# Expected: 202

# 6. Verify an approval row was created
curl -s http://localhost:8000/api/v1/capabilities/approvals \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" | python3 -m json.tool | grep register_webhook

# 7. Full test suite
make test
```

## Out of scope

- Routing the `unregister_webhook` tool through the consent gate (it is admin-direct
  in v1; users don't unregister autonomously yet).
- P5 UX improvements to the modal (diff preview, scope warning). Those are Tier 3.
- P7 PAT scope warning before registration. Also Tier 3.
- Multi-tenant consent (still uses DEFAULT_TENANT here; T2-01 addresses G6).

## Risks / unknowns

- The fake_github fixture: if `tests/fixtures/` directory does not exist, create it
  with an `__init__.py`. Confirm the pytest fixture is importable from `conftest.py`.
  If a fake-github server already exists elsewhere in the test tree, use it rather
  than creating a second one.
- `target_glob` inference from `args["repo"]`: `args["repo"]` is in the form
  `"owner/name"`. The target_glob should be `f"repos/{args['repo']}/*"`. Confirm
  this matches the format used in `consent._matches()` (line 133 checks against
  `target`, which is `arguments.get("repo")` in `tools/__init__.py:279`). If
  `target` is set to `"owner/name"` but the glob is `"repos/owner/name/*"`, they
  won't match. Trace the actual `target` value and set the glob to match it exactly.
