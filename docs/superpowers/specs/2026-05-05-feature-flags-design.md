# Feature Flags v1 — Design Spec

**Date:** 2026-05-05
**Status:** Draft
**Branch:** TBD (suggested: `flags-001-foundation`)

## Problem

Nova ships behavior toggles through four orthogonal mechanisms today — Compose `profiles:` (boot-time service gating), `.env` enum/bool flags (`memory_retrieval_mode`, `REQUIRE_AUTH`), runtime `nova:config:*` Redis keys (`inference.backend`, `llm.routing_strategy`, `capture.paused`), and RBAC roles. None of these solve three concrete daily-driver needs:

1. **Code-path experiments / staged rollouts** — when a risky change ships (e.g. AQ-001's fail-closed guardrail, AQ-002's symmetric outcome feedback), there's no per-install on/off switch that can be flipped without a redeploy. Rollback today means revert + rebuild + restart.
2. **Operational kill switches** — when a worker misbehaves (intel-worker hammering an upstream, consolidation cycle starving chat, engram ingestion looping on a poison message), there's no fast lever short of `docker compose stop`. Restarting drops in-flight state and pages other dependent services as "degraded" until they reconnect.
3. **A single catalog of declared toggles** — "what behavior knobs does this Nova install have?" has no single answer today; the four mechanisms above don't cross-reference, and several are undocumented in `.env.example` (per OPS-006).

This spec adds a fifth, purpose-built mechanism — **feature flags** — that owns these three jobs in v1, and is designed to absorb the existing toggles in a follow-up phase (priority C) and grow into per-tenant gating later (priority B).

## Solution

A code-first feature flag system: services declare their flags at startup via `register_flag(...)`, the orchestrator owns a `feature_flags` Postgres table that stores **only overrides** (no row = code default in effect), and a Redis pubsub channel propagates changes to every service's in-process cache within ~1 second. A new Settings UI section lists every declared flag (read from a registry-introspection endpoint, not from the DB) with toggle/edit/reset and an audit-history view.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary motivation | A (code-path experiments) + D (kill switches) | Maps directly to daily-driver pain. C (unify) and B (tenant) are explicitly Phase 2/3+. |
| Value shape | Boolean + enum variants, single global value | Covers every v1 use case. Eval API takes optional `tenant_id`/`user_id` for forward compatibility but ignores them. |
| Source of truth for "what flags exist" | Code (registry), via `register_flag(...)` at module-import time | Eliminates code/DB drift. A flag removed from code disappears from UI even if a stale row lingers. The registry is grep-able. |
| Source of truth for current values | Postgres `feature_flags` (orchestrator) — overrides only; absence = default | "Row exists ⇔ override active." Useful debug signal. Audit log records real changes only. |
| Hot-reload | Redis pubsub `nova:flags:invalidate` | Mirrors the channel FU-009 wants for `platform_secrets`; same mechanism, two consumers. |
| Per-service eval | Shared SDK, in-process cache, lazy-populated | A-priority requires fast in-process eval. No network call per check. |
| Resolution order | test override → env-var override → in-process cache → DB → code default | Env-var override gives operators a "break glass" path even when DB is unreachable. |
| Admin UI | New Settings section grouped by namespace prefix | Matches existing Settings refactor pattern (e.g. `LLMRoutingSection.tsx`). |
| Authorization (v1) | `X-Admin-Secret` for all writes | Mirrors `platform_secrets`. Per-flag criticality + RBAC role gating deferred to Phase 2. |
| Migration of `.env` / `nova:config:*` | Out of v1 scope | C is third-priority. v1 system is designed to absorb them later (Phase 2) without redesign. |

---

## Architecture

