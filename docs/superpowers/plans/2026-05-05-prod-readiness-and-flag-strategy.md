# Production-Readiness & Flag-Strategy — Follow-On Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. This plan **augments** the existing `2026-05-05-feature-flags-v1.md` plan in the `flags-001-foundation` worktree — it is not a replacement.

**Spec source:** `docs/superpowers/specs/2026-05-05-prod-readiness-and-flag-strategy.md` (sibling memo).
**Existing v1 plan:** `docs/superpowers/plans/2026-05-05-feature-flags-v1.md` (in `flags-001-foundation` worktree).
**Status:** Awaiting user approval of the memo before any task in this plan executes.

---

## Plan structure

| Phase | What | Worktree | Blocks on |
|---|---|---|---|
| **A** | Role-blocker fixes (design corrections + quality gates) — must land *before* any v1 flag wiring is finalized | `flags-001-foundation` | Memo approval |
| **B** | Complete v1 per existing `2026-05-05-feature-flags-v1.md` plan, with the role-blocker overrides woven in | `flags-001-foundation` | Phase A |
| **C** | Parallel audit-cleanup tasks (independent of the flag system) | New worktree per task or batched | Memo approval |

Each task uses TDD-shaped checkboxes (`- [ ]`) so progress is mechanically trackable. Phase B references the existing v1 plan rather than duplicating its tasks; the role-blocker overrides are listed once at the top of Phase B and applied per-task by the implementer.

---

## Phase A — Role-Blocker Fixes (1.5 days net new work)

These tasks correct design errors and close quality-gate gaps the role advisors surfaced. They land **before** the cache implementation in Phase B because Phase B's TDD tests depend on the corrected APIs (e.g. `flag_override`).

### A1. Implement `flag_override` context manager (CICD blocker CI1)

**Files:**
- Modify: `nova-worker-common/nova_worker_common/feature_flags.py` (or `nova-contracts/feature_flags.py` after A6)
- Test: `tests/test_feature_flags_resolver.py` (existing file — uncomment/add tests)

**Why first:** the existing test file imports `flag_override` from a module that doesn't export it. Test collection fails today. Until this lands, no other test can run cleanly.

- [ ] **Step 1: Write failing tests**

```python
# tests/test_feature_flags_resolver.py — add these
import asyncio
from nova_worker_common.feature_flags import (
    FlagDef, register_flag, flag_override, _registry_clear,
)

def test_flag_override_returns_overridden_value():
    flag = register_flag(key="t.basic", type="bool", default=False, description="")
    with flag_override("t.basic", True):
        assert flag.value() is True
    assert flag.value() is False  # cleared on exit

def test_flag_override_is_contextvar_safe_across_async_tasks():
    async def in_override():
        with flag_override("t.basic", True):
            await asyncio.sleep(0)  # let other tasks run
            return register_flag(
                key="t.basic", type="bool", default=False, description=""
            ).value()
    async def outside_override():
        return register_flag(
            key="t.basic", type="bool", default=False, description=""
        ).value()
    async def main():
        async with asyncio.TaskGroup() as tg:
            inside = tg.create_task(in_override())
            outside = tg.create_task(outside_override())
        assert inside.result() is True
        assert outside.result() is False
    asyncio.run(main())
```

- [ ] **Step 2: Verify FAIL** — `pytest tests/test_feature_flags_resolver.py -v` should error on `ImportError: cannot import name 'flag_override'`.

- [ ] **Step 3: Implement using `contextvars.ContextVar`**

```python
# in feature_flags.py
import contextlib
import contextvars

_overrides: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "feature_flag_overrides", default=None
)

@contextlib.contextmanager
def flag_override(key: str, value: Any):
    current = _overrides.get() or {}
    new_overrides = {**current, key: value}
    token = _overrides.set(new_overrides)
    try:
        yield
    finally:
        _overrides.reset(token)
```

Then update `FlagDef.value()` to consult overrides first:

