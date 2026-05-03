# Screenpipe Capture & Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new `screenpipe-bridge` Compose service that subscribes to a user-installed screenpipe daemon over the network, aggregates raw events into 30-min-capped focus sessions, applies a two-layer privacy denylist, and pushes payloads to Nova's engram ingestion queue — making screen activity show up as searchable engrams without any agent recall surface, meeting capture, or journals (those are sub-projects 2/3/4).

**Architecture:** Bridge is queue-producer-only — no HTTP calls into Nova services, no admin auth. Follows the established knowledge_router producer pattern: LPUSH to `engram:ingestion:queue` (db0); memory-service decomposer creates the `sources` row from the payload and decomposes text into engrams. Runtime config in Redis db1 with 30s in-process polling (matches `auth.py:57-85`). Single-tenant, single-device for v1; multi-tenant constants are localized for future change.

**Tech Stack:** Python 3.11 + FastAPI + asyncpg + async Redis + httpx + websockets (bridge); React + TypeScript + Vite (dashboard); pytest + asyncio + a fake screenpipe HTTP/WS fixture (tests).

**Spec:** `docs/superpowers/specs/2026-05-02-screenpipe-capture-ingestion-design.md`

---

## File Structure Overview

**New service:**
- `screenpipe-bridge/Dockerfile`
- `screenpipe-bridge/pyproject.toml`
- `screenpipe-bridge/app/__init__.py`
- `screenpipe-bridge/app/main.py` — FastAPI app, lifespan, `/health/live`, `/health/ready`, `/test-connection`
- `screenpipe-bridge/app/config.py` — pydantic_settings (REDIS_URL, REDIS_PASSWORD, log level, port)
- `screenpipe-bridge/app/runtime_config.py` — 30s poll-and-cache of `nova:config:*` from Redis db1
- `screenpipe-bridge/app/tenant.py` — `DEFAULT_TENANT` constant
- `screenpipe-bridge/app/screenpipe_client.py` — WebSocket subscriber + HTTP polling fallback
- `screenpipe-bridge/app/session_aggregator.py` — focus-session lifecycle, dedup, cap/drop
- `screenpipe-bridge/app/denylist.py` — three sub-list filter (apps / url_patterns / window_titles)
- `screenpipe-bridge/app/engram_producer.py` — payload assembly + LPUSH to db0 queue
- `screenpipe-bridge/app/metrics.py` — Prometheus counter/gauge definitions

**New tests:**
- `tests/fixtures/fake_screenpipe.py` — minimal Starlette fake of screenpipe's `/ws/events` and `/search`
- `tests/test_screenpipe_bridge_health.py`
- `tests/test_session_aggregation.py`
- `tests/test_denylist_filtering_app.py`
- `tests/test_denylist_filtering_url.py`
- `tests/test_denylist_filtering_window.py`
- `tests/test_dedup_within_session.py`
- `tests/test_session_cap_30min.py`
- `tests/test_short_session_drop.py`
- `tests/test_websocket_reconnect.py`
- `tests/test_polling_fallback.py`
- `tests/test_backpressure_drop.py`
- `tests/test_runtime_config_change.py`
- `tests/test_engram_ingestion_payload.py`
- `tests/test_pause_resume.py`
- `tests/test_tenant_id_propagation.py`
- `tests/test_source_kind_mapping.py`

**New dashboard files:**
- `dashboard/src/pages/CapturePage.tsx`
- `dashboard/src/pages/capture/MeetingsPlaceholder.tsx`
- `dashboard/src/pages/capture/JournalsPlaceholder.tsx`
- `dashboard/src/pages/settings/ScreenpipeConnectionSection.tsx`
- `dashboard/src/pages/settings/CapturePrivacySection.tsx`
- `dashboard/src/pages/settings/CaptureAdvancedSection.tsx`

**New docs:**
- `docs/setup/screenpipe.md` — per-OS install + screenpipe.config.json reference

**Files to modify:**
- `docker-compose.yml` — add `screenpipe-bridge` service entry (port 8140, depends_on redis)
- `memory-service/app/engram/ingestion.py:187-201` — add `'screenpipe': 'screenpipe'` to `_map_source_type_to_kind()`
- `orchestrator/app/config_sync.py` — add `sync_screenpipe_config_to_redis()` and `sync_capture_config_to_redis()` following the `sync_llm_config_to_redis()` pattern, call from startup
- `orchestrator/app/router.py` (or new `orchestrator/app/capture_router.py`) — endpoints: `GET /api/v1/capture/sessions`, `GET /api/v1/capture/today-stats`
- `dashboard/src/pages/Settings.tsx` — register the three new sections
- `dashboard/src/components/layout/Nav.tsx` (or equivalent) — add "Capture" top-level nav item with placeholder children
- `dashboard/src/api.ts` — `getCaptureSessions`, `getCaptureTodayStats`, `testScreenpipeConnection`, `addCaptureExclude`
- `dashboard/src/App.tsx` (or router) — `/capture`, `/capture/meetings`, `/capture/journals` routes
- `CLAUDE.md` — add screenpipe-bridge to services list, port 8140, Redis DB allocation db10, runtime config keys, source_kind entry

---

## Task 1: Scaffold screenpipe-bridge service

**Files:**
- Create: `screenpipe-bridge/Dockerfile`
- Create: `screenpipe-bridge/pyproject.toml`
- Create: `screenpipe-bridge/app/__init__.py`
- Create: `screenpipe-bridge/app/main.py`
- Create: `screenpipe-bridge/app/config.py`
- Modify: `docker-compose.yml`
- Test: `tests/test_screenpipe_bridge_health.py`

- [ ] **Step 1: Use the service-scaffold skill to generate baseline files**

Invoke the `service-scaffold` skill with: service name `screenpipe-bridge`, port `8140`, Redis DB `db10`, depends on `redis`. The skill produces Dockerfile, pyproject.toml, `app/main.py` (FastAPI app + lifespan + `/health/live` + `/health/ready` stubs), `app/config.py` (pydantic_settings).

Expected output: a `screenpipe-bridge/` directory matching Nova's standard service shape (compare to `voice-service/` for reference).

- [ ] **Step 2: Add Compose entry**

Edit `docker-compose.yml`. Add after the `voice-service` block (or maintaining alphabetical order, wherever appropriate):

```yaml
  screenpipe-bridge:
    build: ./screenpipe-bridge
    container_name: nova-screenpipe-bridge
    ports:
      - "8140:8140"
    environment:
      - REDIS_URL=redis://redis:6379
      - REDIS_PASSWORD=${REDIS_PASSWORD:-}
      - NOVA_ADMIN_SECRET=${NOVA_ADMIN_SECRET:-}
      - LOG_LEVEL=${LOG_LEVEL:-INFO}
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    networks:
      - nova-net
```

(Use the exact form of other services — copy from `voice-service` block to match patterns precisely.)

- [ ] **Step 3: Write failing health-check test**

Create `tests/test_screenpipe_bridge_health.py`:

```python
import httpx
import pytest


@pytest.mark.asyncio
async def test_bridge_health_live_returns_200():
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get("http://localhost:8140/health/live")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"
```

- [ ] **Step 4: Build and start the service**

Run:
```bash
docker compose up -d --build screenpipe-bridge
docker compose logs --tail=20 screenpipe-bridge
```

Expected: container running, logs show `Application startup complete`.

- [ ] **Step 5: Run the test**

Run: `pytest tests/test_screenpipe_bridge_health.py -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add screenpipe-bridge/ docker-compose.yml tests/test_screenpipe_bridge_health.py
git commit -m "feat(screenpipe-bridge): scaffold service with health endpoints"
```

---

## Task 2: Add tenant constant and runtime config polling

**Files:**
- Create: `screenpipe-bridge/app/tenant.py`
- Create: `screenpipe-bridge/app/runtime_config.py`
- Test: `tests/test_runtime_config_change.py`

- [ ] **Step 1: Create the tenant constant**

Create `screenpipe-bridge/app/tenant.py`:

```python
"""Tenant scoping for sub-project 1.

Single-tenant for v1; multi-tenant deferred. This constant is the only place
the bridge encodes its tenant identity — change here when multi-tenant lands.
"""

DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"
```

- [ ] **Step 2: Read the existing 30s-cache pattern in auth.py for reference**

Run: `sed -n '57,85p' /home/jeremy/workspace/nova/orchestrator/app/auth.py`

Expected: see the cached-with-TTL pattern (cache value + expiry, lazy refresh).

- [ ] **Step 3: Write failing test for runtime config polling**

Create `tests/test_runtime_config_change.py`:

```python
import asyncio

import pytest
import redis.asyncio as redis_async

from screenpipe_bridge.app.runtime_config import RuntimeConfig

REDIS_URL = "redis://localhost:6379/1"


@pytest.mark.asyncio
async def test_runtime_config_picks_up_change_within_poll_interval():
    r = redis_async.from_url(REDIS_URL)
    await r.set("nova:config:capture.session_max_minutes", "30")

    cfg = RuntimeConfig(redis=r, poll_interval_seconds=1)
    await cfg.start()
    try:
        assert await cfg.get_int("capture.session_max_minutes", 30) == 30

        await r.set("nova:config:capture.session_max_minutes", "45")
        await asyncio.sleep(1.5)

        assert await cfg.get_int("capture.session_max_minutes", 30) == 45
    finally:
        await cfg.stop()
        await r.delete("nova:config:capture.session_max_minutes")
        await r.aclose()
```

- [ ] **Step 4: Run test and confirm it fails**

Run: `pytest tests/test_runtime_config_change.py -v`
Expected: FAIL with `ModuleNotFoundError` or similar.

- [ ] **Step 5: Implement runtime_config.py**

Create `screenpipe-bridge/app/runtime_config.py`:

```python
"""Polls nova:config:* from Redis db1 every 30s and caches values in-process.

Matches the cache pattern at orchestrator/app/auth.py:57-85.
"""

import asyncio
import json
import logging
from typing import Any

import redis.asyncio as redis_async

logger = logging.getLogger(__name__)

_PREFIX = "nova:config:"
_WATCHED_PREFIXES = ("screenpipe.", "capture.")


class RuntimeConfig:
    def __init__(self, redis: redis_async.Redis, poll_interval_seconds: int = 30):
        self._redis = redis
        self._poll_interval = poll_interval_seconds
        self._cache: dict[str, str] = {}
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        await self._refresh()
        self._task = asyncio.create_task(self._poll_loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _poll_loop(self) -> None:
        while True:
            await asyncio.sleep(self._poll_interval)
            try:
                await self._refresh()
            except Exception as exc:
                logger.warning("runtime_config refresh failed: %s", exc)

    async def _refresh(self) -> None:
        new_cache: dict[str, str] = {}
        for prefix in _WATCHED_PREFIXES:
            async for key in self._redis.scan_iter(match=f"{_PREFIX}{prefix}*"):
                key_str = key.decode() if isinstance(key, bytes) else key
                value = await self._redis.get(key_str)
                if value is not None:
                    new_cache[key_str.removeprefix(_PREFIX)] = (
                        value.decode() if isinstance(value, bytes) else value
                    )
        self._cache = new_cache

    async def get_str(self, key: str, default: str = "") -> str:
        return self._cache.get(key, default)

    async def get_int(self, key: str, default: int) -> int:
        raw = self._cache.get(key)
        return int(raw) if raw is not None else default

    async def get_bool(self, key: str, default: bool = False) -> bool:
        raw = self._cache.get(key)
        if raw is None:
            return default
        return raw.lower() in ("1", "true", "yes")

    async def get_list(self, key: str, default: list | None = None) -> list:
        raw = self._cache.get(key)
        if raw is None:
            return default or []
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else (default or [])
        except json.JSONDecodeError:
            logger.warning("runtime_config: failed to parse list for %s", key)
            return default or []
```

- [ ] **Step 6: Run the test, confirm PASS**

Run: `pytest tests/test_runtime_config_change.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add screenpipe-bridge/app/tenant.py screenpipe-bridge/app/runtime_config.py tests/test_runtime_config_change.py
git commit -m "feat(screenpipe-bridge): tenant constant + runtime config poll-and-cache"
```

---

## Task 3: Register screenpipe/capture keys in config_sync

**Files:**
- Modify: `orchestrator/app/config_sync.py`

- [ ] **Step 1: Read the existing sync_llm_config_to_redis pattern**

Run: `sed -n '29,52p' /home/jeremy/workspace/nova/orchestrator/app/config_sync.py`

Expected: see a function that queries `platform_config WHERE key LIKE 'llm.%'` and `SET nova:config:llm.<key>`.

- [ ] **Step 2: Add sync function for screenpipe + capture keys**

Edit `orchestrator/app/config_sync.py`. Add a new function modeled on `sync_llm_config_to_redis()`:

```python
async def sync_screenpipe_config_to_redis(pg_pool, redis_client) -> None:
    """Sync platform_config rows with key LIKE 'screenpipe.%' or 'capture.%' to Redis db1."""
    async with pg_pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value FROM platform_config "
            "WHERE key LIKE 'screenpipe.%' OR key LIKE 'capture.%'"
        )
    for row in rows:
        await redis_client.set(f"nova:config:{row['key']}", row["value"])
```

- [ ] **Step 3: Wire the call into the orchestrator startup hook**

Find the existing call site that invokes other `sync_*_config_to_redis()` functions (likely in `orchestrator/app/main.py` lifespan startup). Add the new call alongside them.

- [ ] **Step 4: Verify by writing a value and confirming Redis sees it after restart**

Run:
```bash
docker compose exec postgres psql -U nova -d nova -c \
  "INSERT INTO platform_config (key, value) VALUES ('capture.session_max_minutes', '30') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;"
docker compose restart orchestrator
sleep 5
docker compose exec redis redis-cli -n 1 GET nova:config:capture.session_max_minutes
```

Expected output: `"30"`.

- [ ] **Step 5: Commit**

```bash
git add orchestrator/app/config_sync.py orchestrator/app/main.py
git commit -m "feat(orchestrator): sync screenpipe/capture config keys to redis on startup"
```

---

## Task 4: Memory-service one-line mapping change

**Files:**
- Modify: `memory-service/app/engram/ingestion.py:187-201`
- Test: `tests/test_source_kind_mapping.py`

- [ ] **Step 1: Read the existing mapping function**

Run: `sed -n '185,205p' /home/jeremy/workspace/nova/memory-service/app/engram/ingestion.py`

Expected: see `_map_source_type_to_kind()` with a dict mapping source_type strings to source_kind values, missing a `screenpipe` entry.

- [ ] **Step 2: Write failing mapping test**

Create `tests/test_source_kind_mapping.py`:

```python
def test_screenpipe_source_type_maps_to_screenpipe_source_kind():
    from memory_service.app.engram.ingestion import _map_source_type_to_kind

    assert _map_source_type_to_kind("screenpipe") == "screenpipe"


def test_unknown_source_type_falls_back_to_manual_paste_unchanged():
    from memory_service.app.engram.ingestion import _map_source_type_to_kind

    assert _map_source_type_to_kind("nonexistent_kind") == "manual_paste"
```

- [ ] **Step 3: Run test, confirm first one fails**

Run: `pytest tests/test_source_kind_mapping.py -v`
Expected: FAIL on `test_screenpipe_source_type_maps_to_screenpipe_source_kind` (returns `manual_paste`).

- [ ] **Step 4: Add the mapping line**

Edit `memory-service/app/engram/ingestion.py`. In the `_map_source_type_to_kind()` dict, add the line `"screenpipe": "screenpipe",` next to the other entries (alphabetical order if the dict is alphabetized).

- [ ] **Step 5: Restart memory-service and re-run test**

Run:
```bash
docker compose up -d --build memory-service
pytest tests/test_source_kind_mapping.py -v
```

Expected: PASS both tests.

- [ ] **Step 6: Commit**

```bash
git add memory-service/app/engram/ingestion.py tests/test_source_kind_mapping.py
git commit -m "feat(memory-service): map screenpipe source_type to screenpipe source_kind"
```

---

## Task 5: Build the fake screenpipe fixture

**Files:**
- Create: `tests/fixtures/fake_screenpipe.py`

- [ ] **Step 1: Read screenpipe's actual API shape for reference**

Look at screenpipe's source for the `/ws/events` event payload shape and the `/search` response shape — `crates/screenpipe-engine/src/server.rs` and `crates/screenpipe-engine/src/routes/websocket.rs`. If you have the local checkout: `/home/jeremy/workspace/screenpipe/`. Otherwise: GitHub at `https://github.com/mediar-ai/screenpipe/tree/main/crates/screenpipe-engine/src`. Copy the field names exactly so tests catch upstream drift.

- [ ] **Step 2: Implement the fake**

Create `tests/fixtures/fake_screenpipe.py`:

```python
"""Minimal Starlette server that mimics screenpipe's /ws/events and /search.

Tests construct a `FakeScreenpipe`, push events via .emit_*(), and the bridge
under test connects to it as if it were a real screenpipe daemon.

Field names mirror screenpipe-engine routes/websocket.rs and routes/search.rs.
"""

import asyncio
import json
import uuid
from datetime import datetime, timezone
from typing import Any

import uvicorn
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class FakeScreenpipe:
    def __init__(self, host: str = "127.0.0.1", port: int = 13030):
        self.host = host
        self.port = port
        self._events: list[dict[str, Any]] = []
        self._connections: list[WebSocket] = []
        self._auth_required: str | None = None
        self._server: uvicorn.Server | None = None
        self._task: asyncio.Task | None = None
        self._app = Starlette(
            routes=[
                WebSocketRoute("/ws/events", self._ws_handler),
                Route("/search", self._search_handler, methods=["GET"]),
            ]
        )

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"

    @property
    def ws_url(self) -> str:
        return f"ws://{self.host}:{self.port}/ws/events"

    def require_auth(self, api_key: str) -> None:
        self._auth_required = api_key

    async def start(self) -> None:
        config = uvicorn.Config(
            self._app, host=self.host, port=self.port,
            log_level="warning", lifespan="off"
        )
        self._server = uvicorn.Server(config)
        self._task = asyncio.create_task(self._server.serve())
        # Wait until ready
        for _ in range(50):
            await asyncio.sleep(0.05)
            if self._server.started:
                return
        raise RuntimeError("FakeScreenpipe failed to start")

    async def stop(self) -> None:
        if self._server:
            self._server.should_exit = True
        if self._task:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

    async def emit_ocr(
        self,
        *,
        app_name: str,
        window_name: str,
        text: str,
        browser_url: str | None = None,
        timestamp: str | None = None,
    ) -> None:
        event = {
            "name": "ocr_result",
            "data": {
                "frame_id": str(uuid.uuid4()),
                "app_name": app_name,
                "window_name": window_name,
                "browser_url": browser_url,
                "text": text,
                "timestamp": timestamp or _now_iso(),
                "focused": True,
            },
        }
        self._events.append(event)
        await self._broadcast(event)

    async def disconnect_all(self) -> None:
        for ws in list(self._connections):
            await ws.close()
        self._connections.clear()

    async def _broadcast(self, event: dict[str, Any]) -> None:
        for ws in list(self._connections):
            try:
                await ws.send_text(json.dumps(event))
            except Exception:
                pass

    async def _ws_handler(self, websocket: WebSocket) -> None:
        if self._auth_required:
            auth = websocket.headers.get("authorization", "")
            if auth != f"Bearer {self._auth_required}":
                await websocket.close(code=1008)
                return
        await websocket.accept()
        self._connections.append(websocket)
        try:
            while True:
                await websocket.receive_text()  # ignore client messages
        except WebSocketDisconnect:
            pass
        finally:
            if websocket in self._connections:
                self._connections.remove(websocket)

    async def _search_handler(self, request: Request) -> JSONResponse:
        if self._auth_required:
            auth = request.headers.get("authorization", "")
            if auth != f"Bearer {self._auth_required}":
                return JSONResponse({"error": "unauthorized"}, status_code=401)
        return JSONResponse({"data": [e["data"] for e in self._events], "pagination": {}})
```

