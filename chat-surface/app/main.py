import logging
from contextlib import asynccontextmanager

import httpx
import redis.asyncio as aioredis
from fastapi import FastAPI

from nova_contracts import HealthStatus
from .config import settings


def create_app() -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        logging.basicConfig(level=settings.log_level)
        app.state.redis = await aioredis.from_url(settings.redis_url, decode_responses=False)
        app.state.http_agent = httpx.AsyncClient(base_url=settings.agent_core_url, timeout=120.0)
        app.state.http_voice = httpx.AsyncClient(base_url=settings.voice_gateway_url, timeout=60.0)
        from .ws.manager import SessionManager
        app.state.sessions = SessionManager()
        logging.getLogger(__name__).info("chat-surface started")
        yield
        await app.state.redis.aclose()
        await app.state.http_agent.aclose()
        await app.state.http_voice.aclose()
        logging.getLogger(__name__).info("chat-surface stopped")

    new_app = FastAPI(title="chat-surface", version="2.0.0", lifespan=lifespan)

    from .ws.router import router as ws_router
    new_app.include_router(ws_router)

    @new_app.get("/health/live")
    async def live():
        return {"status": "ok"}

    @new_app.get("/health/ready")
    async def ready():
        return HealthStatus(status="ok", service="chat-surface")

    return new_app


app = create_app()
