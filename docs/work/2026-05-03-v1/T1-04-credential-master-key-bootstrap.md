# T1-04: CREDENTIAL_MASTER_KEY Auto-Bootstrap

**Tier:** 1  **Size:** S  **Blocks:** none  **Blocked by:** none

## Why this task exists

Closes P1 from `docs/audits/2026-05-03-readiness-assessment.md`. In
`orchestrator/app/config.py:118`, `credential_master_key: str = ""`. The install
wizard at `scripts/install.sh:142-145` generates one — but a user who clones and
runs `make up` directly starts with an empty value. The first request to
`POST /api/v1/capabilities/credentials` calls `credentials._provider()` which
raises `HTTPException(500, "CREDENTIAL_MASTER_KEY not configured")`. The user sees
a generic 500 with no guidance.

Production-shape failure: day-1 user, no install wizard, runs `make up`. Opens
the dashboard, tries to add a GitHub credential. Gets a 500 error. No path forward
without reading source code.

## Definition of "done" (the seam test)

**File:** `tests/test_capability_master_key_bootstrap.py`

**Test name:** `test_orchestrator_starts_and_encrypts_without_env_master_key`

**Assertions in plain English:**
1. The orchestrator service is running (health/ready returns 200). It started
   without `CREDENTIAL_MASTER_KEY` set in its environment.
2. `GET /api/v1/capabilities/credentials` returns 200 (not 500) — the credential
   endpoint is reachable.
3. `POST /api/v1/capabilities/credentials` with a valid github PAT payload returns
   201 — the key was auto-generated and encryption succeeded.
4. `docker compose exec postgres psql -U nova nova -c "SELECT value FROM
   platform_config WHERE key='capability.credential_master_key'"` returns a
   non-empty row — the key was persisted to the DB.
5. After a container restart (`docker compose restart orchestrator`), the same
   credential is still retrievable — the key survived the restart by loading from
   `platform_config`.

**Second test:** `test_env_master_key_takes_precedence` — if `CREDENTIAL_MASTER_KEY`
is set in `.env`, the orchestrator uses it (does not overwrite with a new generated
key), and credentials encrypted with the env key still decrypt after restart.

Both tests run against the live stack; no mocks.

## Files this task will touch

- **`orchestrator/app/capabilities/credentials.py`** — `_provider()` function
  (lines 37-47): instead of raising HTTPException immediately when
  `settings.credential_master_key` is empty, call
  `await _ensure_credential_master_key()`. Remove the synchronous singleton
  pattern: `_provider()` becomes `async def get_provider()` and `_encrypt()` /
  `_decrypt()` become async. All callers (`create_credential`, `get_secret`,
  `validate_credential`) are already async — this is a non-breaking change within
  the module.

- **`orchestrator/app/capabilities/credentials.py`** — add
  `async def _ensure_credential_master_key()`: mirrors `jwt_auth.ensure_jwt_secret()`
  (see `orchestrator/app/jwt_auth.py:28-54`). If `settings.credential_master_key`
  is non-empty, return immediately. Otherwise: query `platform_config` for
  `capability.credential_master_key`; if found and non-empty, set
  `settings.credential_master_key` and return. If not found, generate
  `os.urandom(32).hex()`, insert into `platform_config`, set
  `settings.credential_master_key`, log one INFO line: "Generated and stored
  CREDENTIAL_MASTER_KEY in platform_config".

- **`orchestrator/app/main.py`** — in the lifespan startup block (around line 114,
  after `ensure_jwt_secret()`), add:
  `from app.capabilities.credentials import ensure_credential_master_key`
  `await ensure_credential_master_key()`.
  This ensures the key is ready before any request hits the credentials endpoint.
  Fail fast at startup with a clear RuntimeError if the platform_config table is
  unreachable (DB not yet up) — this should not happen given the existing retry
  loop, but be explicit.