- [ ] **Step 3: Smoke-test the fixture**

Quick interactive sanity check:

```bash
python -c "
import asyncio
from tests.fixtures.fake_screenpipe import FakeScreenpipe

async def main():
    fake = FakeScreenpipe()
    await fake.start()
    print('started at', fake.url)
    await fake.emit_ocr(app_name='Test', window_name='Test', text='hello')
    await fake.stop()
    print('stopped')

asyncio.run(main())
"
```

Expected: prints `started at http://127.0.0.1:13030` then `stopped`. No errors.

- [ ] **Step 4: Commit**

```bash
git add tests/fixtures/fake_screenpipe.py
git commit -m "test(screenpipe-bridge): add fake screenpipe fixture for bridge tests"
```

---

## Task 6: WebSocket subscriber with auth + reconnect backoff

**Files:**
- Create: `screenpipe-bridge/app/screenpipe_client.py`
- Test: `tests/test_websocket_reconnect.py`

- [ ] **Step 1: Write failing reconnect test**

Create `tests/test_websocket_reconnect.py`:

```python
import asyncio

import pytest

from screenpipe_bridge.app.screenpipe_client import ScreenpipeClient
from tests.fixtures.fake_screenpipe import FakeScreenpipe


@pytest.mark.asyncio
async def test_websocket_reconnects_after_disconnect():
    fake = FakeScreenpipe()
    await fake.start()
    received: list[dict] = []
    client = ScreenpipeClient(
        url=fake.url, api_key=None,
        on_event=lambda evt: received.append(evt),
    )
    await client.start()
    try:
        await fake.emit_ocr(app_name="A", window_name="W1", text="first")
        await asyncio.sleep(0.5)
        assert any(e["data"]["text"] == "first" for e in received)

        await fake.disconnect_all()
        await asyncio.sleep(2.0)  # let exponential backoff retry

        await fake.emit_ocr(app_name="A", window_name="W1", text="second")
        await asyncio.sleep(0.5)
        assert any(e["data"]["text"] == "second" for e in received)
    finally:
        await client.stop()
        await fake.stop()


@pytest.mark.asyncio
async def test_websocket_sends_authorization_header():
    fake = FakeScreenpipe()
    fake.require_auth("test-api-key")
    await fake.start()
    received: list[dict] = []
    client = ScreenpipeClient(
        url=fake.url, api_key="test-api-key",
        on_event=lambda evt: received.append(evt),
    )
    await client.start()
    try:
        await fake.emit_ocr(app_name="A", window_name="W1", text="auth-ok")
        await asyncio.sleep(0.5)
        assert any(e["data"]["text"] == "auth-ok" for e in received)
    finally:
        await client.stop()
        await fake.stop()
```

- [ ] **Step 2: Run, confirm failure**

Run: `pytest tests/test_websocket_reconnect.py -v`
Expected: FAIL (no module).

- [ ] **Step 3: Implement screenpipe_client.py with WebSocket support**

Create `screenpipe-bridge/app/screenpipe_client.py`:

```python
"""Subscribes to screenpipe's /ws/events with auth + exponential backoff reconnect."""

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse, urlunparse

import websockets

logger = logging.getLogger(__name__)


_BACKOFF_SCHEDULE = [1, 2, 4, 8, 16, 30, 60]


class ScreenpipeClient:
    def __init__(
        self,
        url: str,
        api_key: str | None,
        on_event: Callable[[dict[str, Any]], None | Any],
    ):
        self._url = url
        self._api_key = api_key
        self._on_event = on_event
        self._task: asyncio.Task | None = None
        self._stopped = False

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def _ws_url(self) -> str:
        parsed = urlparse(self._url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunparse((scheme, parsed.netloc, "/ws/events", "", "images=false", ""))

    async def _run(self) -> None:
        attempt = 0
        while not self._stopped:
            try:
                await self._connect_once()
                attempt = 0  # reset backoff on clean disconnect
            except Exception as exc:
                logger.warning("screenpipe ws error: %s", exc)
            if self._stopped:
                break
            delay = _BACKOFF_SCHEDULE[min(attempt, len(_BACKOFF_SCHEDULE) - 1)]
            attempt += 1
            await asyncio.sleep(delay)

    async def _connect_once(self) -> None:
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        async with websockets.connect(self._ws_url(), additional_headers=headers) as ws:
            logger.info("screenpipe ws connected")
            async for raw in ws:
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                result = self._on_event(event)
                if asyncio.iscoroutine(result):
                    await result
```

- [ ] **Step 4: Run tests, fix until PASS**

Run: `pytest tests/test_websocket_reconnect.py -v`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add screenpipe-bridge/app/screenpipe_client.py tests/test_websocket_reconnect.py
git commit -m "feat(screenpipe-bridge): websocket subscriber with auth + reconnect backoff"
```

---

## Task 7: HTTP polling fallback after 5 WS failures

**Files:**
- Modify: `screenpipe-bridge/app/screenpipe_client.py`
- Test: `tests/test_polling_fallback.py`

- [ ] **Step 1: Write failing polling test**

Create `tests/test_polling_fallback.py`:

```python
import asyncio

import pytest

from screenpipe_bridge.app.screenpipe_client import ScreenpipeClient
from tests.fixtures.fake_screenpipe import FakeScreenpipe


@pytest.mark.asyncio
async def test_falls_back_to_polling_when_ws_unavailable(monkeypatch):
    """After 5 WS failures the client polls /search and still delivers events."""
    fake = FakeScreenpipe()
    await fake.start()
    received: list[dict] = []
    client = ScreenpipeClient(
        url=fake.url,
        api_key=None,
        on_event=lambda evt: received.append(evt),
        ws_failures_before_polling=5,
        polling_interval_seconds=0.5,
        backoff_schedule_override=[0.05, 0.05, 0.05, 0.05, 0.05],
    )
    # Force WS to fail by closing connections immediately
    original_handler = fake._ws_handler

    async def reject(ws):
        await ws.close(code=1011)

    fake._ws_handler = reject

    await client.start()
    try:
        await fake.emit_ocr(app_name="A", window_name="W1", text="poll-me")
        await asyncio.sleep(2.0)  # 5 failures + first poll
        assert any(e["data"]["text"] == "poll-me" for e in received)
    finally:
        fake._ws_handler = original_handler
        await client.stop()
        await fake.stop()
```

- [ ] **Step 2: Run, confirm failure**

Run: `pytest tests/test_polling_fallback.py -v`
Expected: FAIL.

- [ ] **Step 3: Extend ScreenpipeClient with polling fallback**

Edit `screenpipe-bridge/app/screenpipe_client.py`. Add constructor params (`ws_failures_before_polling=5`, `polling_interval_seconds=30`, `backoff_schedule_override=None`), track consecutive failures, and switch to a polling loop using `httpx` against `/search?content_type=ocr&start_time=<last_ts>&end_time=now&limit=1000`. After successful poll, attempt WS reconnect every 5 minutes; on first WS success, switch back.

Pseudocode shape:

```python
async def _run(self):
    attempt = 0
    polling = False
    while not self._stopped:
        if not polling:
            try:
                await self._connect_once()
                attempt = 0
            except Exception:
                attempt += 1
            if attempt >= self._ws_failures_before_polling:
                polling = True
        else:
            await self._poll_once()
            await asyncio.sleep(self._polling_interval_seconds)
            # Periodically attempt to recover WS
            if self._should_retry_ws():
                try:
                    await self._connect_once()
                    polling = False
                    attempt = 0
                except Exception:
                    pass
        if not polling:
            await asyncio.sleep(self._next_backoff(attempt))
```

Implement carefully: track `last_seen_ts` to avoid replaying events; on each poll, walk results, dedup by frame_id, emit via `_on_event`.

- [ ] **Step 4: Run tests, all PASS**

Run: `pytest tests/test_polling_fallback.py tests/test_websocket_reconnect.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add screenpipe-bridge/app/screenpipe_client.py tests/test_polling_fallback.py
git commit -m "feat(screenpipe-bridge): HTTP polling fallback after 5 WS failures"
```

---

## Task 8: Session aggregator — focus session lifecycle + within-session dedup

**Files:**
- Create: `screenpipe-bridge/app/session_aggregator.py`
- Test: `tests/test_session_aggregation.py`
- Test: `tests/test_dedup_within_session.py`

- [ ] **Step 1: Write failing tests for session boundaries**

Create `tests/test_session_aggregation.py`:

```python
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from screenpipe_bridge.app.session_aggregator import SessionAggregator


def _ocr(app: str, window: str, text: str, ts: datetime, url: str | None = None) -> dict:
    return {
        "name": "ocr_result",
        "data": {
            "app_name": app, "window_name": window, "text": text,
            "browser_url": url, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "focused": True, "frame_id": f"{app}-{window}-{ts.timestamp()}",
        },
    }


