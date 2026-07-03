"""Nova Screenpipe Bridge — ingests Screenpipe capture events into Nova memory."""
from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable
from contextlib import asynccontextmanager
from datetime import datetime, timezone

import httpx
import redis.asyncio as aioredis
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.denylist import Denylist
from app.ingestion_producer import IngestionProducer
from app.metrics import (
    sessions_dropped_total,
    sessions_ingested_total,
)
from app.runtime_config import RuntimeConfig
from app.screenpipe_client import ScreenpipeClient
from app.session_aggregator import FocusSession, SessionAggregator

try:
    from nova_contracts.logging import configure_logging
    configure_logging("screenpipe-bridge", settings.log_level)
except ImportError:
    logging.basicConfig(level=getattr(logging, settings.log_level.upper(), logging.INFO))

log = logging.getLogger(__name__)
logger = log  # alias used by BridgePipeline internals

_redis: aioredis.Redis | None = None
_runtime_cfg: "RuntimeConfig | None" = None
_bridge_pipeline: "BridgePipeline | None" = None


def get_redis() -> aioredis.Redis:
    global _redis
    if _redis is None:
        kwargs: dict = {"decode_responses": True}
        if settings.redis_password:
            kwargs["password"] = settings.redis_password
        _redis = aioredis.from_url(settings.redis_url, **kwargs)
    return _redis


async def close_redis() -> None:
    global _redis
    if _redis is not None:
        await _redis.aclose()
        _redis = None


class BridgePipeline:
    """Wires denylist → backpressure queue → ingestion producer.

    Constructable directly (no FastAPI dependency) so tests can drive
    ``_handle_finalized`` and assert ``dropped_count`` without HTTP.

    Args:
        redis_db0: Redis connection for ingestion queue writes + dropped counters.
        redis_db10: Redis connection for bridge state (reserved for future use).
        denylist_apps: App names to suppress.
        denylist_url_patterns: URL regex patterns to suppress.
        denylist_window_titles: Window title substrings to suppress.
        buffer_size: Bounded asyncio.Queue capacity. When full, newest sessions
            are dropped and counted under ``"buffer_full"``.
        device_id: Screenpipe device identifier embedded in capture source URIs.
        trust: Source trust score (0–1) written into each ingestion payload.
        paused_check: Zero-arg callable returning True when capture is paused;
            sessions received while paused are dropped and counted as ``"paused"``.
        producer_blocked: **Test-only flag.** When True, the consumer dequeues
            sessions but blocks forever rather than pushing to Redis. This lets
            tests verify drop behaviour without needing a real queue consumer.
            Never set this True in production.
        queue_key: Redis list key for memory ingestion. Override in tests to
            avoid interfering with a live consumer.
    """

    def __init__(
        self,
        redis_db0: aioredis.Redis,
        redis_db10: aioredis.Redis,
        denylist_apps: list[str],
        denylist_url_patterns: list[str],
        denylist_window_titles: list[str],
        buffer_size: int = 10,
        device_id: str = "primary",
        trust: float = 0.80,
        paused_check: Callable[[], bool] = lambda: False,
        producer_blocked: bool = False,
        queue_key: str = "memory:ingestion:queue",
    ):
        self._redis_db0 = redis_db0
        self._denylist = Denylist(
            apps=denylist_apps,
            url_patterns=denylist_url_patterns,
            window_titles=denylist_window_titles,
        )
        self._producer = IngestionProducer(
            redis=redis_db0,
            device_id=device_id,
            trust=trust,
            queue_key=queue_key,
        )
        self._queue: asyncio.Queue[FocusSession] = asyncio.Queue(maxsize=buffer_size)
        self._aggregator = SessionAggregator(on_session=self._handle_finalized)
        self._dropped: dict[str, int] = {}
        self._paused_check = paused_check
        self._producer_blocked = producer_blocked
        self._consumer_task: asyncio.Task | None = None
        self._stopped = False
        self._screenpipe_client: ScreenpipeClient | None = None

    async def start_consumer(self) -> None:
        """Spawn the background consumer coroutine."""
        self._consumer_task = asyncio.create_task(self._consume_loop())

    async def process_event(self, event: dict) -> None:
        """Entry point for raw Screenpipe events — passes through the aggregator."""
        await self._aggregator.process(event)

    async def _handle_finalized(self, session: FocusSession) -> None:
        """Called by SessionAggregator when a focus session is complete."""
        if self._paused_check():
            await self._increment_dropped("paused")
            return

        match_reason = self._denylist.matches_with_reason(
            {"app": session.app, "window": session.window, "url": session.url}
        )
        if match_reason:
            await self._increment_dropped(match_reason)
            return

        try:
            self._queue.put_nowait(session)
        except asyncio.QueueFull:
            await self._increment_dropped("buffer_full")
            logger.warning(
                "dropping session for %s/%s — buffer full",
                session.app, session.window,
            )

    async def _consume_loop(self) -> None:
        """Drain the queue and push each session to the memory ingestion queue."""
        if self._producer_blocked:
            # Test hook: block indefinitely without ever dequeuing so the full
            # buffer capacity is available for drop assertions.
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                return
            return

        while not self._stopped:
            try:
                session = await self._queue.get()
            except asyncio.CancelledError:
                break

            try:
                await self._producer.push(session)
                sessions_ingested_total.labels(app=session.app).inc()
            except Exception as exc:
                logger.error("ingestion push failed: %s", exc)

    async def _increment_dropped(self, reason: str) -> None:
        """Increment the in-memory dropped counter, persist to Redis, and record metric."""
        self._dropped[reason] = self._dropped.get(reason, 0) + 1
        sessions_dropped_total.labels(reason=reason).inc()
        try:
            today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
            await self._redis_db0.hincrby(f"nova:capture:dropped:{today}", reason, 1)
        except Exception as exc:
            logger.warning("failed to write dropped counter to redis: %s", exc)

    def dropped_count(self, reason: str) -> int:
        """Return in-memory drop count for *reason* (suitable for assertions)."""
        return self._dropped.get(reason, 0)

    async def stop(self) -> None:
        """Cancel the consumer task and flush the aggregator."""
        self._stopped = True
        if self._consumer_task:
            self._consumer_task.cancel()
            try:
                await self._consumer_task
            except asyncio.CancelledError:
                pass
        try:
            await self._aggregator.flush()
        except Exception as exc:
            logger.warning("aggregator flush on stop raised: %s", exc)


