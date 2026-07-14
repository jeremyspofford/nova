"""Nova backend — FastAPI app."""

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import db, rules, scheduler, settings_store
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
    log.info("Backend ready")
    yield
    log.info("Shutting down...")
    scheduler_task.cancel()
    try:
        await scheduler_task
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

app.include_router(chat_router)


@app.get("/health")
async def health():
    try:
        async with db.acquire() as conn:
            await conn.fetchval("SELECT 1")
        return {"status": "ok", "db": "ok"}
    except Exception as e:
        return {"status": "degraded", "db": f"error: {e}"}