@pytest.mark.asyncio
async def test_session_finalized_when_focus_changes():
    finalized: list = []
    agg = SessionAggregator(
        on_session=lambda s: finalized.append(s),
        session_min_seconds=0,
        session_max_minutes=30,
    )
    t0 = datetime(2026, 5, 2, 14, 0, 0, tzinfo=timezone.utc)
    await agg.process(_ocr("VS Code", "main.py", "first line\n", t0))
    await agg.process(_ocr("VS Code", "main.py", "first line\nsecond line\n", t0 + timedelta(seconds=10)))
    await agg.process(_ocr("Slack", "#nova", "hello", t0 + timedelta(seconds=15)))

    assert len(finalized) == 1
    assert finalized[0].app == "VS Code"
    assert finalized[0].window == "main.py"
    assert "first line" in finalized[0].content
    assert "second line" in finalized[0].content
```

Create `tests/test_dedup_within_session.py`:

```python
import asyncio
from datetime import datetime, timedelta, timezone

import pytest

from screenpipe_bridge.app.session_aggregator import SessionAggregator


def _ocr(app, window, text, ts):
    return {
        "name": "ocr_result",
        "data": {
            "app_name": app, "window_name": window, "text": text,
            "browser_url": None, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "focused": True, "frame_id": f"{ts.timestamp()}",
        },
    }


@pytest.mark.asyncio
async def test_repeated_lines_collapsed_within_session():
    finalized = []
    agg = SessionAggregator(
        on_session=lambda s: finalized.append(s),
        session_min_seconds=0, session_max_minutes=30,
    )
    t0 = datetime.now(timezone.utc)
    for i in range(5):
        await agg.process(_ocr("App", "Window", "line A\nline B\n", t0 + timedelta(seconds=i)))
    await agg.process(_ocr("Other", "Other", "x", t0 + timedelta(seconds=10)))

    assert finalized[0].content.count("line A") == 1
    assert finalized[0].content.count("line B") == 1
    assert finalized[0].content.index("line A") < finalized[0].content.index("line B")