```
                    ┌──────────────────┐
   register_flag()  │   Code registry  │   in-process, per service
   at module import │  (FlagDef dict)  │
                    └────────┬─────────┘
                             │ .value()
                             ▼
                    ┌──────────────────┐
                    │ in-process cache │   refilled on miss + on pubsub
                    └────────┬─────────┘
                             │ on miss
                             ▼
              ┌──────────────────────────────┐
              │  GET /api/v1/feature-flags/  │   fetched from orchestrator
              │   {key} (DB read)            │
              └──────────────┬───────────────┘
                             │
                             ▼
              ┌─────────────────────────────────┐
              │ Postgres: feature_flags         │
              │   (overrides only)              │
              │ Postgres: feature_flag_audit    │
              │   (every write)                 │
              └─────────────────────────────────┘

   Admin write flow:
   PATCH /api/v1/feature-flags/{key} ──▶ UPSERT feature_flags + INSERT audit
                                            └─▶ PUBLISH nova:flags:invalidate
                                                        │
                              ┌─────────────────────────┴───────┐
                              ▼               ▼                 ▼
                       orchestrator      llm-gateway       memory-service
                       (drops cache)    (drops cache)      (drops cache)
```

### Components

- **Code registry (per service)**: in-process `dict[str, FlagDef]` populated at import time by `register_flag(...)` calls. Exposes `.value()` getters for runtime eval. Read-only after process start.
- **Postgres `feature_flags` table** (orchestrator-owned): one row per active override, indexed by `key`.
- **Postgres `feature_flag_audit` table** (orchestrator-owned): one row per write — set or reset.
- **In-process cache (per service)**: lazy-populated `dict[str, JsonValue]` keyed by flag key; populated on first eval miss, refilled on pubsub invalidate.
- **Redis pubsub channel `nova:flags:invalidate`**: payload is the flag key as a UTF-8 string. Subscribed by every flag-consuming service.
- **Admin API on orchestrator** (`/api/v1/feature-flags/...`): CRUD over overrides + a `/registry` endpoint that introspects the running orchestrator's FlagDef registry.
- **Settings UI section**: new `FeatureFlagsSection.tsx` in `dashboard/src/pages/settings/`.

### Service Scope (v1)

These services consume flags in v1:

- **orchestrator** (port 8000) — pipeline behavior toggles, cortex/maintain drive kill switches, ingestion kill switches
- **llm-gateway** (port 8001) — provider routing toggles, rate-limit kill switches
- **memory-service** (port 8002) — consolidation cycle kill switch, ingestion kill switch, neural router opt-in
- **cortex** (port 8100) — thinking-loop kill switch, drive-execution toggles

Other services adopt the SDK in Phase 2 as needed.

---

## Data Model

```sql
-- migrations/06X_feature_flags.sql

CREATE TABLE IF NOT EXISTS feature_flags (
    key TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    set_by TEXT NOT NULL,           -- "admin" or future user id
    set_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT
);

CREATE TABLE IF NOT EXISTS feature_flag_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('set', 'reset')),
    old_value JSONB,                -- null if previously default
    new_value JSONB,                -- null if reset to default
    actor TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_audit_key_time
    ON feature_flag_audit (key, occurred_at DESC);
```

**Notes:**

- `feature_flags.value` is JSONB so booleans, strings, and (future) numeric/object variants share storage.
- The audit table is append-only and never deleted by application code. Retention is a Phase-2 concern (out of v1 scope; tracked separately as a follow-up).
- No `tenant_id` columns in v1. Phase 3+ will add either columns on `feature_flags` or a sibling `feature_flag_overrides` table; the choice depends on how SaaS multi-tenancy lands more broadly.

---

## SDK — Service-Side Eval

A new shared module at `nova-contracts/feature_flags.py`. (Pydantic-only contract package keeps services as drop-in replacements.)