- **`orchestrator/app/migrations/074_credential_master_key_config.sql`** (or next
  available migration number after T1-01's migration) — insert a row into
  `platform_config` for `capability.credential_master_key` with an empty string
  default, `is_secret=TRUE`. This ensures the row exists for `_ensure_credential_master_key()`
  to UPDATE. Use `ON CONFLICT (key) DO NOTHING` so existing deployments that
  already have the key stored are not overwritten.

- **`tests/test_capability_master_key_bootstrap.py`** — new file, 2 tests.

## Implementation outline

1. Determine the next available migration number (the one after T1-01's migration).
   Write the migration file with the `platform_config` row insert.

2. In `credentials.py`, rename `_provider()` to `_get_provider()` and make it sync
   but only called from the new async `get_provider()`. Alternatively, keep `_provider()`
   sync (it does not need the pool since `settings.credential_master_key` is already
   loaded by the time `_provider()` is called) and move the async key bootstrap to
   `_ensure_credential_master_key(pool)` which is called at startup only.

3. Write `ensure_credential_master_key(pool)` as a module-level async function
   (exported, not private) so `main.py` can call it. Pattern is identical to
   `ensure_jwt_secret()` in `jwt_auth.py`.

4. Update `main.py` startup call.

5. Write 2 integration tests. Test 1 can only be verified manually if the running
   instance has a master key (since `make up` usually starts with one set). Use an
   override approach: the test directly calls
   `POST /api/v1/capabilities/credentials` and asserts 201 — that is sufficient to
   prove the key is loaded, since the endpoint would 500 without it.

## Behaviors the implementation must NOT change

- Credential encryption/decryption output must be byte-for-byte identical when the
  same key is provided — no new salt or padding added.
- If `CREDENTIAL_MASTER_KEY` IS set in `.env`, the auto-bootstrap path must be a
  no-op (the key is already loaded by pydantic-settings into `settings.credential_master_key`
  before `main.py` lifespan runs).
- The existing 4 tests in `tests/test_capability_credentials.py` must still pass.
- The singleton `_credential_provider` module variable behavior must be preserved:
  once the key is loaded, subsequent `_provider()` calls return the cached instance.

## Verification commands the sub-agent must run before claiming "done"

```bash
# 1. Apply migration
docker compose exec orchestrator python -c "from app.db import init_db; import asyncio; asyncio.run(init_db())"
docker compose exec postgres psql -U nova nova -c \
  "SELECT key, is_secret FROM platform_config WHERE key='capability.credential_master_key';"

# 2. Run new tests
pytest tests/test_capability_master_key_bootstrap.py -v

# 3. Run existing credential tests
pytest tests/test_capability_credentials.py -v

# 4. Simulate the day-1 scenario: POST a credential without pre-setting the key
# (if the key was already generated, this test just confirms the endpoint works)
curl -s -X POST http://localhost:8000/api/v1/capabilities/credentials \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"provider_kind":"github","auth_method":"pat","label":"test-bootstrap","secret":"ghp_fake"}' \
  | python3 -c "import sys,json; r=json.load(sys.stdin); assert r.get('id'), f'Expected id, got: {r}'; print('PASS')"

# 5. Confirm orchestrator logs a clean startup (no 500 on first credential op)
docker compose logs orchestrator --since 5m | grep -E "CREDENTIAL_MASTER_KEY|credential_master_key|500"
```

## Out of scope

- Encryption key rotation (roadmap item 9, Tier 3). This task only handles the
  missing-key-at-startup case, not key rotation.
- Surfacing the key in the dashboard Settings page.
- Any change to the `knowledge-worker`'s `CREDENTIAL_MASTER_KEY` usage — that
  service has its own startup handling.

## Risks / unknowns

- The migration that inserts into `platform_config` with `is_secret=TRUE` — confirm
  the `platform_config` table has an `is_secret` column. Check
  `orchestrator/app/migrations/` for the `platform_config` table creation migration
  (likely in the 060s range). If `is_secret` does not exist, use `is_secret=FALSE`
  or omit the column from the INSERT.
- Making `_provider()` / `_encrypt()` / `_decrypt()` async may require changes
  in `webhooks_router.py` which calls `cred_db._decrypt()` directly at line 140.
  Check all callers of `_decrypt` and `_encrypt` and update them. If the sync call
  site in `webhooks_router.py` is inside an async context, `await` is safe.