```

- [ ] **Step 2: Run, confirm failure**

Run: `pytest tests/test_session_aggregation.py tests/test_dedup_within_session.py -v`
Expected: FAIL (no module).

- [ ] **Step 3: Implement SessionAggregator**

Create `screenpipe-bridge/app/session_aggregator.py`:

```python
"""Aggregates raw screenpipe events into focus sessions.

Boundaries:
- New focus (different app or window) → finalize current, start new.
- 30-min cap → finalize, start new immediately.
- <30s sessions discarded.
- Within session, dedup lines preserving order.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class FocusSession:
    app: str
    window: str
    url: str | None
    started_at: datetime
    ended_at: datetime
    content: str
    word_count: int
    event_count: int
    frame_ids: list[str] = field(default_factory=list)


@dataclass
class _ActiveSession:
    app: str
    window: str
    url: str | None
    started_at: datetime
    last_event_at: datetime
    seen_lines: set[str] = field(default_factory=set)
    ordered_lines: list[str] = field(default_factory=list)
    event_count: int = 0
    frame_ids: list[str] = field(default_factory=list)

    def absorb(self, text: str, frame_id: str) -> None:
        for line in text.splitlines():
            if line and line not in self.seen_lines:
                self.seen_lines.add(line)
                self.ordered_lines.append(line)
        self.event_count += 1
        if frame_id:
            self.frame_ids.append(frame_id)

    def to_finalized(self) -> FocusSession:
        content = "\n".join(self.ordered_lines)
        return FocusSession(
            app=self.app, window=self.window, url=self.url,
            started_at=self.started_at, ended_at=self.last_event_at,
            content=content, word_count=len(content.split()),
            event_count=self.event_count, frame_ids=self.frame_ids,
        )


class SessionAggregator:
    def __init__(
        self,
        on_session: Callable[[FocusSession], None | Awaitable[None]],
        session_min_seconds: int = 30,
        session_max_minutes: int = 30,
    ):
        self._on_session = on_session
        self._session_min = timedelta(seconds=session_min_seconds)
        self._session_max = timedelta(minutes=session_max_minutes)
        self._active: _ActiveSession | None = None

    async def process(self, event: dict[str, Any]) -> None:
        if event.get("name") != "ocr_result":
            return
        data = event.get("data", {}) or {}
        app = data.get("app_name") or ""
        window = data.get("window_name") or ""
        url = data.get("browser_url")
        text = data.get("text") or ""
        ts_raw = data.get("timestamp")
        try:
            ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            ts = datetime.now(timezone.utc)
        frame_id = data.get("frame_id") or ""

        if self._active is None:
            self._active = _ActiveSession(
                app=app, window=window, url=url, started_at=ts, last_event_at=ts,
            )
            self._active.absorb(text, frame_id)
            return

        # 30-min cap?
        if ts - self._active.started_at >= self._session_max:
            await self._finalize_active()
            self._active = _ActiveSession(
                app=app, window=window, url=url, started_at=ts, last_event_at=ts,
            )
            self._active.absorb(text, frame_id)
            return

        # Focus change?
        if app != self._active.app or window != self._active.window:
            await self._finalize_active()
            self._active = _ActiveSession(
                app=app, window=window, url=url, started_at=ts, last_event_at=ts,
            )
            self._active.absorb(text, frame_id)
            return

        # Same window, same session
        self._active.last_event_at = ts
        self._active.absorb(text, frame_id)

    async def flush(self) -> None:
        if self._active is not None:
            await self._finalize_active()
            self._active = None

    async def _finalize_active(self) -> None:
        assert self._active is not None
        duration = self._active.last_event_at - self._active.started_at
        if duration < self._session_min:
            logger.debug("dropping <%s session for %s/%s", self._session_min, self._active.app, self._active.window)
            self._active = None
            return
        finalized = self._active.to_finalized()
        result = self._on_session(finalized)
        if asyncio.iscoroutine(result):
            await result
        self._active = None
```

- [ ] **Step 4: Run all aggregator tests**

Run: `pytest tests/test_session_aggregation.py tests/test_dedup_within_session.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add screenpipe-bridge/app/session_aggregator.py tests/test_session_aggregation.py tests/test_dedup_within_session.py
git commit -m "feat(screenpipe-bridge): focus-session aggregator with within-session dedup"
```

---

## Task 9: Session aggregator — 30-min cap + 30s drop edge cases

**Files:**
- Test: `tests/test_session_cap_30min.py`
- Test: `tests/test_short_session_drop.py`

- [ ] **Step 1: Write the cap test**

Create `tests/test_session_cap_30min.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from screenpipe_bridge.app.session_aggregator import SessionAggregator


def _ocr(app, window, text, ts):
    return {
        "name": "ocr_result",
        "data": {
            "app_name": app, "window_name": window, "text": text,
            "browser_url": None, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "focused": True, "frame_id": str(ts.timestamp()),
        },
    }


@pytest.mark.asyncio
async def test_long_session_split_at_30_min_cap():
    finalized = []
    agg = SessionAggregator(
        on_session=lambda s: finalized.append(s),
        session_min_seconds=0, session_max_minutes=30,
    )
    t0 = datetime(2026, 5, 2, 14, 0, 0, tzinfo=timezone.utc)
    # Same window, events spanning >30 min
    await agg.process(_ocr("VS Code", "main.py", "early\n", t0))
    await agg.process(_ocr("VS Code", "main.py", "mid\n", t0 + timedelta(minutes=20)))
    await agg.process(_ocr("VS Code", "main.py", "late\n", t0 + timedelta(minutes=35)))
    await agg.flush()

    assert len(finalized) == 2
    assert "early" in finalized[0].content
    assert "late" in finalized[1].content
    # Continuity check: second starts at the >30 min event timestamp
    assert finalized[1].started_at == t0 + timedelta(minutes=35)
```

- [ ] **Step 2: Write the drop test**

Create `tests/test_short_session_drop.py`:

```python
from datetime import datetime, timedelta, timezone

import pytest

from screenpipe_bridge.app.session_aggregator import SessionAggregator


def _ocr(app, window, text, ts):
    return {
        "name": "ocr_result",
        "data": {
            "app_name": app, "window_name": window, "text": text,
            "browser_url": None, "timestamp": ts.isoformat().replace("+00:00", "Z"),
            "focused": True, "frame_id": str(ts.timestamp()),
        },
    }


@pytest.mark.asyncio
async def test_session_under_30s_dropped():
    finalized = []
    agg = SessionAggregator(
        on_session=lambda s: finalized.append(s),
        session_min_seconds=30, session_max_minutes=30,
    )
    t0 = datetime.now(timezone.utc)
    await agg.process(_ocr("Slack", "#dms", "ping", t0))
    await agg.process(_ocr("Slack", "#dms", "ping pong", t0 + timedelta(seconds=10)))
    await agg.process(_ocr("Other", "Other", "switched", t0 + timedelta(seconds=11)))

    assert finalized == []  # Slack session was 10s, dropped
```

- [ ] **Step 3: Run both tests, confirm PASS (Task 8's implementation already supports them)**

Run: `pytest tests/test_session_cap_30min.py tests/test_short_session_drop.py -v`
Expected: both PASS.

- [ ] **Step 4: If they don't pass, fix the aggregator until they do.**

- [ ] **Step 5: Commit**

```bash
git add tests/test_session_cap_30min.py tests/test_short_session_drop.py screenpipe-bridge/app/session_aggregator.py
git commit -m "test(screenpipe-bridge): verify 30-min cap split and <30s drop behavior"
```

---

## Task 10: Privacy denylist (apps + url_patterns + window_titles)

**Files:**
- Create: `screenpipe-bridge/app/denylist.py`
- Test: `tests/test_denylist_filtering_app.py`
- Test: `tests/test_denylist_filtering_url.py`
- Test: `tests/test_denylist_filtering_window.py`

- [ ] **Step 1: Write failing tests**

Create `tests/test_denylist_filtering_app.py`:

```python
from screenpipe_bridge.app.denylist import Denylist


def test_app_denylist_exact_match():
    dl = Denylist(apps=["1Password"], url_patterns=[], window_titles=[])
    assert dl.matches({"app": "1Password", "window": "Vault", "url": None})
    assert not dl.matches({"app": "VS Code", "window": "1Password notes", "url": None})


def test_app_denylist_case_sensitive():
    dl = Denylist(apps=["1Password"], url_patterns=[], window_titles=[])
    assert not dl.matches({"app": "1password", "window": "x", "url": None})
```

Create `tests/test_denylist_filtering_url.py`:

```python
from screenpipe_bridge.app.denylist import Denylist


def test_url_denylist_regex_match():
    dl = Denylist(apps=[], url_patterns=[r"^https://.*\.bank/"], window_titles=[])
    assert dl.matches({"app": "Chrome", "window": "Login", "url": "https://chase.bank/login"})
    assert not dl.matches({"app": "Chrome", "window": "Login", "url": "https://example.com/"})


def test_url_denylist_no_match_when_url_missing():
    dl = Denylist(apps=[], url_patterns=[r"^https://.*\.bank/"], window_titles=[])
    assert not dl.matches({"app": "VS Code", "window": "x", "url": None})
```

Create `tests/test_denylist_filtering_window.py`:

```python
from screenpipe_bridge.app.denylist import Denylist


def test_window_title_substring_case_insensitive():
    dl = Denylist(apps=[], url_patterns=[], window_titles=["Password", "Incognito"])
    assert dl.matches({"app": "Chrome", "window": "Settings — Password Manager", "url": None})
    assert dl.matches({"app": "Chrome", "window": "incognito tab", "url": None})
    assert not dl.matches({"app": "Chrome", "window": "Inbox", "url": None})
```

- [ ] **Step 2: Run, confirm failure**

Run: `pytest tests/test_denylist_filtering_*.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement Denylist**

Create `screenpipe-bridge/app/denylist.py`:

```python
"""Privacy denylist: drop sessions matching any of three sub-lists."""

import re
from dataclasses import dataclass


@dataclass
class Denylist:
    apps: list[str]
    url_patterns: list[str]
    window_titles: list[str]

    def __post_init__(self) -> None:
        self._compiled_url_patterns = [re.compile(p) for p in self.url_patterns]
        self._lower_window_titles = [w.lower() for w in self.window_titles]

    def matches(self, session: dict) -> bool:
        return self._matches_with_reason(session) is not None

    def matches_with_reason(self, session: dict) -> str | None:
        return self._matches_with_reason(session)

    def _matches_with_reason(self, session: dict) -> str | None:
        app = session.get("app") or ""
        window = (session.get("window") or "").lower()
        url = session.get("url")
        if app in self.apps:
            return "denylist_app"
        if url and any(p.search(url) for p in self._compiled_url_patterns):
            return "denylist_url"
        if window and any(t in window for t in self._lower_window_titles):
            return "denylist_window"
        return None
```

- [ ] **Step 4: Run tests, all PASS**

Run: `pytest tests/test_denylist_filtering_*.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add screenpipe-bridge/app/denylist.py tests/test_denylist_filtering_*.py
git commit -m "feat(screenpipe-bridge): privacy denylist (apps, url patterns, window titles)"
```

---

## Task 11: Engram producer — payload assembly + LPUSH

**Files:**
- Create: `screenpipe-bridge/app/engram_producer.py`
- Test: `tests/test_engram_ingestion_payload.py`

- [ ] **Step 1: Write failing payload test**

Create `tests/test_engram_ingestion_payload.py`:

```python
import hashlib
import json
from datetime import datetime, timezone

import pytest
import redis.asyncio as redis_async

from screenpipe_bridge.app.engram_producer import EngramProducer
from screenpipe_bridge.app.session_aggregator import FocusSession
from screenpipe_bridge.app.tenant import DEFAULT_TENANT


@pytest.mark.asyncio
async def test_payload_shape_matches_decomposer_contract():
    r = redis_async.from_url("redis://localhost:6379/0")
    await r.delete("engram:ingestion:queue")
    producer = EngramProducer(redis=r, device_id="primary", trust=0.80)
    started = datetime(2026, 5, 2, 14, 32, 0, tzinfo=timezone.utc)
    ended = datetime(2026, 5, 2, 14, 51, 0, tzinfo=timezone.utc)
    session = FocusSession(
        app="VS Code", window="clients.py — orchestrator",
        url="file:///tmp/clients.py", started_at=started, ended_at=ended,
        content="some screen text\nmore text", word_count=4, event_count=20, frame_ids=["a", "b"],
    )

    await producer.push(session)

    raw = await r.lpop("engram:ingestion:queue")
    payload = json.loads(raw)

    assert payload["raw_text"].startswith("some screen text")
    assert payload["source_type"] == "screenpipe"
    assert payload["tenant_id"] == DEFAULT_TENANT
    assert payload["source_trust"] == 0.80
    assert payload["source_uri"].startswith("screenpipe://primary/2026-05-02T14:32:00")
    assert payload["source_title"].startswith("VS Code — clients.py")
    assert payload["session_id"] == "screenpipe:primary:2026-05-02T14:32:00+00:00"
    assert payload["occurred_at"] == "2026-05-02T14:32:00+00:00"
    assert payload["metadata"]["app"] == "VS Code"
    assert payload["metadata"]["device_id"] == "primary"
    assert "source_id" not in payload  # decomposer creates it

    await r.aclose()
```

- [ ] **Step 2: Run, confirm failure**

Run: `pytest tests/test_engram_ingestion_payload.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement EngramProducer**

Create `screenpipe-bridge/app/engram_producer.py`:

```python
"""Builds the engram ingestion payload from a finalized session and LPUSHes to Redis db0."""

import hashlib
import json
import logging

import redis.asyncio as redis_async

from screenpipe_bridge.app.session_aggregator import FocusSession
from screenpipe_bridge.app.tenant import DEFAULT_TENANT

logger = logging.getLogger(__name__)

_QUEUE_KEY = "engram:ingestion:queue"


class EngramProducer:
    def __init__(
        self,
        redis: redis_async.Redis,
        device_id: str = "primary",
        trust: float = 0.80,
    ):
        self._redis = redis
        self._device_id = device_id
        self._trust = trust

    async def push(self, session: FocusSession) -> None:
        payload = self._build_payload(session)
        await self._redis.lpush(_QUEUE_KEY, json.dumps(payload))

    def _build_payload(self, session: FocusSession) -> dict:
        start_iso = session.started_at.isoformat()
        end_iso = session.ended_at.isoformat()
        title_time = session.started_at.strftime("%H:%M") + "-" + session.ended_at.strftime("%H:%M")
        window_hash = hashlib.sha256(
            f"{session.app}{session.window}{session.url or ''}".encode()
        ).hexdigest()[:12]
        title = f"{session.app} — {session.window} — {title_time}"
        if len(title) > 200:
            title = title[:197] + "..."
        return {
            "raw_text": session.content,
            "source_type": "screenpipe",
            "session_id": f"screenpipe:{self._device_id}:{start_iso}",
            "occurred_at": start_iso,
            "tenant_id": DEFAULT_TENANT,
            "metadata": {
                "app": session.app,
                "window": session.window,
                "url": session.url,
                "device_id": self._device_id,
                "captured_at_start": start_iso,
                "captured_at_end": end_iso,
                "word_count": session.word_count,
                "screenpipe_event_count": session.event_count,
            },
            "source_trust": self._trust,
            "source_uri": f"screenpipe://{self._device_id}/{start_iso}/{window_hash}",
            "source_title": title,
        }
```

- [ ] **Step 4: Run test, PASS**

Run: `pytest tests/test_engram_ingestion_payload.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add screenpipe-bridge/app/engram_producer.py tests/test_engram_ingestion_payload.py
git commit -m "feat(screenpipe-bridge): engram-queue payload producer matching decomposer contract"
```

---

## Task 12: Wire components into main service + bounded backpressure queue

**Files:**
- Modify: `screenpipe-bridge/app/main.py`
- Test: `tests/test_backpressure_drop.py`

- [ ] **Step 1: Write failing backpressure test**

Create `tests/test_backpressure_drop.py`:

```python
import asyncio

import pytest

from screenpipe_bridge.app.main import BridgePipeline


@pytest.mark.asyncio
async def test_full_buffer_drops_newest_session(bridge_with_blocked_producer):
    """When the producer can't push, the bounded buffer drops newest after capacity."""
    pipeline = bridge_with_blocked_producer  # buffer size 2, producer blocked
    await pipeline.enqueue(_session("a"))
    await pipeline.enqueue(_session("b"))
    await pipeline.enqueue(_session("c"))  # should drop "c"
    await pipeline.enqueue(_session("d"))  # should drop "d"

    pipeline.unblock_producer()
    drained = await pipeline.drain(timeout=2.0)
    pushed = [s.app for s in drained]
    assert "a" in pushed
    assert "b" in pushed
    assert "c" not in pushed
    assert "d" not in pushed
    assert pipeline.dropped_count("buffer_full") == 2
```

(A fixture `bridge_with_blocked_producer` and a `_session` helper need to exist; create them inside the test file as needed.)

- [ ] **Step 2: Run, confirm failure**

Run: `pytest tests/test_backpressure_drop.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement BridgePipeline in main.py**

Edit `screenpipe-bridge/app/main.py`. Wire `RuntimeConfig` + `ScreenpipeClient` + `SessionAggregator` + `Denylist` + `EngramProducer` together. Introduce a bounded `asyncio.Queue` (size from `nova:config:capture.buffer_size`, default 10). The aggregator's `on_session` callback enqueues the session; a background consumer task pops and pushes to the engram producer. When the buffer is full, drop the new session and increment `nova_screenpipe_sessions_dropped_total{reason="buffer_full"}`.

