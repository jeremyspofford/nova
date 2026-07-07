# Generalized HTTP Ingestion Endpoint — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-source bridge pattern (deleted with `screenpipe-bridge`, 2026-07-06) with a single source-agnostic authenticated HTTP ingestion endpoint. Any external application — a capture tool, a CLI, a webhook, a script — can `POST /api/v1/ingest` with a payload and have it land in Nova's memory ingestion queue, fronted by the existing memory-service consumer. No bespoke bridge service per source.

**Architecture:** The endpoint is a thin producer-side adapter on the orchestrator. It validates + auths + rate-limits, then `LPUSH`es to the existing `memory:ingestion:queue` (Redis db0) — the exact same queue chat, intel, knowledge, and cortex already use. The memory-service consumer is unchanged; it already routes by `source_type`. This is **not** an MCP surface (MCP is request/response tool invocation, wrong shape for push ingestion) — it is plain HTTP, the correct abstraction for moving data into Nova.

**Tech Stack:** Python 3.11 + FastAPI + asyncpg + async Redis (orchestrator); pytest + httpx (tests). No new service, no new container.

**Spec / context:**
- Supersedes the deleted `screenpipe-bridge` (see `architecture/06-refactor-plan.md` C4).
- Related: `docs/superpowers/specs/2026-07-06-nova-mcp-server-capabilities-design.md` (the *capabilities-outward* complement — ingestion is *inward*).

---

## Why this design (not MCP, not per-source bridges)

1. **MCP is the wrong abstraction for ingestion.** MCP is a tool-call protocol (client invokes a named tool, server returns a result) designed for agent-initiated request/response. Push ingestion is continuous, high-volume, and streaming-shaped. Forcing it through MCP means per-chunk JSON-RPC framing, schema validation, and tool-discovery overhead for no benefit. A plain `POST /api/v1/ingest` does the same job with less ceremony and real backpressure.
2. **One surface beats N bridges.** The deleted `screenpipe-bridge` was a dedicated service babysitting one external app. That pattern doesn't scale — every new source (a different capture tool, an OBS plugin, a meeting transcript exporter) would mean a new service. A single authenticated HTTP endpoint with a stable payload contract means adding a source is "implement `POST` from your app," not "build a Nova service."
3. **The ingestion contract already exists.** Memory-service's queue (`memory:ingestion:queue`, db0) + the `MemoryBackend.write` contract is the proven ingestion primitive. This endpoint is just a new producer for that queue, joining chat/intel/knowledge/cortex. No new memory-side work.

---

## File Structure Overview

**New files:**
- `orchestrator/app/ingestion_router.py` — FastAPI router: `POST /api/v1/ingest`, `GET /api/v1/ingest/sources`, `POST /api/v1/ingest/sources` (register), `DELETE /api/v1/ingest/sources/{id}` (revoke)
- `orchestrator/app/migrations/099_ingestion_sources.sql` — `ingestion_sources` table (registered external sources: name, source_type, trust, rate limit, api_key hash, denylist, active)
- `tests/test_ingestion_endpoints.py` — endpoint contract, auth, rate limit, queue push, source registration

**Files to modify:**
- `orchestrator/app/main.py` — mount the router, `close_ingestion_redis()` in lifespan shutdown
- `CLAUDE.md` — document `/api/v1/ingest` + runtime config keys
- `docs/roadmap.md` — reference under the ingestion track
- `architecture/02-components.md` — add the ingestion router row to the routers table

---

## Task 1: `ingestion_sources` table + migration

**Files:**
- Create: `orchestrator/app/migrations/099_ingestion_sources.sql`
- Test: `tests/test_ingestion_endpoints.py` (source registration round-trip)

- [ ] **Step 1: Write the migration**

Create `orchestrator/app/migrations/099_ingestion_sources.sql`:

```sql
-- External ingestion sources (registered apps that push via POST /api/v1/ingest).
-- Replaces the per-source bridge pattern (screenpipe-bridge removed 2026-07-06).
CREATE TABLE IF NOT EXISTS ingestion_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,              -- human label, e.g. "desktop-capture", "meeting-exporter"
    source_type TEXT NOT NULL,              -- maps to memory source_type / nova_source_kind
    trust DOUBLE PRECISION NOT NULL DEFAULT 0.70,
    api_key_hash TEXT,                      -- SHA-256 of a per-source token (NULL = uses caller's API key auth)
    rate_limit_per_minute INT NOT NULL DEFAULT 120,
    denylist_apps JSONB NOT NULL DEFAULT '[]'::jsonb,
    denylist_url_patterns JSONB NOT NULL DEFAULT '[]'::jsonb,
    denylist_window_titles JSONB NOT NULL DEFAULT '[]'::jsonb,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_ingested_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ingestion_sources_active ON ingestion_sources (active) WHERE active;
CREATE INDEX IF NOT EXISTS idx_ingestion_sources_key ON ingestion_sources (api_key_hash) WHERE api_key_hash IS NOT NULL;
```

- [ ] **Step 2: Verify the migration runs idempotently**