```python
# nova-contracts/feature_flags.py

from typing import Any, Literal, Sequence

FlagType = Literal["bool", "enum"]

class FlagDef:
    """A registered flag. Created via register_flag()."""

    key: str
    type: FlagType
    variants: Sequence[Any] | None     # None for bool; non-empty list for enum
    default: Any
    description: str

    def value(self, *, tenant_id: str | None = None,
                       user_id: str | None = None) -> Any:
        """Evaluate the flag.

        Resolution order:
          1. test override (set via flag_override context manager)
          2. env-var override: NOVA_FLAG_<UPPERCASE_KEY_WITH_UNDERSCORES>
          3. in-process cache (populated lazily from DB)
          4. in-code default

        tenant_id / user_id are accepted for forward compatibility (B);
        ignored in v1.
        """
        ...


def register_flag(
    *,
    key: str,
    type: FlagType,
    variants: Sequence[Any] | None = None,
    default: Any,
    description: str,
) -> FlagDef:
    """Register a flag. Idempotent on re-import (returns existing FlagDef).

    Raises ValueError if:
      - key collides with a registered flag with a different schema
      - type='enum' and default not in variants
      - type='bool' and default is not bool
    """
    ...


def flag_override(key: str, value: Any):
    """Context manager that overrides a flag for the current process.
       Used by tests. Cleared on context exit. Highest priority in
       resolution order."""
    ...
```

### Usage

```python
# memory-service/app/engram/retrieval.py
from nova_contracts.feature_flags import register_flag

MEMORY_MODE = register_flag(
    key="memory.retrieval_mode",
    type="enum",
    variants=["inject", "tools"],
    default="inject",
    description="Where memory retrieval injects context. "
                "'inject' = pre-pended to system prompt. "
                "'tools' = exposed as agent-callable tools.",
)

def get_context(...):
    if MEMORY_MODE.value() == "tools":
        return _tools_path(...)
    return _inject_path(...)
```

### Resolution Order

`.value()` checks sources in priority order:

1. **Test override** (process-local dict set by `flag_override(...)`) — pytest fixtures.
2. **Env-var override** (`NOVA_FLAG_KILL_INTEL_WORKER_POLL=true`) — operator break-glass.
3. **In-process cache** — hot path; populated lazily from DB on first miss.
4. **In-code default** — fallback if DB has no row and cache is empty.

Cache miss triggers an HTTP call to orchestrator's `GET /api/v1/feature-flags/{key}`. To avoid repeated misses on a missing row, the cache stores a sentinel `_DEFAULT` marker so subsequent calls return the in-code default without re-fetching.

### Variant Validation

`register_flag()` validates `default` against `variants` at registration time (raises `ValueError`).

`.value()` validates the cached value against the declared variants on the *first* read after a cache fill; if the DB returned a non-conforming value (e.g. an admin set `value="vllm-old"` but code only declares `["ollama", "vllm", "sglang", "none"]`), the SDK logs a `WARNING`, drops the cache entry, and returns the in-code default. Operators see the warning via structured logs and the admin UI surfaces an "invalid override" badge.

The admin API also rejects `PATCH` calls whose value isn't in the declared variants (looked up via the registry endpoint).

---

## Hot-Reload

**Write path (admin → all services):**

1. Admin issues `PATCH /api/v1/feature-flags/{key}` with `{"value": ..., "notes": "..."}`.
2. Orchestrator validates value against the registered FlagDef schema (rejects unknown variants).
3. In one transaction: UPSERT `feature_flags`, INSERT `feature_flag_audit`.
4. After commit, PUBLISH the flag key to `nova:flags:invalidate`.

**Read path (per service):**

- Each flag-consuming service subscribes to `nova:flags:invalidate` during its FastAPI lifespan startup.
- On message receipt: pop the named key from the in-process cache.
- Next `.value()` call refetches from orchestrator HTTP, repopulating the cache.

**Failure modes:**

- **Redis disconnect**: services miss invalidations until reconnect. The cache TTL (default 60 seconds) bounds staleness even when pubsub is silent. Acceptable for v1; documented.
- **Orchestrator unreachable on cache miss**: cache fill fails; SDK returns the in-code default and logs a `WARNING`. The next eval retries.
- **Race between write commit and pubsub publish**: pubsub is the *invalidate* signal, not the *value carrier* — services always read the value from DB after invalidation. So a missed pubsub means stale cache for ≤60s, never a torn read.

The same pattern is the proposal for FU-009 (secrets hot-reload). If FU-009 lands first, it can use the existing channel naming convention (`nova:secrets:invalidate`); the implementation patterns are siblings.

