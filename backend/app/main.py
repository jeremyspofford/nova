"""Nova backend — FastAPI app."""

import asyncio
import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import db, model_warmer, rules, scheduler, settings_store
from app.config import settings
from app.memory.memory import memory
from app.router_chat import router as chat_router

logging.basicConfig(level=settings.get_log_level())
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("Starting Nova backend...")
    await db.init_pool()
    await db.run_migrations()
    await settings_store.warm()
    await rules.warm()
    await memory.startup()
    scheduler_task = asyncio.create_task(scheduler.loop())
    warmer_task = asyncio.create_task(model_warmer.loop())
    log.info("Backend ready")
    yield
    log.info("Shutting down...")
    for task in (scheduler_task, warmer_task):
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    await db.close_pool()


app = FastAPI(title="Nova Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """Single admin token, required the moment anything binds beyond
    localhost. Empty token = open (dev default). /health stays public for
    container healthchecks."""
    token = settings.nova_auth_token
    if token and request.url.path.startswith("/api/"):
        supplied = request.headers.get("authorization", "")
        if not hmac.compare_digest(supplied, f"Bearer {token}"):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


app.include_router(chat_router)


@app.get("/health")
async def health():
    try:
        async with db.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "db": "ok"}
    except Exception as e:
        return {"status": "degraded", "db": f"error: {e}"}