```bash
docker compose restart orchestrator
docker compose exec postgres psql -U nova -d nova -c "\d ingestion_sources"
```

Expected: table exists with the columns above.

- [ ] **Step 3: Commit**

```bash
git add orchestrator/app/migrations/099_ingestion_sources.sql
git commit -m "feat(ingestion): add ingestion_sources table (migration 099)"
```

---

## Task 2: The ingestion router — `POST /api/v1/ingest`

**Files:**
- Create: `orchestrator/app/ingestion_router.py`
- Modify: `orchestrator/app/main.py`
- Test: `tests/test_ingestion_endpoints.py`

- [ ] **Step 1: Write failing endpoint tests**

Create `tests/test_ingestion_endpoints.py`:

```python
import httpx
import pytest

ADMIN = {"X-Admin-Secret": "nova-admin-secret-change-me"}


@pytest.mark.asyncio
async def test_ingest_pushes_to_memory_queue():
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.post(
            "http://localhost:8000/api/v1/ingest",
            headers=ADMIN,
            json={
                "source_type": "external",
                "source_name": "test-app",
                "raw_text": "the quick brown fox",
                "source_title": "test ingest",
            },
        )
        r.raise_for_status()
        assert r.json()["queued"] is True


@pytest.mark.asyncio
async def test_ingest_rejects_empty_text():
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.post(
            "http://localhost:8000/api/v1/ingest",
            headers=ADMIN,
            json={"source_type": "external", "source_name": "test-app", "raw_text": "   "},
        )
        assert r.status_code == 400


@pytest.mark.asyncio
async def test_ingest_requires_auth():
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.post(
            "http://localhost:8000/api/v1/ingest",
            json={"source_type": "external", "source_name": "test-app", "raw_text": "x"},
        )
        assert r.status_code in (401, 403)
```

- [ ] **Step 2: Run, confirm failure**

Run: `pytest tests/test_ingestion_endpoints.py -v`
Expected: FAIL (no router).

- [ ] **Step 3: Implement the router**

Create `orchestrator/app/ingestion_router.py`. Core shape:

```python
"""Generalized HTTP ingestion endpoint.

Any external app POSTs a payload; the endpoint validates, auths, rate-limits,
and LPUSHes to memory:ingestion:queue (db0) — the same queue chat/intel/
knowledge/cortex use. The memory-service consumer routes by source_type.

This is NOT an MCP surface (MCP is request/response tool invocation).
"""
import json, logging, time
import redis.asyncio as aioredis
from app.db import get_pool
from fastapi import APIRouter, HTTPException, Header

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/ingest", tags=["ingestion"])

_QUEUE_KEY = "memory:ingestion:queue"
_ingestion_redis: aioredis.Redis | None = None

def _get_redis() -> aioredis.Redis:
    global _ingestion_redis
    if _ingestion_redis is None:
        base = settings.redis_url.rsplit("/", 1)[0]
        _ingestion_redis = aioredis.from_url(f"{base}/0", decode_responses=True)
    return _ingestion_redis

async def close_ingestion_redis() -> None:
    global _ingestion_redis
    if _ingestion_redis is not None:
        await _ingestion_redis.aclose()
        _ingestion_redis = None

@router.post("")
async def ingest(payload: dict):
    raw_text = (payload.get("raw_text") or "").strip()
    if not raw_text:
        raise HTTPException(status_code=400, detail="raw_text is required")
    source_type = payload.get("source_type") or "external"
    source_name = payload.get("source_name") or "external"
    # Look up registered source for trust + denylist (fall back to defaults)
    trust, denylist = await _resolve_source(source_name)
    if denylist and _matches_denylist(payload.get("metadata", {}), denylist):
        return {"queued": False, "reason": "denylist"}
    msg = {
        "raw_text": raw_text,
        "source_type": source_type,
        "source_name": source_name,
        "source_title": payload.get("source_title") or source_name,
        "source_uri": payload.get("source_uri"),
        "source_trust": trust,
        "metadata": payload.get("metadata", {}),
        "occurred_at": payload.get("occurred_at") or _now_iso(),
        "tenant_id": payload.get("tenant_id"),
    }
    await _get_redis().lpush(_QUEUE_KEY, json.dumps(msg))
    return {"queued": True}
```