---

## Admin API

All endpoints under `/api/v1/feature-flags/`. All require `X-Admin-Secret` in v1.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/registry` | List declared flags from orchestrator's in-process registry. Returns `[{key, type, variants, default, description}]`. |
| `GET` | `/` | List all overrides (joined: registry ⨝ DB rows). Returns `[{key, default, current_value, is_override, set_by, set_at, notes}]`. |
| `GET` | `/{key}` | Single-flag detail (registry entry + DB override if any). |
| `PATCH` | `/{key}` | Set or update an override. Body: `{value, notes}`. Validates against registry; publishes invalidate. |
| `DELETE` | `/{key}` | Reset to default (delete row, audit as `reset`, publish invalidate). |
| `GET` | `/{key}/audit` | Audit history for a key. Returns `[{action, old_value, new_value, actor, occurred_at, notes}]`. |
| `GET` | `/audit?limit=N` | Recent audit entries across all flags. |

**Cross-service registry note (v1 limitation):** `GET /registry` reflects only the orchestrator's registry. Services running in their own processes (llm-gateway, memory-service, cortex) declare their own flags. v1 ships a static aggregation pattern: each service POSTs its declared flags to orchestrator at startup via `POST /api/v1/feature-flags/registry/announce` (admin-secret authed). Orchestrator merges these and serves the union from `GET /registry`. If a service restarts, it overwrites its own slice. This is simple and avoids a service-discovery layer in v1.

---

## Admin UI

A new Settings section component at `dashboard/src/pages/settings/FeatureFlagsSection.tsx`, rendered in the **System** tab (alongside Developer Resources, Notifications, Recovery & Services).

### Layout

- **Header**: "Feature Flags" + 1-line description + "Show audit log" link (opens side panel).
- **Body**: collapsible groups by namespace prefix (split key on first `.`):
  - `kill.*` — operational kill switches
  - `pipeline.*` — pipeline-stage toggles
  - `memory.*` — memory subsystem
  - `cortex.*` — autonomous brain
  - (other groups as flags accumulate)
- **Per-flag row**: key (mono font) + description + type badge + current-value control:
  - Boolean → toggle switch (default-off shown grey, default-on shown filled)
  - Enum → `<select>` with variants
  - Override badge ("Default" vs "Overridden") and reset button when overridden
- **Audit side panel**: ordered list of recent changes with key, actor, old → new, timestamp, notes.

### State

- Uses TanStack Query (matches dashboard convention; staleTime 5s, retry 1).
- `GET /api/v1/feature-flags/` for the list view.
- Optimistic update on `PATCH` / `DELETE`; rolls back on error.
- WebSocket-based live invalidation is **out of v1 scope** — the UI uses query refetch on focus/interval.

### Component reuse

Follows the established pattern in `dashboard/src/pages/settings/`:
- `Section`, `ConfigField`, `useConfigValue` from `settings/shared.tsx`
- Tailwind stone/teal/amber/emerald palette
- Lucide icons (`ToggleRight`, `History`, `RotateCcw` for reset)

---

## Authorization

**v1**: every write endpoint requires `X-Admin-Secret`. Read endpoints (`/registry`, list, detail, audit) also require admin secret — there's no "public" tier in v1.

**Phase 2** (deferred): introduce a per-flag `criticality` field (`info | warn | critical`) and gate writes via `RoleDep(min_role=Admin)` for `info`, `RoleDep(min_role=Owner)` for `critical`. This lands when RBAC matures (the existing 5-role system is partly built; some areas still use admin-secret only).

---

## Testing Strategy

### Unit tests

```python
# tests/unit/test_memory_retrieval_mode.py
from nova_contracts.feature_flags import flag_override

def test_tools_mode_routes_through_tools_path():
    with flag_override("memory.retrieval_mode", "tools"):
        result = get_context(query="...")
        assert result.path_taken == "tools"

def test_default_uses_inject_path():
    # no override; default 'inject' applies
    result = get_context(query="...")
    assert result.path_taken == "inject"