# ---------------------------------------------------------------------------
# FastAPI lifespan — wires everything together for production
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    import os

    if settings.nova_admin_secret in ("", "nova-admin-secret-change-me"):
        if os.getenv("NOVA_ALLOW_DEFAULT_ADMIN_SECRET") != "1":
            raise RuntimeError(
                "NOVA_ADMIN_SECRET is unset or set to the literal default. "
                "Run scripts/install.sh to generate a strong secret, "
                "or set NOVA_ALLOW_DEFAULT_ADMIN_SECRET=1 to bypass (dev/test only)."
            )
        log.warning(
            "NOVA_ADMIN_SECRET bypass active — do not use this configuration in production."
        )

    log.info("Screenpipe bridge starting on http://0.0.0.0:%d", settings.service_port)

    # --- Redis connections ---
    redis_kwargs: dict = {"decode_responses": True}
    if settings.redis_password:
        redis_kwargs["password"] = settings.redis_password

    redis_db0 = aioredis.from_url(
        settings.redis_url.rsplit("/", 1)[0] + "/0", **redis_kwargs
    )
    redis_db1 = aioredis.from_url(
        settings.redis_url.rsplit("/", 1)[0] + "/1", **redis_kwargs
    )
    redis_db10 = aioredis.from_url(settings.redis_url, **redis_kwargs)

    # --- Runtime config (polls Redis db1 every 30s) ---
    global _runtime_cfg
    runtime_cfg = RuntimeConfig(redis=redis_db1, poll_interval_seconds=30)
    await runtime_cfg.start()
    _runtime_cfg = runtime_cfg

    # Read initial denylist + capture config
    denylist_apps = await runtime_cfg.get_list("screenpipe.denylist_apps")
    denylist_urls = await runtime_cfg.get_list("screenpipe.denylist_url_patterns")
    denylist_windows = await runtime_cfg.get_list("screenpipe.denylist_window_titles")
    buffer_size = await runtime_cfg.get_int("capture.buffer_size", 10)
    device_id = await runtime_cfg.get_str("screenpipe.device_id", "primary")
    trust = float(await runtime_cfg.get_str("screenpipe.trust", "0.80"))

    # --- Pipeline ---
    global _bridge_pipeline
    pipeline = BridgePipeline(
        redis_db0=redis_db0,
        redis_db10=redis_db10,
        denylist_apps=denylist_apps,
        denylist_url_patterns=denylist_urls,
        denylist_window_titles=denylist_windows,
        buffer_size=buffer_size,
        device_id=device_id,
        trust=trust,
        paused_check=lambda: runtime_cfg.get_bool_sync("capture.paused", False),
    )
    await pipeline.start_consumer()
    _bridge_pipeline = pipeline

    # --- ScreenpipeClient (may be absent if no URL configured) ---
    screenpipe_url = await runtime_cfg.get_str("screenpipe.url", "")
    screenpipe_api_key = await runtime_cfg.get_str("screenpipe.api_key", "")

    client: ScreenpipeClient | None = None
    if screenpipe_url:
        client = ScreenpipeClient(
            url=screenpipe_url,
            api_key=screenpipe_api_key or None,
            on_event=pipeline.process_event,
        )
        await client.start()
        pipeline._screenpipe_client = client
        log.info("screenpipe client started → %s", screenpipe_url)
    else:
        log.info("screenpipe.url not configured; client not started")

    # --- Credential-refresh background task ---
    # Every 30s: if URL or api_key changed in Redis, tear down the current
    # client and construct a new one with the updated credentials.
    async def _credential_refresh_loop() -> None:
        nonlocal client, screenpipe_url, screenpipe_api_key
        while True:
            await asyncio.sleep(30)
            try:
                new_url = await runtime_cfg.get_str("screenpipe.url", "")
                new_key = await runtime_cfg.get_str("screenpipe.api_key", "")
                if new_url == screenpipe_url and new_key == screenpipe_api_key:
                    continue

                log.info(
                    "screenpipe credentials changed (url=%s → %s); reconnecting",
                    screenpipe_url, new_url,
                )
                # Tear down old client
                if client is not None:
                    await client.stop()
                    client = None
                pipeline._screenpipe_client = None

                screenpipe_url = new_url
                screenpipe_api_key = new_key

                if screenpipe_url:
                    client = ScreenpipeClient(
                        url=screenpipe_url,
                        api_key=screenpipe_api_key or None,
                        on_event=pipeline.process_event,
                    )
                    await client.start()
                    pipeline._screenpipe_client = client
                    log.info("screenpipe client reconnected → %s", screenpipe_url)
                else:
                    log.info("screenpipe.url cleared; client stopped")
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("credential refresh loop error: %s", exc)

    refresh_task = asyncio.create_task(_credential_refresh_loop())

    try:
        yield
    finally:
        log.info("Screenpipe bridge shutting down")
        refresh_task.cancel()
        try:
            await refresh_task
        except asyncio.CancelledError:
            pass

        if client is not None:
            await client.stop()

        await pipeline.stop()
        _bridge_pipeline = None
        await runtime_cfg.stop()
        _runtime_cfg = None

        await redis_db0.aclose()
        await redis_db1.aclose()
        await redis_db10.aclose()
        await close_redis()


