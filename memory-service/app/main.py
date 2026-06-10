# memory-service/app/main.py
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from nova_contracts import HealthStatus

from .config import settings
from .db import close_pool, get_pool
from .embed import close as close_embed
from .embed import probe_and_lock
from .router import router

logging.basicConfig(level=settings.log_level)
logger = logging.getLogger(__name__)

_worker_task: asyncio.Task | None = None


_extract_task: asyncio.Task | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    from .extraction import close as close_extraction
    from .worker import (
        close_http as close_worker_http,
    )
    from .worker import (
        embed_worker,
        extract_worker,
        recover_unembedded,
    )

    pool = await get_pool()
    await probe_and_lock(pool)

    global _worker_task, _extract_task
    _worker_task = asyncio.create_task(embed_worker())
    _extract_task = asyncio.create_task(extract_worker())

    await recover_unembedded(pool)

    logger.info("memory-service started")
    yield

    for task in (_worker_task, _extract_task):
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    await close_pool()
    await close_embed()
    await close_worker_http()
    await close_extraction()
    logger.info("memory-service stopped")


app = FastAPI(title="nova-memory-service", version="2.0.0", lifespan=lifespan)
app.include_router(router)


@app.get("/health/live")
async def health_live():
    return HealthStatus(status="ok", service="memory-service")


@app.get("/health/ready")
async def health_ready():
    from .embed import is_degraded

    pool = await get_pool()
    try:
        await pool.fetchval("SELECT 1")
        db_ok = True
    except Exception as exc:
        logger.warning("DB health check failed: %s", exc)
        db_ok = False

    status = "ok" if db_ok else "error"
    return HealthStatus(
        status=status,
        service="memory-service",
        checks={"db": db_ok, "embedding": not is_degraded()},
    )
