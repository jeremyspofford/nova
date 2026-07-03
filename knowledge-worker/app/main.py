"""Knowledge Worker -- FastAPI app with autonomous crawl scheduling."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.client import (
    close_clients,
    get_llm_client,
    get_orchestrator_client,
    init_clients,
)
from app.config import settings
from app.credentials.health import run_credential_health_loop
from app.queue import close_queues, init_queues, push_to_memory
from app.scheduler import run_scheduling_loop

logging.basicConfig(level=settings.log_level)
log = logging.getLogger(__name__)

_scheduler_task: asyncio.Task | None = None
_health_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    # FC-002: refuse to start with the literal default or empty admin secret.
    import os
    if settings.admin_secret in ("", "nova-admin-secret-change-me"):
        if os.getenv("NOVA_ALLOW_DEFAULT_ADMIN_SECRET") != "1":
            raise RuntimeError(
                "NOVA_ADMIN_SECRET is unset or set to the literal default. "
                "Run scripts/install.sh to generate a strong secret, "
                "or set NOVA_ALLOW_DEFAULT_ADMIN_SECRET=1 to bypass (dev/test only)."
            )
        log.warning(
            "NOVA_ADMIN_SECRET bypass active — do not use this configuration in production."
        )

    global _scheduler_task, _health_task
    await init_clients()
    await init_queues()

    # Start the crawl scheduling loop as a background task
    _scheduler_task = asyncio.create_task(run_scheduling_loop(
        config=settings,
        get_orch_client=get_orchestrator_client,
        get_llm_client=get_llm_client,
        push_to_memory=push_to_memory,
    ))

    # Start the credential health check loop as a background task
    _health_task = asyncio.create_task(run_credential_health_loop(
        config=settings,
        get_orch_client=get_orchestrator_client,
    ))

    # Feature-flags SDK wiring (B7f).
    from pathlib import Path as _Path

    import httpx as _httpx
    from nova_contracts.feature_flags import init_cache_file
    from nova_contracts.feature_flags_http import warm_cache_from_http
    from nova_contracts.feature_flags_pubsub import PubsubSubscriber

    init_cache_file(_Path("/app/data/flag-cache/knowledge-worker.json"))
    _flag_http_client = _httpx.AsyncClient(timeout=5.0)
    _flag_orch_url = settings.orchestrator_url.rstrip("/")
    try:
        await warm_cache_from_http(_flag_http_client, _flag_orch_url)
    except Exception:
        log.warning("Feature-flags warm at startup hit an unexpected error",
                    exc_info=True)
    _flag_subscriber = PubsubSubscriber(
        redis_url=settings.redis_url,
        http_client=_flag_http_client,
        base_url=_flag_orch_url,
    )
    await _flag_subscriber.start()
    log.info("Feature-flags pubsub subscriber started")

    log.info("Knowledge worker started (scheduler and credential health check running)")

    yield

    # Feature-flags shutdown (B7f)
    try:
        await _flag_subscriber.stop()
    except Exception:
        log.warning("Feature-flags subscriber stop failed", exc_info=True)
    try:
        await _flag_http_client.aclose()
    except Exception:
        log.warning("Feature-flags HTTP client aclose failed", exc_info=True)

    # Shutdown: cancel background tasks, close connections
    for task in (_scheduler_task, _health_task):
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
    await close_queues()
    await close_clients()


app = FastAPI(title="Nova Knowledge Worker", lifespan=lifespan)


@app.get("/health/live")
async def health_live():
    return {"status": "alive"}


@app.get("/health/ready")
async def health_ready():
    try:
        client = get_orchestrator_client()
        resp = await client.get("/health/live", timeout=5)
        if resp.status_code != 200:
            return JSONResponse(
                status_code=503,
                content={"status": "not_ready", "reason": "orchestrator_unreachable"},
            )
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"status": "not_ready", "reason": "orchestrator_unreachable"},
        )
    return {"status": "ready"}