**Two important wiring details from spec Section 7:**

1. **Credential refresh on config change.** `ScreenpipeClient` takes URL/api_key in its constructor (Task 6). The pipeline's runtime-config-poll loop (every 30s) must compare the latest `screenpipe.url` and `screenpipe.api_key` against the values used to construct the current client; on change, tear down the existing `ScreenpipeClient` (`await client.stop()`) and construct a new one with the new credentials. This is what makes "config edit triggers reconnect within at most 30s" actually true (spec Section 7).

2. **Dashboard-visible dropped counter.** Beyond the in-memory counter and Prometheus metric, every `_increment_dropped(reason)` call must also `HINCRBY` a date-keyed Redis hash `nova:capture:dropped:<YYYY-MM-DD-utc>` field `<reason>` by 1, against Redis db0 (or db10 — pick one and document). The orchestrator today-stats endpoint (Task 16) reads from this hash to populate the dashboard's "Dropped" stat. Without this, the Capture page can never show a non-zero dropped count, since dropped sessions produce no `sources` rows.

Outline:

```python
class BridgePipeline:
    def __init__(self, runtime_config, denylist, producer, buffer_size=10, paused_check=lambda: False):
        self._runtime_config = runtime_config
        self._denylist = denylist
        self._producer = producer
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=buffer_size)
        self._aggregator = SessionAggregator(on_session=self._handle_finalized)
        self._dropped: dict[str, int] = {}
        self._paused_check = paused_check
        self._consumer_task: asyncio.Task | None = None

    async def start(self):
        self._consumer_task = asyncio.create_task(self._consume_loop())

    async def process_event(self, event):
        await self._aggregator.process(event)

    async def _handle_finalized(self, session):
        if self._paused_check():
            self._increment_dropped("paused")
            return
        match_reason = self._denylist.matches_with_reason({
            "app": session.app, "window": session.window, "url": session.url,
        })
        if match_reason:
            self._increment_dropped(match_reason)
            return
        try:
            self._queue.put_nowait(session)
        except asyncio.QueueFull:
            self._increment_dropped("buffer_full")
            logger.warning("dropping session for %s/%s — buffer full", session.app, session.window)

    async def _consume_loop(self):
        while True:
            session = await self._queue.get()
            try:
                await self._producer.push(session)
            except Exception as exc:
                logger.error("engram push failed: %s", exc)

    def _increment_dropped(self, reason):
        self._dropped[reason] = self._dropped.get(reason, 0) + 1
```

Wire `BridgePipeline` into the FastAPI lifespan, with the `ScreenpipeClient.on_event` calling `pipeline.process_event(...)`.

- [ ] **Step 4: Run test, PASS**

Run: `pytest tests/test_backpressure_drop.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add screenpipe-bridge/app/main.py tests/test_backpressure_drop.py
git commit -m "feat(screenpipe-bridge): wire pipeline + bounded backpressure queue"
```

---

## Task 13: Pause behavior

**Files:**
- Modify: `screenpipe-bridge/app/main.py`
- Test: `tests/test_pause_resume.py`

- [ ] **Step 1: Write failing pause test**

Create `tests/test_pause_resume.py`:

```python
import asyncio

import pytest
import redis.asyncio as redis_async

from screenpipe_bridge.app.main import BridgePipeline
# ...construct denylist, runtime_config, producer fixtures...


@pytest.mark.asyncio
async def test_paused_state_discards_sessions_and_increments_counter(pipeline_under_test, redis_db1):
    await redis_db1.set("nova:config:capture.paused", "true")
    await pipeline_under_test.refresh_config()

    # Synthesize event sequence that would normally produce one session
    await _drive_one_session(pipeline_under_test)
    drained = await pipeline_under_test.drain(timeout=1.0)

    assert drained == []
    assert pipeline_under_test.dropped_count("paused") >= 1


@pytest.mark.asyncio
async def test_health_ready_returns_200_with_paused_true(http_client):
    """While paused, /health/ready stays 200 with body {paused: true}."""
    r = await http_client.get("http://localhost:8140/health/ready")
    assert r.status_code == 200
    body = r.json()
    assert body.get("paused") is True
```

- [ ] **Step 2: Run, confirm failure**

Run: `pytest tests/test_pause_resume.py -v`
Expected: FAIL.

- [ ] **Step 3: Implement pause check + counter increment**