```python
def value(self, *, tenant_id: str | None = None, user_id: str | None = None) -> Any:
    overrides = _overrides.get()
    if overrides is not None and self.key in overrides:
        return overrides[self.key]
    return self.default  # cache + DB lookup added in Phase B
```

- [ ] **Step 4: Verify PASS** — both new tests should pass; existing tests should still pass.

- [ ] **Step 5: Commit**: `feat(flags): implement flag_override context manager (contextvars-based)`

---

### A2. Move `_registry_clear` to a testing submodule (CICD blocker CI4)

**Files:**
- Create: `nova-worker-common/nova_worker_common/feature_flags_testing.py`
- Modify: `nova-worker-common/nova_worker_common/feature_flags.py` (remove module-level `_registry_clear`)
- Modify: `tests/test_feature_flags_resolver.py` (update import in autouse fixture)

- [ ] **Step 1: Add a test asserting `_registry_clear` is NOT importable from production module**

```python
def test_registry_clear_not_in_production_module():
    import nova_worker_common.feature_flags as ff
    assert not hasattr(ff, "_registry_clear"), (
        "_registry_clear must live in feature_flags_testing, not the prod module"
    )
```

- [ ] **Step 2: Verify FAIL** (it's currently exported).

- [ ] **Step 3: Move it.** Create `feature_flags_testing.py`:

```python
"""Test-only helpers for feature flags. Production code MUST NOT import this."""
from nova_worker_common.feature_flags import _registry  # type: ignore[reportPrivateUsage]

def registry_clear() -> None:
    _registry.clear()
```

Delete `_registry_clear` from `feature_flags.py`. Update `test_feature_flags_resolver.py`:

```python
from nova_worker_common.feature_flags_testing import registry_clear

@pytest.fixture(autouse=True)
def _clean_registry():
    registry_clear()
    yield
    registry_clear()
```

- [ ] **Step 4: Verify PASS** + grep for any other import of `_registry_clear` anywhere in the tree.

- [ ] **Step 5: Commit**: `refactor(flags): move registry_clear to feature_flags_testing submodule`

---

### A3. Add `flags_clean` autouse fixture to `tests/conftest.py` (CICD blocker CI2)

**Files:**
- Modify: `tests/conftest.py`

- [ ] **Step 1: Write a failing integration test that depends on a clean state.**

```python
# tests/test_feature_flags.py — add
@pytest.mark.asyncio
async def test_isolated_test_does_not_see_other_test_overrides():
    conn = await asyncpg.connect(DB_DSN)
    try:
        rows = await conn.fetch("SELECT key FROM feature_flags")
        assert rows == [], (
            f"feature_flags must be empty at test start; saw {[r['key'] for r in rows]}"
        )
    finally:
        await conn.close()
```

- [ ] **Step 2: Verify FAIL** — runs cleanly only the *first* time; subsequent runs may fail if any test wrote a row without cleanup.

- [ ] **Step 3: Add the fixture** to `tests/conftest.py`:

```python
@pytest.fixture(autouse=True)
async def flags_clean(db_pool):
    """Truncate flag tables AFTER each test (so failure state is inspectable)."""
    yield
    async with db_pool.acquire() as conn:
        await conn.execute(
            "TRUNCATE feature_flags, feature_flag_audit RESTART IDENTITY CASCADE"
        )
```

- [ ] **Step 4: Verify PASS** — re-run integration suite; the new isolation test passes regardless of run order.

- [ ] **Step 5: Commit**: `test(flags): add flags_clean autouse fixture for state isolation`

---

### A4. Add `actor_ip`, `actor_user_agent`, `request_id` to audit table (Security blocker S1)

**Files:**
- Create: `orchestrator/app/migrations/085_flag_audit_metadata.sql` (085 reserved here; coordinate with sec-006a/006b)
- Modify: existing `083_feature_flags.sql` is **NOT** edited (migrations are append-only; we ALTER in 085)
- Test: `tests/test_feature_flags.py`

> **Migration number coordination (CICD blocker CI5):** before merging this task, run the gap-check `ls migrations/*.sql | awk -F'[/_]' '{print $1+0}' | sort -n | awk 'prev && $1!=prev+1{print "GAP after "prev; exit 1} {prev=$1}'`. If `082_platform_secrets.sql` (sec-006a) has merged, this task uses 085. If not, hold until it does. Sec-006b owns 084.

- [ ] **Step 1: Add a column-presence test** for the three new columns.

```python
@pytest.mark.asyncio
async def test_flag_audit_has_request_metadata_columns():
    conn = await asyncpg.connect(DB_DSN)
    try:
        cols = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'feature_flag_audit'"
        )
        names = {r["column_name"] for r in cols}
        assert {"actor_ip", "actor_user_agent", "request_id"}.issubset(names)
    finally:
        await conn.close()
```

- [ ] **Step 2: Verify FAIL.**

- [ ] **Step 3: Migration**:

```sql
-- migrations/085_flag_audit_metadata.sql
ALTER TABLE feature_flag_audit
    ADD COLUMN IF NOT EXISTS actor_ip      INET,
    ADD COLUMN IF NOT EXISTS actor_user_agent TEXT,
    ADD COLUMN IF NOT EXISTS request_id    UUID;
```

- [ ] **Step 4: Restart orchestrator + verify migration ran**: `docker compose restart orchestrator && docker compose logs orchestrator | grep 085`.

- [ ] **Step 5: Verify PASS.**

- [ ] **Step 6: Commit**: `feat(flags): capture request metadata in audit log (S1)`

> **Note:** writing the columns is wired in Phase B (B-extra: PATCH/DELETE handler must populate them from the FastAPI Request object).

---

### A5. Spec-language correction — env-var as boot-time only, not hot kill-switch (SRE blocker SR2)

**Files:**
- Modify: `docs/superpowers/specs/2026-05-05-feature-flags-design.md` (in `flags-001-foundation`)

This is a documentation-only task. No tests; correctness is reviewed by the spec-document-reviewer.

- [ ] Replace the language under "Resolution Order" §2 — change "env-var override (operator break-glass)" to "env-var override (boot-time default override only — flips applied at process start; changing this value at runtime requires a container restart and is NOT a hot kill-switch)".
- [ ] In §"First Flags to Ship," add a bold note: "Hot kill-switching of `kill.*` flags is via the admin API, not env vars."
- [ ] In a new subsection §"Failure Modes" under "Hot-Reload": add SR3 — "When orchestrator/Redis is unreachable, services fall back to the **last-seen cached value persisted to disk under `data/flag-cache/`**, NOT the in-code default. Rationale: in-code default for `kill.*` flags is `false` (feature-enabled), and falling to default during a partition would silently disarm the kill switch."

- [ ] Commit: `docs(flags): clarify env-var override is boot-time-only; document partition fallback (SR2/SR3)`

---

### A6. Decide and act on SDK location (Backend concern + spec divergence)

**Decision required from user before this task starts.** Options:

- **(i)** Move code to `nova-contracts/feature_flags.py` to match spec rationale ("Pydantic-only contract package keeps services as drop-in replacements").
- **(ii)** Update spec to ratify `nova-worker-common/` as the SDK home (with rationale: shared async-aware utilities live there already).

Memo recommendation: **(i)** — match spec.

If (i):

- [ ] Create `nova-contracts/feature_flags.py` with the current `nova-worker-common/nova_worker_common/feature_flags.py` content.
- [ ] Create `nova-contracts/feature_flags_testing.py` (move from A2).
- [ ] Update all imports in `tests/`.
- [ ] Delete the old files.
- [ ] Commit: `refactor(flags): move SDK to nova-contracts (matches spec)`.

If (ii):

- [ ] Update the spec §"SDK — Service-Side Eval" to say `nova-worker-common/nova_worker_common/feature_flags.py` and add rationale.
- [ ] Commit: `docs(flags): ratify nova-worker-common as SDK home (spec correction)`.

---

### A7. Add `CRITICAL_FLAGS` denylist + spec text (Security blocker S3)

**Files:**
- Modify: spec — add §"Critical-Flag Confirmation"
- Defer code wiring to Phase B (admin router task)

- [ ] In spec, after §"Authorization," add a new section:

```markdown
### Critical-Flag Confirmation (v1)

A hardcoded set of catastrophic flag keys MUST require a `confirm: <flag-key>` field in the PATCH body. Initial set:

- `kill.engram.ingestion`
- `kill.consolidation.cycle`
- `kill.cortex.thinking_loop`
- `pipeline.guardrail_strict_mode`
- `pipeline.web_fetch_strict_sanitize`

The admin API rejects PATCH with HTTP 400 if `confirm` is missing or doesn't match the URL key. The dashboard surfaces a second-modal confirm dialog. This is a hardcoded constant, not a per-flag DB field — Phase 2 RBAC criticality replaces this when role-gated writes land.
```

- [ ] Commit: `docs(flags): add CRITICAL_FLAGS confirmation requirement (S3)`

---

### A8. Add §"Phase 3+ multi-tenant isolation invariants" + multi-env note (Security S6 + CICD CI6)

**Files:**
- Modify: spec — extend §"Phase 3+: Tenant Targeting"

- [ ] Extend the existing §"Phase 3+: Tenant Targeting" with:

```markdown
### Multi-tenant isolation invariants

When tenant scoping lands, these are hard guarantees:

1. Cross-tenant reads return HTTP 404, not 403 (don't leak existence).
2. `GET /registry` is global (just declared flags + types) — no tenant data.
3. Flag values that may contain PII or tenant-config get a new `is_sensitive BOOLEAN DEFAULT false` column. Reads of sensitive values are masked (`***`) unless the actor has the owning tenant's id.
4. Audit log `actor_id` resolves to a tenant-scoped user; cross-tenant audit reads return only the requesting tenant's slice.

### Phase 3+ schema migration shape

Adding `environment` (and/or `tenant_id`) columns is **not a column add** — it's a primary-key restructure. The `feature_flags` PK changes from `(key)` to `(key, environment, tenant_id)`. Plan for a coordinated migration window: write to both old and new schemas during a transition release, swap reads, then drop the old PK. Estimated effort: 1-2 days for the migration alone, separate from the SaaS work that drives it.
```

- [ ] Commit: `docs(flags): document Phase 3+ isolation invariants and schema-restructure shape (S6/CI6)`

---

## Phase B — v1 Completion (~6-7 days)

This phase **delegates** to the existing `2026-05-05-feature-flags-v1.md` plan in the `flags-001-foundation` worktree, with the following overrides applied to **every** task:

### Phase-B-wide overrides (applied per-task by the implementer)

When implementing the existing v1 plan tasks, observe these acceptance criteria from the memo. They are not new tasks; they shape *how* the existing tasks are implemented.

| Override | Applies to which existing tasks | Source |
|---|---|---|
| `.value()` is sync; cache is **bulk pre-warmed at startup** via one async HTTP call per service lifespan; never inline-fetch on miss | "SDK cache" + per-service "main.py" wiring tasks | B1 |
| Startup cache-warm failure is non-fatal; log WARN, leave cache empty, fall through to in-code default | per-service main.py tasks | B2 |
| Pubsub subscriber is a named `asyncio.Task` registered in lifespan; cancelled+awaited on shutdown; `close_redis()` called | per-service main.py tasks | B4 |
| Registry-announce uses retry-with-backoff (≥3 attempts, 2s initial); failures log WARN, not ERROR | per-service main.py tasks | B5 |
| Admin PATCH executes UPSERT + audit INSERT in a single asyncpg transaction from the **shared orchestrator pool**; PUBLISH after commit only | orchestrator router task | B6 |
| Audit row populates `actor_ip`, `actor_user_agent`, `request_id` from the FastAPI `Request` object | orchestrator router task | S1 |
| PATCH/DELETE handler enforces `CRITICAL_FLAGS` confirmation; rejects with 400 if missing | orchestrator router task | S3 |
| PATCH/DELETE rate-limited to 5/min/IP; failed-auth attempts emit an audit row with `action='auth_fail'` | orchestrator router task | S5 |
| `.value()` resolution from env-var emits `WARN` log: `flag_envvar_override_used` with key, value, service, PID | SDK eval task | S2 |
| Last-seen cached value persisted to per-service file under `data/flag-cache/<service>.json`; cache-warm failure falls back to file before in-code default | SDK eval + per-service wiring tasks | SR3 |
| Every flag application emits a structured INFO log: key, old, new, source (pubsub/TTL/file-cache) | SDK eval task | SR1 |
| `GET /health/ready` on each flag-consuming service includes `flag_pubsub_connected: bool` | per-service main.py tasks | SR4 |
| OpenFeature-shaped Protocol: `class FlagResolver(Protocol): def resolve_bool(...) -> bool; def resolve_string(...) -> str` — the in-process cache + DB fetcher implements it | SDK design | C5 |
| CI integration test: pubsub propagation polled with `PUBSUB_PROPAGATION_TIMEOUT_S = 5` constant, retried 10 × 0.5s | integration test task | CI3 |
| Pre-merge gap check runs in CI (snippet in §A4) | top-level CI workflow | CI5 |

### Phase B's task list (referencing existing plan)

These are the existing v1 plan's task numbers, run in order, with the overrides above:

- [ ] **B-Task 1**: Migration for `feature_flags` + `feature_flag_audit` — **already done** in `flags-001-foundation` (commit `28288e47`). Skip.
- [ ] **B-Task 2**: `FlagDef` class with default-only evaluation — **already done** (commits `1b31ce38`, `ace12bba`). Skip; A1 + A2 + A6 finish the SDK foundation.
- [ ] **B-Task 3** (existing plan): Cache + env-var override + HTTP fetch fallback in `.value()`. Apply overrides B1, B2, S2, SR1, SR3, C5.
- [ ] **B-Task 4** (existing plan): Pubsub subscriber + invalidation handler. Apply B4, SR4.
- [ ] **B-Task 5** (existing plan): Orchestrator's `feature_flags_store.py` (DB CRUD + pubsub publish helper). Apply B6.
- [ ] **B-Task 6** (existing plan): Orchestrator's `feature_flags_router.py` (the 7 admin endpoints + registry aggregation). Apply S1, S3, S5, B6.
- [ ] **B-Task 7** (existing plan): Per-service wiring of `register_flag` + lifespan startup + pubsub subscribe — for orchestrator, llm-gateway, memory-service, cortex, intel-worker, knowledge-worker (6 services). Apply B1, B2, B4, B5, SR4.
- [ ] **B-Task 8** (existing plan): Settings UI section (`FeatureFlagsSection.tsx`). Add: confirm-modal for `CRITICAL_FLAGS` per S3.
- [ ] **B-Task 9** (existing plan): Wire 8 first-shipping flags into call sites.
- [ ] **B-Task 10** (existing plan): Integration test (PATCH → pubsub → eval). Apply CI3.
- [ ] **B-Task 11** (existing plan): Documentation (CLAUDE.md update, website doc page).
- [ ] **B-Task 12 (NEW from this memo):** Kill-switch runbook (one Markdown doc per `kill.*` flag) under `docs/runbooks/kill-switches/`. Apply SR5.
- [ ] **B-Task 13 (NEW from this memo):** Pre-merge migration-gap CI check. Apply CI5.

---

## Phase C — Audit-Cleanup Tasks (parallel; independent of flag system)

These tasks are flagged in the audit but don't depend on the flag system landing. They can be done in parallel by separate worktrees.

### C1. Add compose profile for `screenpipe-bridge` (audit row #4 — most acute issue)

**Files:**
- Modify: `docker-compose.yml`
- Modify: `.env.example` (document the new profile)
- Modify: `CLAUDE.md` (note the profile)

- [ ] Add `profiles: ["screenpipe"]` to the `screenpipe-bridge` service block.
- [ ] Add a deny test that confirms `docker compose config` doesn't show `screenpipe-bridge` for default invocation.
- [ ] Verify with `docker compose --profile screenpipe up -d screenpipe-bridge`.
- [ ] Commit: `chore(compose): gate screenpipe-bridge behind screenpipe profile`.

### C2. Document `selfmod.*` and `sandbox.*` exclusion from v1 flags

**Files:**
- Modify: `CLAUDE.md` — add a "Security-sensitive toggles" subsection
- Modify: `.env.example` — annotate `SELFMOD_ENABLED` with rationale

- [ ] Add CLAUDE.md text: "Two toggles are intentionally NOT in the feature-flag system: `SELFMOD_ENABLED` and the home/root sandbox tiers. Both grant agents host-write capability. The flag system's admin-secret-only auth model in v1 is too weak for these — they remain `.env`-gated until Phase 2 RBAC + per-write confirmation tokens land."
- [ ] Commit: `docs: explain selfmod/sandbox exclusion from v1 feature flags`.

### C3. Add `data/flag-cache/` to `.gitignore` and recovery backup-exclusion list

**Files:**
- Modify: `.gitignore`
- Modify: `recovery/app/backup.py` (or wherever the backup-exclusion list lives)

- [ ] Add `data/flag-cache/` to `.gitignore`.
- [ ] Add a unit test in `recovery/tests/` confirming that `data/flag-cache/` is excluded from backups (last-seen values are durable per-service, not part of the canonical flag state).
- [ ] Commit: `chore(recovery): exclude flag-cache from backups (per-service derived state)`.

### C4. Watch-list close-outs (do these to remove items from the audit)

These are the §1 watch-list items. Each is small and independent.

- [ ] **Self-modification UI confirmation gate** (~2h) — add a per-user `selfmod_user_confirmed_at` column to user_settings (or `platform_config` row); UI prompt; agent path checks it.
- [ ] **Voice chat integration test** (~3h) — STT → response → TTS round trip in `tests/test_voice_chat.py`.
- [ ] **Settings-UI surface for `llm.intelligent_routing`** (~1h) — Settings tab "AI & Models" already has a Provider Status section; add a toggle bound to the Redis key.
- [ ] **Neural-router-trainer entrypoint gate** (~1h) — guard the trainer container start with `NEURAL_ROUTER_TRAINER_ENABLED=true` env var, default off; auto-flip-on once min-observations threshold is hit.

---

## Approval Checkpoints

Before each phase begins, confirm with the user:

- **Before Phase A:** Memo §"Decision required from user" answered — DIY confirmed; SDK location chosen; migration coordination plan agreed.
- **Before Phase B:** Phase A complete; spec text re-reviewed by `spec-document-reviewer`.
- **Before Phase C:** No prerequisite — Phase C can run in parallel with Phase A or B.
- **Before merge of any phase:** Migration-gap CI check passes; all role-blocker acceptance criteria green; integration test PATCH→pubsub→eval cycle passes within 5s.

---

## Out of scope for this plan

These are deliberately deferred to subsequent plans:

- **Phase 2 migration of existing `.env` and `nova:config:*` toggles into flags** — separate plan, written after v1 is stable.
- **Phase 2 RBAC + per-flag criticality + per-write confirmation tokens** — unblocks `selfmod.*` / `sandbox.*` migration.
- **Phase 3+ multi-tenant + multi-environment columns** — tied to SaaS launch.
- **Flagsmith migration** — revisit when first SOC2-driven gap appears.
- **Audit-log retention/rotation** — generic cleanup cron after `usage_events` cleanup pattern is in place.

---

## Effort summary

| Phase | Effort | Net new vs existing v1 plan |
|---|---|---|
| A | ~1.5 days | All net new (corrections + quality gates) |
| B | ~6-7 days | Same as existing plan; overrides shape *how* not *what* |
| C | ~1 day total (parallelizable) | All net new |
| **Total** | **~8-9.5 days** | **~2-2.5 days net new vs existing plan's 8-day estimate** |

The "buy" alternative (Flagsmith) is ~2 weeks of integration + ongoing ops surface area + the migration-runner coordination hazard. DIY remains the lower-cost path for current scope.