```

`flag_override` is a context manager that mutates a process-local override dict. Cleared on context exit. No DB writes.

### Integration tests

For tests that span service boundaries, the env-var override path is used instead. Example: setting `NOVA_FLAG_KILL_INTEL_WORKER_POLL=true` in `docker-compose.test.yml` makes that flag's value visible to every service in the stack without writing to DB.

A new fixture `flags_clean()` in `tests/conftest.py` truncates `feature_flags` and `feature_flag_audit` between tests.

### CI gate

A new test in `tests/integration/test_feature_flags.py`:

1. PATCH a flag via the admin API.
2. Wait ≤2s for pubsub propagation.
3. Verify a downstream service's eval reflects the new value.
4. DELETE the override.
5. Verify the downstream service's eval reverts to default.

Tests follow the existing pattern: hit real running services, no mocks.

---

## First Flags to Ship

v1 ships with these declared flags. Each maps to an open Phase-1 audit item or a near-term reliability deliverable.

| Key | Type | Default | Owner Service | Purpose |
|---|---|---|---|---|
| `pipeline.guardrail_strict_mode` | bool | false | orchestrator | Enable AQ-003 fail-closed guardrail behavior (medium-severity findings → loopback) |
| `pipeline.outcome_feedback_symmetric` | bool | false | memory-service | Enable AQ-002 symmetric reinforcement (negative outcomes lower activation) |
| `pipeline.web_fetch_strict_sanitize` | bool | false | orchestrator | Enable AQ-008 strict sanitizer for tool-result web content |
| `kill.intel_worker.poll` | bool | false | intel-worker | Pause intel feed polling without container restart |
| `kill.knowledge_worker.crawl` | bool | false | knowledge-worker | Pause knowledge crawler runs |
| `kill.consolidation.cycle` | bool | false | memory-service | Pause sleep-cycle consolidation |
| `kill.engram.ingestion` | bool | false | memory-service | Pause new engram decomposition |
| `kill.cortex.thinking_loop` | bool | false | cortex | Pause autonomous thinking |

All v1 flags are boolean; the first variants flag (`memory.retrieval_mode` with variants `["inject", "tools"]`) lands with the Phase 2 migration of the existing `.env` toggle.

The intel-worker and knowledge-worker rows use the SDK from their own processes; this means they become flag consumers in v1 (expanding the original 4-service v1 scope). Acceptable scope creep — kill switches for those workers are a top D-priority use case, and the SDK is small.

---

## Phase 2: Migrate Existing Toggles (C)

Each migration is a single PR following this pattern:

1. Register the flag in code with the same default as the legacy source.
2. Add a one-cycle compatibility shim that prefers the flag value if set, otherwise reads the legacy source.
3. Update Settings UI to read from the flag system.
4. After one release, delete the legacy code path.

Migration roadmap (Phase 2 candidates, prioritized by how often they cause stale-config bugs):

| From | To | Type |
|---|---|---|
| `nova:config:inference.backend` | `inference.backend` flag | enum: `ollama`, `vllm`, `sglang`, `none` |
| `nova:config:llm.routing_strategy` | `llm.routing_strategy` flag | enum: `local-first`, `local-only`, `cloud-first`, `cloud-only` |
| `.env: memory_retrieval_mode` | `memory.retrieval_mode` flag | enum: `inject`, `tools` |
| `nova:config:capture.paused` | `kill.screenpipe.capture` flag | bool |
| `nova:config:screenpipe.enabled` | `screenpipe.enabled` flag | bool |
| `.env: REQUIRE_AUTH` | (NOT migrated — security bootstrap, must remain in `.env`) | — |

`REQUIRE_AUTH` deliberately stays in `.env` because the flag system itself is admin-secret-gated, which depends on auth being bootstrapped. Migrating it would create a circular dependency.

This phase also closes REL-010 ("stale `nova:config:*` Redis keys survive container recreation; no reconcile UI") for the migrated keys — the flag system has a clear reconcile path (`DELETE` resets to default).

---

## Phase 3+: Tenant Targeting (B)

When SaaS multi-tenancy ships:

- Add `tenant_id` and `user_id` columns to override storage (decision: extend `feature_flags` with nullable cols, or add sibling `feature_flag_overrides` table keyed by `(flag_key, tenant_id, user_id)` with NULLs for "global"). Choice depends on how multi-tenancy lands across other tables.
- Resolution order extends to: test → env → user-override → tenant-override → global-override → default.
- Optional: percentage rollouts via stable hash bucketing on `(flag_key, tenant_id)`.
- The `.value(tenant_id=..., user_id=...)` API already accepts these args; v1 ignores them. No call-site changes needed when targeting lands.

This is also the natural point to add a predicate-rule layer (à la LaunchDarkly) if needed — but that's a substantial Phase 3+ design in its own right.

---

## Risks & Open Questions

1. **Pubsub failure tolerance.** Services miss invalidations during Redis disconnects. Mitigated by 60s cache TTL. Documented; acceptable for v1. **Open**: should we surface "pubsub disconnected" as a visible UI state? (Probably yes — small follow-up, not a blocker.)

2. **Cross-service registry aggregation.** v1 uses startup-time POST from each service to orchestrator; this means a flag from a service that hasn't registered yet (e.g. cortex still booting) won't appear in the registry list. Eventual consistency is fine; the UI shows "loading" until all services have announced.

3. **Variant typos at write time.** Mitigated by registry validation in `PATCH` and runtime validation in `.value()`. Defense in depth.

4. **Audit log retention.** Audit table grows unboundedly. Out of v1 scope. Tracked as a follow-up: a generic `audit_*_cleanup` cron similar to REL-014's expression-index work for `usage_events`.

5. **Test override hygiene.** Misuse of `flag_override` outside a context manager (e.g. fixture leakage) could leak overrides between tests. Mitigation: the context manager API is the only public interface; setting overrides any other way is a private import.

6. **Overlap with `platform_secrets`.** Both stores use admin-secret auth, both want pubsub invalidation. Should they share infrastructure (single `nova-config-store` package)? **Decision for v1**: keep them separate. They have different audit/security properties (secrets are write-only after entry; flags are read-back-able from UI). Sharing infra is a Phase 2+ refactor if the duplication actually hurts.

7. **Naming conventions.** Proposed: lowercase dotted `<area>.<thing>` (e.g., `pipeline.guardrail_strict_mode`). Kill switches prefixed `kill.*`. This matches the existing `nova:config:*` Redis key style (so Phase 2 migrations don't rename). Open: should `kill.*` prefix be enforced (i.e., reject `register_flag(...)` for boolean flags whose name doesn't start with `kill.` or `pipeline.` or other approved prefix)? **v1 decision**: not enforced — convention only. Tighten later if drift becomes an issue.

---

## Out of Scope (v1)

- Migrating any existing `.env` / `nova:config:*` toggles (Phase 2)
- Per-tenant or per-user targeting (Phase 3+)
- Percentage rollouts / multi-arm experiments / predicate rules
- Cross-service registry via service discovery (using POST-on-startup pattern instead)
- Audit log retention/rotation
- Per-flag criticality + RBAC role-gated writes (Phase 2)
- WebSocket-based live admin UI updates (refetch on interval/focus is enough for v1)
- A separate "experiments" subsystem (A/B testing infrastructure) — that's a different shape

---

## Effort Estimate

- Postgres migration + audit table: 0.5 day
- SDK in `nova-contracts`: 1 day
- Pubsub plumbing + per-service cache wiring: 1 day
- Orchestrator admin API + registry aggregation: 1 day
- Settings UI section: 1 day
- First-flag wiring (each ~0.5 day × 8 flags): 2 days
- Tests (unit + integration + CI gate): 1 day
- Documentation (CLAUDE.md update, website doc page): 0.5 day

**Total: ~8 working days** for a clean v1.

Phase 2 migrations are ~0.5 day per existing toggle (6 candidate migrations = ~3 days additional, spread over a release cycle).