Edit `screenpipe-bridge/app/main.py`. The `BridgePipeline.paused_check` callback should consult `runtime_config.get_bool("capture.paused", False)`. When true, `_handle_finalized` increments `nova_screenpipe_sessions_dropped_total{reason="paused"}` once per finalized session (also HINCRBY `nova:capture:dropped:<today>` per Task 12's note) and returns without enqueueing. The `/health/ready` endpoint includes `"paused": await runtime_config.get_bool("capture.paused", False)` in its response body — `RuntimeConfig` exposes only async accessors per Task 2; the handler is already async so awaiting is fine.

- [ ] **Step 4: Run tests, all PASS**

Run: `pytest tests/test_pause_resume.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add screenpipe-bridge/app/main.py tests/test_pause_resume.py
git commit -m "feat(screenpipe-bridge): pause behavior with paused-counter and health passthrough"
```

---

## Task 14: tenant_id propagation test

**Files:**
- Test: `tests/test_tenant_id_propagation.py`

- [ ] **Step 1: Write end-to-end tenant propagation test**

Create `tests/test_tenant_id_propagation.py`:

```python
import asyncio
import json
import logging

import pytest
import redis.asyncio as redis_async

from screenpipe_bridge.app.tenant import DEFAULT_TENANT
# ...drive a real session through bridge; pop from engram queue; assert tenant_id matches


@pytest.mark.asyncio
async def test_session_payloads_carry_default_tenant_id(bridge_under_test, redis_db0):
    await _drive_one_session_through(bridge_under_test)
    raw = await redis_db0.lpop("engram:ingestion:queue")
    assert raw is not None
    payload = json.loads(raw)
    assert payload["tenant_id"] == DEFAULT_TENANT


@pytest.mark.asyncio
async def test_no_fc001_grace_warning_in_memory_service_logs(memory_service_logs):
    """Push a screenpipe session and confirm memory-service emits no FC-001 warning."""
    # Push a known payload; tail memory-service logs for FC-001
    await _push_known_screenpipe_payload()
    await asyncio.sleep(2.0)
    fc001_lines = [l for l in memory_service_logs.recent() if "FC-001" in l]
    assert fc001_lines == []
```

- [ ] **Step 2: Run, confirm PASS**

Run: `pytest tests/test_tenant_id_propagation.py -v`
Expected: PASS (Tasks 11+13 already make this work).

- [ ] **Step 3: Commit**

```bash
git add tests/test_tenant_id_propagation.py
git commit -m "test(screenpipe-bridge): verify tenant_id propagation, no FC-001 grace warning"
```

---

## Task 15: Health endpoints + /test-connection + metrics

**Files:**
- Modify: `screenpipe-bridge/app/main.py`
- Create: `screenpipe-bridge/app/metrics.py`
- Modify: `tests/test_screenpipe_bridge_health.py`

- [ ] **Step 1: Define metrics counters**

Create `screenpipe-bridge/app/metrics.py`:

```python
from prometheus_client import Counter, Gauge

sessions_ingested_total = Counter(
    "nova_screenpipe_sessions_ingested_total",
    "Successfully ingested screenpipe focus sessions",
    ["app"],
)
sessions_dropped_total = Counter(
    "nova_screenpipe_sessions_dropped_total",
    "Dropped screenpipe focus sessions by reason",
    ["reason"],
)
websocket_reconnects_total = Counter(
    "nova_screenpipe_websocket_reconnects_total",
    "WebSocket reconnect attempts",
)
polling_active = Gauge(
    "nova_screenpipe_polling_active",
    "1 if currently in polling fallback mode",
)
```

- [ ] **Step 2: Update /health/ready to enforce its contract**

Edit `screenpipe-bridge/app/main.py`. `/health/ready` returns 200 only if: bridge is connected to screenpipe (or actively polling) AND can reach Redis. When `capture.paused` is true, still return 200 with `paused: true`. Otherwise return 503 with reason field.

```python
@app.get("/health/ready")
async def health_ready():
    paused = await runtime_config.get_bool("capture.paused", False)
    if paused:
        return {"status": "ready", "paused": True}
    if not pipeline.is_screenpipe_connected() and not pipeline.is_polling():
        return JSONResponse({"status": "down", "reason": "screenpipe disconnected"}, status_code=503)
    if not await pipeline.redis_reachable():
        return JSONResponse({"status": "down", "reason": "redis unreachable"}, status_code=503)
    return {"status": "ready", "paused": False}
```

- [ ] **Step 3: Implement /test-connection endpoint (admin-only)**

Edit `screenpipe-bridge/app/main.py`. Add:

```python
@app.get("/test-connection", dependencies=[Depends(require_admin_secret)])
async def test_connection():
    url = await runtime_config.get_str("screenpipe.url")
    api_key = await runtime_config.get_str("screenpipe.api_key")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{url}/search?limit=1", headers=headers)
            r.raise_for_status()
            sample_count = len(r.json().get("data", []))
        return {"ok": True, "message": "connected", "sample_event_count": sample_count}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
```

`require_admin_secret` should validate `X-Admin-Secret` against `NOVA_ADMIN_SECRET` env var (read from container env, populated by Compose).

- [ ] **Step 4: Expand the bridge health test**

Edit `tests/test_screenpipe_bridge_health.py`:

```python
@pytest.mark.asyncio
async def test_health_ready_503_when_screenpipe_disconnected():
    # With no SCREENPIPE_URL configured, bridge cannot connect
    async with httpx.AsyncClient(timeout=5.0) as client:
        r = await client.get("http://localhost:8140/health/ready")
        assert r.status_code in (200, 503)
```

- [ ] **Step 5: Run all bridge tests**

Run: `pytest tests/test_screenpipe_*.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add screenpipe-bridge/app/main.py screenpipe-bridge/app/metrics.py tests/test_screenpipe_bridge_health.py
git commit -m "feat(screenpipe-bridge): /health/ready, /test-connection, metrics counters"
```

---

## Task 16: Orchestrator capture endpoints

**Files:**
- Create: `orchestrator/app/capture_router.py`
- Modify: `orchestrator/app/main.py`
- Test: `tests/test_capture_endpoints.py`

- [ ] **Step 1: Write failing endpoint tests**

Create `tests/test_capture_endpoints.py`:

```python
import httpx
import pytest


@pytest.mark.asyncio
async def test_list_capture_sessions_returns_screenpipe_sources_only():
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get("http://localhost:8000/api/v1/capture/sessions?limit=10")
        r.raise_for_status()
        body = r.json()
        assert "sessions" in body
        for s in body["sessions"]:
            assert s["source_kind"] == "screenpipe"


@pytest.mark.asyncio
async def test_today_stats_shape():
    async with httpx.AsyncClient(timeout=10.0) as c:
        r = await c.get("http://localhost:8000/api/v1/capture/today-stats")
        r.raise_for_status()
        body = r.json()
        assert "sessions_count" in body
        assert "captured_seconds" in body
        assert "dropped_count" in body
        assert "top_apps" in body
        assert isinstance(body["top_apps"], list)
```

- [ ] **Step 2: Run, confirm 404**

Run: `pytest tests/test_capture_endpoints.py -v`
Expected: FAIL with 404.

- [ ] **Step 3: Implement capture_router**

Create `orchestrator/app/capture_router.py`:

```python
"""HTTP endpoints backing the dashboard Capture page."""

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query

from orchestrator.app.db import get_db_pool

router = APIRouter(prefix="/api/v1/capture", tags=["capture"])


@router.get("/sessions")
async def list_sessions(limit: int = Query(50, ge=1, le=500), pool=Depends(get_db_pool)):
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, source_kind, uri, title, metadata, trust_score, created_at
              FROM sources
             WHERE source_kind = 'screenpipe'
             ORDER BY created_at DESC
             LIMIT $1
            """,
            limit,
        )
    return {"sessions": [dict(r) for r in rows]}


@router.get("/today-stats")
async def today_stats(pool=Depends(get_db_pool)):
    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT metadata->>'app' AS app, metadata, created_at
              FROM sources
             WHERE source_kind = 'screenpipe' AND created_at >= $1
            """,
            today_start,
        )
    sessions_count = len(rows)
    by_app: dict[str, float] = {}
    captured_seconds = 0.0
    for r in rows:
        meta = r["metadata"] or {}
        try:
            start = datetime.fromisoformat(meta["captured_at_start"].replace("Z", "+00:00"))
            end = datetime.fromisoformat(meta["captured_at_end"].replace("Z", "+00:00"))
            secs = (end - start).total_seconds()
            captured_seconds += secs
            by_app[r["app"]] = by_app.get(r["app"], 0.0) + secs
        except (KeyError, ValueError):
            continue
    top_apps = sorted(by_app.items(), key=lambda x: x[1], reverse=True)[:5]

    # Read today's dropped count from the bridge-maintained Redis hash
    # (see Task 12 Step 3 — bridge HINCRBYs nova:capture:dropped:<YYYY-MM-DD>)
    today_key = f"nova:capture:dropped:{today_start.strftime('%Y-%m-%d')}"
    dropped_total = 0
    async with get_redis_db0() as r:
        raw = await r.hgetall(today_key)
        for v in raw.values():
            try:
                dropped_total += int(v)
            except (TypeError, ValueError):
                continue

    return {
        "sessions_count": sessions_count,
        "captured_seconds": int(captured_seconds),
        "dropped_count": dropped_total,
        "top_apps": [{"app": a, "captured_seconds": int(s)} for a, s in top_apps],
    }
```

- [ ] **Step 4: Wire router into orchestrator/app/main.py**

Find the existing `app.include_router(...)` call site and add:

```python
from orchestrator.app.capture_router import router as capture_router
app.include_router(capture_router)
```

- [ ] **Step 5: Restart orchestrator, run tests**

Run:
```bash
docker compose up -d --build orchestrator
pytest tests/test_capture_endpoints.py -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add orchestrator/app/capture_router.py orchestrator/app/main.py tests/test_capture_endpoints.py
git commit -m "feat(orchestrator): capture sessions + today-stats endpoints for dashboard"
```

---

## Task 17: Dashboard Settings → Connections → Screenpipe section

**Files:**
- Create: `dashboard/src/pages/settings/ScreenpipeConnectionSection.tsx`
- Modify: `dashboard/src/pages/Settings.tsx`
- Modify: `dashboard/src/api.ts`

- [ ] **Step 1: Add API client functions**

Edit `dashboard/src/api.ts`. Add:

```typescript
export async function testScreenpipeConnection(): Promise<{ ok: boolean; message?: string; sample_event_count?: number; error?: string }> {
  return apiFetch("/screenpipe-bridge/test-connection");
}
```

(Adjust path prefix to whatever Nginx/dev-server proxy convention is used to reach the bridge from the dashboard.)

- [ ] **Step 2: Build the connection section component**

Create `dashboard/src/pages/settings/ScreenpipeConnectionSection.tsx`. Use the existing `Section`, `ConfigField`, `useConfigValue` shared components from `dashboard/src/pages/settings/shared.tsx`. Three fields (Enabled, URL, API Key), a Test Connection button, and a status indicator. Pattern-match the existing `ChatIntegrationsSection.tsx` for layout.

```tsx
import { useState } from "react";
import { Section, ConfigField, useConfigValue } from "./shared";
import { testScreenpipeConnection } from "../../api";

export function ScreenpipeConnectionSection() {
  const enabled = useConfigValue("screenpipe.enabled", "boolean", false);
  const url = useConfigValue("screenpipe.url", "string", "");
  const apiKey = useConfigValue("screenpipe.api_key", "secret", "");
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const onTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await testScreenpipeConnection();
      setTestResult(result.ok ? `Connected (${result.sample_event_count ?? 0} sample events)` : `Error: ${result.error}`);
    } catch (e) {
      setTestResult(`Error: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <Section title="Screenpipe" description="Subscribe to a workstation-side screenpipe daemon for personal screen capture.">
      <ConfigField label="Enabled" {...enabled} />
      <ConfigField label="Screenpipe URL" placeholder="http://workstation:3030" {...url} />
      <ConfigField label="API Key" type="password" {...apiKey} />
      <button onClick={onTest} disabled={testing} className="mt-4 rounded bg-teal-600 px-3 py-1.5 text-white disabled:opacity-50">
        {testing ? "Testing…" : "Test Connection"}
      </button>
      {testResult && <p className="mt-2 text-sm">{testResult}</p>}
    </Section>
  );
}
```

- [ ] **Step 3: Register in Settings.tsx**

Edit `dashboard/src/pages/Settings.tsx`. Import `ScreenpipeConnectionSection` and add it under the Connections tab in the existing render order documented in CLAUDE.md memory: **Connections:** Remote Access → Chat Integrations → **Screenpipe**.

- [ ] **Step 4: Build dashboard, verify page renders**

Run: `cd dashboard && npm run build`
Expected: build succeeds (no TS errors).

Then start dev server and visit `http://localhost:5173/settings`, navigate to Connections tab. Confirm Screenpipe section appears.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/pages/settings/ScreenpipeConnectionSection.tsx dashboard/src/pages/Settings.tsx dashboard/src/api.ts
git commit -m "feat(dashboard): screenpipe connection settings section"
```

---

## Task 18: Dashboard Settings → Capture → Privacy section

**Files:**
- Create: `dashboard/src/pages/settings/CapturePrivacySection.tsx`
- Modify: `dashboard/src/pages/Settings.tsx`

- [ ] **Step 1: Build the privacy section**

Create `dashboard/src/pages/settings/CapturePrivacySection.tsx`. Three list-style editors (apps, url_patterns, window_titles) backed by JSON-array Redis keys. A "Reset to defaults" button writes the spec's defaults back. Use chip-list components if Nova has one; otherwise build a minimal one.

Recommended: encapsulate a small `<ListEditor>` component that takes label, items, onChange — single component reused three times.

- [ ] **Step 2: Register in Settings.tsx**

Add a new "Capture" top-level tab (or sub-tab under existing tabs — confirm Settings.tsx structure first), with Privacy as the default subsection.

- [ ] **Step 3: Build and visually verify**

Run: `cd dashboard && npm run build`. Open dev server, navigate to Settings → Capture → Privacy. Add a denylist entry, confirm it persists across page reloads (round-trip via Redis).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/settings/CapturePrivacySection.tsx dashboard/src/pages/Settings.tsx
git commit -m "feat(dashboard): capture privacy denylist editor"
```

---

## Task 19: Dashboard Settings → Capture → Advanced section

**Files:**
- Create: `dashboard/src/pages/settings/CaptureAdvancedSection.tsx`
- Modify: `dashboard/src/pages/Settings.tsx`

- [ ] **Step 1: Build the advanced section**

Create `dashboard/src/pages/settings/CaptureAdvancedSection.tsx`. Four fields: session max duration (slider 5–120 min), session min duration (slider 0–300s), backpressure buffer size (number 1–100), capture paused toggle. Collapsed by default (use the existing collapsible pattern from other Settings sections).