app = FastAPI(
    title="Nova Screenpipe Bridge",
    version="0.1.0",
    description="Screenpipe capture ingestion bridge",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in settings.cors_allowed_origins.split(",") if o.strip()],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def require_admin_secret(x_admin_secret: str | None = Header(None)) -> None:
    if x_admin_secret != settings.nova_admin_secret:
        raise HTTPException(status_code=401, detail="invalid admin secret")


@app.get("/health/live")
async def health_live():
    return {"status": "alive"}


@app.get("/health/ready")
async def health_ready():
    paused = False
    if _runtime_cfg is not None:
        paused = await _runtime_cfg.get_bool("capture.paused", False)
    if paused:
        return {"status": "ready", "paused": True}

    # Check Redis
    redis_ok = False
    try:
        r = get_redis()
        await r.ping()
        redis_ok = True
    except Exception:
        pass

    # Check screenpipe (connected via WS or actively polling)
    screenpipe_ok = False
    if _bridge_pipeline is not None and _bridge_pipeline._screenpipe_client is not None:
        client = _bridge_pipeline._screenpipe_client
        screenpipe_ok = client._connected.is_set() or client._polling_mode
    elif _runtime_cfg is not None:
        # If no URL configured, there's nothing to connect to — not a fault
        url = await _runtime_cfg.get_str("screenpipe.url", "")
        if not url:
            screenpipe_ok = True
    else:
        # No runtime config yet — treat screenpipe as OK to avoid false alarms at startup
        screenpipe_ok = True

    if not redis_ok or not screenpipe_ok:
        reasons = []
        if not redis_ok:
            reasons.append("redis unreachable")
        if not screenpipe_ok:
            reasons.append("screenpipe disconnected")
        return JSONResponse(
            {"status": "down", "reason": ", ".join(reasons), "redis": redis_ok, "paused": paused},
            status_code=503,
        )
    return {"status": "ready", "redis": True, "paused": paused}


@app.get("/test-connection", dependencies=[Depends(require_admin_secret)])
async def test_connection():
    if _runtime_cfg is None:
        return {"ok": False, "error": "runtime config not initialized"}
    url = await _runtime_cfg.get_str("screenpipe.url", "")
    if not url:
        return {"ok": False, "error": "screenpipe.url not configured"}
    api_key = await _runtime_cfg.get_str("screenpipe.api_key", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{url}/search", params={"limit": "1"}, headers=headers)
            r.raise_for_status()
            data = r.json().get("data", [])
        return {"ok": True, "message": "connected", "sample_event_count": len(data)}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}