Auth: mount under the existing `RoleDep` / admin-secret middleware (reuse the app's auth, do not invent a new model). Per-source token auth (via `ingestion_sources.api_key_hash`) is Task 4.

- [ ] **Step 4: Mount the router + close_redis in lifespan**

Edit `orchestrator/app/main.py`: import + `app.include_router(ingestion_router)`; add `close_ingestion_redis()` to the shutdown block alongside the other `close_*_redis()` calls.

- [ ] **Step 5: Run tests, PASS**

Run: `pytest tests/test_ingestion_endpoints.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/app/ingestion_router.py orchestrator/app/main.py tests/test_ingestion_endpoints.py
git commit -m "feat(ingestion): generalized POST /api/v1/ingest endpoint"
```

---

## Task 3: Rate limiting + backpressure

**Files:**
- Modify: `orchestrator/app/ingestion_router.py`
- Test: `tests/test_ingestion_endpoints.py`

- [ ] **Step 1: Write failing rate-limit test**

Append a test that fires >N requests in one minute from one source and asserts a `429` past the limit.

- [ ] **Step 2: Implement per-source sliding-window rate limit**

Reuse the existing Redis sliding-window pattern (see `app/auth.py` API-key rate limit). Key: `nova:ingest:ratelimit:{source_name}`. Limit from `ingestion_sources.rate_limit_per_minute` (default 120).

- [ ] **Step 3: Backpressure — 503 when queue is saturated**

Before LPUSH, check `LLEN memory:ingestion:queue`; if above a threshold (e.g. 10_000, configurable via `ingestion.max_queue_depth`), return `503` with `Retry-After` rather than growing the queue unbounded.

- [ ] **Step 4: Tests PASS; commit**

```bash
git add orchestrator/app/ingestion_router.py tests/test_ingestion_endpoints.py
git commit -m "feat(ingestion): per-source rate limit + queue backpressure"
```

---

## Task 4: Source registration + per-source token auth

**Files:**
- Modify: `orchestrator/app/ingestion_router.py`
- Test: `tests/test_ingestion_endpoints.py`

- [ ] **Step 1: Source CRUD endpoints**

- `POST /api/v1/ingest/sources` (admin-only) — register a source: name, source_type, trust, rate_limit, denylists. Returns a generated `sk-nova-ingest-<hash>` token (store SHA-256).
- `GET /api/v1/ingest/sources` (admin-only) — list sources (no tokens).
- `DELETE /api/v1/ingest/sources/{id}` (admin-only) — revoke (set `active=false`, clear `api_key_hash`).

- [ ] **Step 2: Per-source token auth**

When the caller presents `Authorization: Bearer sk-nova-ingest-*`, look up by `api_key_hash` (not the user API-key table). Active source → accept; else 401. Admin-secret header still works for operator pushes.

- [ ] **Step 3: Tests for register/auth/revoke; commit**

```bash
git add orchestrator/app/ingestion_router.py tests/test_ingestion_endpoints.py
git commit -m "feat(ingestion): source registration + per-source token auth"
```

---

## Task 5: Salvage reusable logic from the deleted bridge (optional, if a source needs aggregation)

**Why:** The deleted `screenpipe-bridge` had genuinely source-agnostic logic worth keeping for sources that emit a stream of raw events needing focus-session aggregation: the `SessionAggregator` (30-min cap, dedup, <30s drop) and the `Denylist` (apps / url_patterns / window_titles). Not all ingestion sources need this (a meeting exporter pushes one transcript per call), but capture-style sources do.

- [ ] **Step 1: Decide the seam.** Either (a) the endpoint accepts only finalized payloads and aggregation is the source's problem, or (b) expose an optional `POST /api/v1/ingest/events` streaming-aggregation mode backed by a salvaged `CaptureSource` adapter interface. Recommend (a) for v1 — keep the endpoint dumb; revisit (b) when a real capture source exists and proves (a) insufficient.
- [ ] **Step 2 (if b):** Reintroduce `session_aggregator.py` + `denylist.py` as a `capture/` module under the orchestrator (not a separate service), with a `CaptureSource` Protocol so each source adapts its event shape to a normalized internal type. This is the "homegrown screenpipe replacement" path the roadmap anticipated — but generalized and source-agnostic.

---

## Task 6: Docs + config keys

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/roadmap.md`
- Modify: `architecture/02-components.md`

- [ ] **Step 1: CLAUDE.md** — add `/api/v1/ingest` to the orchestrator endpoints list; add runtime config keys (`ingestion.max_queue_depth`, per-source rate limits) to the runtime-config table; note the API surface in "Inter-service communication."
- [ ] **Step 2: roadmap.md** — reference under a new "External Ingestion" bullet in the Priority Backlog, linking this plan.
- [ ] **Step 3: architecture/02-components.md** — add `| ingestion | ingestion_router.py | 4 | generalized external-source HTTP ingestion → memory queue |` to the routers table.
- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/roadmap.md architecture/02-components.md
git commit -m "docs(ingestion): document generalized ingestion endpoint"
```

---

## Verification (end-to-end)

```bash
# Register a source + token
curl -s -X POST localhost:8000/api/v1/ingest/sources \
  -H "X-Admin-Secret: $NOVA_ADMIN_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"name":"test-exporter","source_type":"external","trust":0.75}'

# Push a payload with the returned token
curl -s -X POST localhost:8000/api/v1/ingest \
  -H "Authorization: Bearer sk-nova-ingest-..." \
  -H "Content-Type: application/json" \
  -d '{"raw_text":"a meeting transcript...","source_title":"standup 2026-07-06"}'

# Confirm it landed in the queue
docker compose exec redis redis-cli -n 0 LLEN memory:ingestion:queue
```

## Non-goals

- **Not** an MCP server (that's the capabilities-surface spec).
- **Not** a capture-source aggregator in v1 (Task 5 is opt-in, only if a real source needs it).
- **Not** per-source bridge services — the whole point is one endpoint for all sources.
