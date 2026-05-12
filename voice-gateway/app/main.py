import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from .config import settings
from .router import router
from nova_contracts import HealthStatus

logging.basicConfig(level=settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.getLogger(__name__).info(
        "voice-gateway started (stt=%s, tts=%s)",
        settings.stt_provider,
        settings.tts_provider,
    )
    yield
    logging.getLogger(__name__).info("voice-gateway stopped")


def create_app() -> FastAPI:
    new_app = FastAPI(title="nova-voice-gateway", version="2.0.0", lifespan=lifespan)
    new_app.include_router(router)

    @new_app.get("/health/live")
    async def health_live():
        return HealthStatus(status="ok", service="voice-gateway")

    @new_app.get("/health/ready")
    async def health_ready():
        return HealthStatus(status="ok", service="voice-gateway", checks={"router": True})

    return new_app


app = create_app()
