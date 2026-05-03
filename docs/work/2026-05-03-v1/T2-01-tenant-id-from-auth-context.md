# T2-01: Resolve tenant_id from Auth Context in Capabilities Router

**Tier:** 2  **Size:** M  **Blocks:** none  **Blocked by:** none (parallel with T1)

## Why this task exists

Closes G6 and G7 from `docs/audits/2026-05-03-readiness-assessment.md`.
`orchestrator/app/capabilities/router.py:35-36` and
`orchestrator/app/pipeline/executor.py:1273-1274` both define:

```python
DEFAULT_TENANT = UUID("00000000-0000-0000-0000-000000000001")
DEFAULT_USER   = UUID("00000000-0000-0000-0000-000000000001")
```

These are used in every capabilities endpoint — credentials, approvals, consent
rules, audit query, watched repos — regardless of which authenticated user is
making the request. A second user in a shared Nova instance sees every credential
and every approval belonging to "user 1." The DB schema (migration 068+) has
`tenant_id` and `user_id` columns on every table; the routing layer simply ignores
them. The assessment notes ~19 hardcoded references across `router.py` alone.

Production-shape failure: two users share a Nova instance. User B can read User A's
GitHub PAT health status, see their pending approvals, and create consent rules in
User A's name. This is a data-isolation violation that blocks the "real users" claim.

Do NOT fix these one-by-one. The assessment explicitly says: "Solve G6 once with a
proper auth → tenant_id resolver dependency in FastAPI; replace all hardcodes in
one PR."

## Definition of "done" (the seam test)

**File:** `tests/test_fc002_capabilities_tenant_isolation.py`

**Test name:** `test_user_a_cannot_read_user_b_credentials`

**Assertions in plain English:**
1. User A logs in via `POST /api/v1/auth/login`, gets a JWT.
2. User B logs in similarly.
3. User A creates a capability credential via `POST /api/v1/capabilities/credentials`
   with User A's JWT in the `Authorization: Bearer` header.
4. User B calls `GET /api/v1/capabilities/credentials`. The response does NOT
   contain User A's credential.
5. User B calls `GET /api/v1/capabilities/credentials/{user_a_cred_id}`. Returns 404.

**Second test:** `test_user_a_cannot_see_user_b_approvals` — User A's pending
approval is not visible in User B's `GET /api/v1/capabilities/approvals` list.

**Third test:** `test_user_a_consent_rule_does_not_apply_to_user_b` — User A
creates a consent rule. A MUTATE call made under User B's context does NOT
auto-approve via User A's rule.

All three tests use real HTTP against the running orchestrator; both users have
real JWT auth credentials (created via the auth registration endpoint).

## Files this task will touch

- **`orchestrator/app/capabilities/router.py`** — replace the `DEFAULT_TENANT` /
  `DEFAULT_USER` pattern with a FastAPI dependency `CurrentCapabilityContext` that
  extracts `tenant_id` and `user_id` from the authenticated user. The dependency
  accepts either `AdminDep` (for admin-secret requests) or `UserDep` (for JWT
  requests). For admin-secret callers, fall back to `DEFAULT_TENANT` (admin calls
  are tenant-scoped by convention in v1). For JWT callers, read `tenant_id` and
  `user_id` from the JWT claims. All 19+ hardcoded usages of `DEFAULT_TENANT` and
  `DEFAULT_USER` in this file must be replaced.

- **`orchestrator/app/pipeline/executor.py`** — `_build_tool_context_for_task()`
  (lines 1262-1303): replace the two local `DEFAULT_TENANT` / `DEFAULT_USER`
  string constants with values resolved from the task's owning user. The task row
  has a `user_id` column (confirm with `\d tasks` in postgres). If the task has a
  `user_id`, query `users.tenant_id` from that. Fall back to
  `DEFAULT_TENANT`/`DEFAULT_USER` only if no user is associated.

- **`orchestrator/app/auth.py`** — export a `UserContext` dataclass (or
  `TypedDict`) with `tenant_id: UUID`, `user_id: UUID`, `is_admin: bool`. Update
  `UserDep` to return this. The existing `UserDep` returns the raw JWT payload
  dict — this is a narrow interface change. Check all callers of `UserDep` in the
  non-capabilities routers (`auth_router.py`, `router.py`, `goals_router.py`,
  `pipeline_router.py`) and update them to use `.user_id` attribute access instead
  of `["sub"]` dict access. If `UserDep` is used widely, extract a minimal
  backwards-compatible change: add a helper `user_dep_to_context(user_dep_result)`
  to avoid touching every caller.

- **`orchestrator/app/migrations/07X_tasks_user_id.sql`** — if the `tasks` table
  does not have a `user_id` column, add one (`ADD COLUMN IF NOT EXISTS user_id UUID`).
  Confirm with `\d tasks` before writing this migration. Do NOT add it if it already
  exists.