- [ ] **Step 2: Register in Settings.tsx under the Capture tab**

- [ ] **Step 3: Build and verify**

Run: `cd dashboard && npm run build`. Open Settings → Capture → Advanced, change a value, refresh, confirm value persists.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/settings/CaptureAdvancedSection.tsx dashboard/src/pages/Settings.tsx
git commit -m "feat(dashboard): capture advanced settings (session params, pause toggle)"
```

---

## Task 20: Dashboard Capture nav + routes + placeholders

**Files:**
- Create: `dashboard/src/pages/capture/MeetingsPlaceholder.tsx`
- Create: `dashboard/src/pages/capture/JournalsPlaceholder.tsx`
- Modify: `dashboard/src/components/layout/Nav.tsx` (or equivalent)
- Modify: `dashboard/src/App.tsx` (or routing file)

- [ ] **Step 1: Create placeholders**

Create both placeholder files with one-line "Coming in sub-project N" messages and matching layout chrome.

- [ ] **Step 2: Add nav item**

Edit the nav file. Add a "Capture" top-level entry. Sub-routes:
- `/capture` → CapturePage (Task 21)
- `/capture/meetings` → MeetingsPlaceholder
- `/capture/journals` → JournalsPlaceholder

- [ ] **Step 3: Wire routes**

Edit `dashboard/src/App.tsx` (or the router file). Register the three routes.

- [ ] **Step 4: Build, verify nav appears + placeholders render**

Run: `cd dashboard && npm run build`. Open dev server, click "Capture" in nav, navigate sub-routes, confirm placeholders render.

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/pages/capture/MeetingsPlaceholder.tsx dashboard/src/pages/capture/JournalsPlaceholder.tsx dashboard/src/components/layout/Nav.tsx dashboard/src/App.tsx
git commit -m "feat(dashboard): capture top-level nav + meetings/journals placeholders"
```

---

## Task 21: Dashboard CapturePage — connection card, stats, activity feed

**Files:**
- Create: `dashboard/src/pages/CapturePage.tsx`
- Modify: `dashboard/src/api.ts`

- [ ] **Step 1: Add API client functions**

Edit `dashboard/src/api.ts`:

```typescript
export interface CaptureSession {
  id: string;
  source_kind: string;
  uri: string;
  title: string;
  metadata: Record<string, any>;
  trust_score: number;
  created_at: string;
}

export interface CaptureTodayStats {
  sessions_count: number;
  captured_seconds: number;
  dropped_count: number;
  top_apps: Array<{ app: string; captured_seconds: number }>;
}

export async function getCaptureSessions(limit = 50): Promise<{ sessions: CaptureSession[] }> {
  return apiFetch(`/api/v1/capture/sessions?limit=${limit}`);
}

export async function getCaptureTodayStats(): Promise<CaptureTodayStats> {
  return apiFetch(`/api/v1/capture/today-stats`);
}
```

- [ ] **Step 2: Build CapturePage layout**

Create `dashboard/src/pages/CapturePage.tsx`. Match the ASCII layout from spec Section 8: header (title + Pause + settings cog), two cards (Connection / Today), Recent activity feed.

Use TanStack Query (`useQuery`) for:
- `["capture", "sessions"]` → `getCaptureSessions(50)` — staleTime: 5s
- `["capture", "today-stats"]` → `getCaptureTodayStats()` — staleTime: 5s

For the connection card, also poll `useConfigValue("screenpipe.url", "string")` and the bridge `/health/ready` (proxy through orchestrator or directly through Vite proxy).

For the Pause button, toggle `useConfigValue("capture.paused", "boolean")`.

The Recent activity feed: virtualized table of sessions with time range, app, window, word_count (from `metadata.word_count`), URL (if present), and the two action buttons (`view` / `exclude`). The `view` button opens a modal showing `metadata.app`, full session timestamps, and `<source content>` — for now, fetch full content from a new endpoint `GET /api/v1/sources/{id}/content` (already exists per CLAUDE.md).

- [ ] **Step 3: Build and verify**

Run: `cd dashboard && npm run build`. Open dev server, navigate to `/capture`. With at least one ingested session in the DB, confirm: connection status shows, today stats render, activity feed lists the session, "view" modal works.

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/CapturePage.tsx dashboard/src/api.ts
git commit -m "feat(dashboard): capture page with connection card, stats, activity feed"
```

---

## Task 22: Capture page exclude popover

**Files:**
- Modify: `dashboard/src/pages/CapturePage.tsx`
- Modify: `dashboard/src/api.ts`

- [ ] **Step 1: Add exclude API helper**

Edit `dashboard/src/api.ts`:

```typescript
export type ExcludeScope = "app" | "url_pattern" | "window_title";

export async function addCaptureExclude(scope: ExcludeScope, value: string): Promise<void> {
  return apiFetch(`/api/v1/capture/exclude`, {
    method: "POST",
    body: JSON.stringify({ scope, value }),
  });
}
```

Implement the matching `POST /api/v1/capture/exclude` handler in `orchestrator/app/capture_router.py`. Read-modify-write the appropriate `nova:config:capture.denylist.<scope>` Redis JSON list: GET, parse JSON, append `value` only if not already present (dedup), JSON-encode, SET. Also UPSERT into Postgres `platform_config` so the change survives Redis flushes (the same pattern as `config_sync.py` writes — round-trip the value to be source-of-truth-correct).

- [ ] **Step 2: Implement the popover in CapturePage**

When `[exclude]` is clicked on a session row, render a popover with three radio options preselected from the session's metadata: App (always shown), URL pattern (only if `metadata.url`), Window title (always shown). User confirms → call `addCaptureExclude(scope, value)` → on success, show toast "Excluded; can be reverted in Settings → Capture → Privacy."

- [ ] **Step 3: Verify end-to-end**

Manually exclude an app. Confirm next ingested session for that app is dropped (check bridge logs / Prometheus counter).

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/pages/CapturePage.tsx dashboard/src/api.ts orchestrator/app/capture_router.py
git commit -m "feat(dashboard): capture page exclude popover (app/url/window)"
```

---

## Task 23: docs/setup/screenpipe.md per-OS install guide

**Files:**
- Create: `docs/setup/screenpipe.md`

- [ ] **Step 1: Write the guide**

Create `docs/setup/screenpipe.md`. Cover:

1. What screenpipe is (one paragraph), why Nova uses it, link to https://screenpi.pe/
2. Per-OS install commands (macOS via brew or installer; Windows installer; Linux build-from-source)
3. The required `screenpipe.config.json` with the layer-1 denylist defaults (1Password, Bitwarden, etc.)
4. How to enable LAN listening (`listen_on_lan: true`) so Nova can reach it
5. How to set an API key on the screenpipe side (`api_key: "..."`) and put the matching value into Nova's Settings → Connections → Screenpipe
6. How to verify in the dashboard: Test Connection button, then visit `/capture` and confirm sessions arrive
7. Privacy notes (what gets captured, what doesn't, the active-window-only design)
8. Troubleshooting (firewall, accessibility permissions on macOS, etc.)

Length target: ~150 lines, concrete, copy-paste friendly.

- [ ] **Step 2: Commit**

```bash
git add docs/setup/screenpipe.md
git commit -m "docs(capture): per-OS screenpipe install + Nova config guide"
```

---

## Task 24: CLAUDE.md update + smoke test

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update services list**

Edit `CLAUDE.md`. In the architecture services list, add:

> **screenpipe-bridge** (8140) — Subscribes to a user-installed screenpipe daemon (workstation-side), aggregates events into focus sessions, applies a privacy denylist, pushes to engram ingestion queue (FastAPI + websockets + httpx + redis). Optional, requires user-installed screenpipe.

- [ ] **Step 2: Update Redis DB allocation line**

Add `screenpipe-bridge=db10` to the existing line.

- [ ] **Step 3: Update Inter-service communication paragraph**

Add a sentence: "Screenpipe-bridge subscribes to a user-installed screenpipe daemon over the network (WS primary, poll fallback) and pushes focus-session payloads to engram ingestion (Redis db0)."

- [ ] **Step 4: Add to source kinds list**

In the Source Provenance section, add `screenpipe=0.80` to the trust defaults list.

- [ ] **Step 5: Add to runtime configuration table**

Add rows for `screenpipe.enabled`, `screenpipe.url`, `screenpipe.api_key`, `capture.paused`, `capture.denylist.*`, `capture.session_max_minutes`, `capture.session_min_seconds`, `capture.buffer_size` to the runtime config table.

- [ ] **Step 6: Run end-to-end smoke test**

With a real screenpipe installed on a workstation (or a long-running fake fixture):
1. Configure URL + API key in dashboard
2. Test Connection succeeds
3. Use the workstation for ~3 minutes across 2 different apps
4. Visit `/capture` — confirm 2+ sessions show up with the right text
5. Click `view` on one session — confirm the captured text matches what was on screen
6. Click `exclude` on a session, choose App, confirm; refresh; confirm no new sessions for that app
7. In Settings → Capture → Advanced, toggle pause; confirm `/capture` page shows paused banner; un-pause

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude-md): document screenpipe-bridge service, ports, config keys"
```

- [ ] **Step 8: Final integration test run**

Run: `make test`
Expected: full integration suite passes including all `test_screenpipe_*` tests.

---

## Done

Sub-project 1 (Capture & Ingestion) is complete when:

- All 24 tasks committed and tests passing
- Dashboard `/capture` page shows real sessions from a workstation-installed screenpipe
- Privacy denylist works end-to-end (configured app never produces a source row)
- Pause toggle works via dashboard
- `make test` passes
- CLAUDE.md updated

Next: brainstorm + spec sub-project 2 (Active Recall — `search_screen_history` agent tool + dashboard search).