- **`tests/test_fc002_capabilities_tenant_isolation.py`** — new file, 3 tests.

## Implementation outline

1. Inspect the `tasks` table schema: `docker compose exec postgres psql -U nova
   nova -c "\d tasks"`. Determine if `user_id` exists.

2. Define `CapabilityContext` dataclass in a new file
   `orchestrator/app/capabilities/context.py`:
   ```python
   @dataclass
   class CapabilityContext:
       tenant_id: UUID
       user_id: UUID
       is_admin: bool
   ```

3. Write a FastAPI dependency `get_capability_context(request, admin=...,
   user=...)` that:
   - If `X-Admin-Secret` header is valid → returns `CapabilityContext(DEFAULT_TENANT,
     DEFAULT_USER, is_admin=True)`.
   - If `Authorization: Bearer <jwt>` is valid → extracts `tenant_id` from the JWT
     `tenant_id` claim and `user_id` from the `sub` claim.
   - If neither → raises 401.

4. Replace every `_admin: AdminDep = None` / `DEFAULT_TENANT` usage in
   `capabilities/router.py` with `ctx: CapabilityContext = Depends(get_capability_context)`,
   then use `ctx.tenant_id` and `ctx.user_id`.

5. Update `_build_tool_context_for_task` to look up `tasks.user_id` → `users.tenant_id`
   when available.

6. Write 3 integration tests. Create two real users via
   `POST /api/v1/auth/register` (requires `REGISTRATION_MODE=open` or an invite code
   — check `settings.registration_mode`. If registration is `invite` or `admin`, use
   the admin endpoint to create both users).

7. Run `make test` and fix any regressions in existing auth/capabilities tests.

## Behaviors the implementation must NOT change

- Admin-secret callers continue to work with `DEFAULT_TENANT` — they are the primary
  callers in v1 single-user mode. No change to their effective behavior.
- `tests/test_capability_consent.py` (11 tests) use `TENANT=DEFAULT_TENANT` and call
  the DB layer directly (not via HTTP); these must still pass.
- `tests/test_fc001_tenant_isolation.py` — these test the general orchestrator tenant
  isolation. They must still pass; do not alter their fixture setup.
- `tests/test_runner_capability_wiring.py` (3 tests) must still pass.
- The JWT claims format must remain compatible with the existing `auth_router.py`
  token issuance. Do not change what fields `create_access_token()` puts in the JWT.

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. New isolation tests
pytest tests/test_fc002_capabilities_tenant_isolation.py -v

# 2. Existing tenant isolation tests still pass
pytest tests/test_fc001_tenant_isolation.py -v

# 3. Existing consent tests still pass (they use direct DB layer, not HTTP)
pytest tests/test_capability_consent.py -v

# 4. Auth tests still pass
pytest tests/test_admin_auth_hardening.py tests/test_auth_isolation.py tests/test_user_identity.py -v

# 5. Runner capability wiring still passes
pytest tests/test_runner_capability_wiring.py -v

# 6. Verify admin-secret callers still work end-to-end
curl -s http://localhost:8000/api/v1/capabilities/credentials \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" \
  | python3 -c "import sys,json; r=json.load(sys.stdin); assert isinstance(r, list), f'Expected list, got: {r}'; print('PASS')"

# 7. Full test suite
make test
```

## Out of scope

- `_DEFAULT_USER` in `consent.py:18` (used only for the approve-and-remember
  `user_id` in consent_rules). This is addressed by T2-02 which adds `provider_kind`
  to `approval_requests` and can pass `user_id` through at the same time.
- Removing `DEFAULT_TENANT` from `webhooks_router.py:52` (webhook receiver and
  management endpoints). Those remain admin-only in v1.
- Changing how the dashboard stores or sends the admin secret. The dashboard uses
  `X-Admin-Secret` throughout; this task does not change the dashboard auth flow.

## Risks / unknowns

- The JWT payload: `auth_router.py` issues tokens via `jwt_auth.create_access_token()`
  which places `tenant_id` in the JWT (line 57 of `jwt_auth.py`). Confirm the exact
  JWT claim name for `tenant_id` — it is `"tenant_id"` per `create_access_token`
  signature. If it is absent from some token types (e.g. the bridge service token),
  the dependency must fall back gracefully.
- `UserDep` in `auth.py` — check its exact return type before changing it. If it
  currently returns `dict`, changing to `UserContext` dataclass is a breaking change
  for all callers. Prefer adding the `UserContext` adapter alongside the existing
  `UserDep` rather than replacing it.
- If `registration_mode` is not `open`, creating test users requires a different
  API path. Check `POST /api/v1/auth/admin/create-user` or the invite flow before
  writing the test fixtures.
