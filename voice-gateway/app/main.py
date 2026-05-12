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


app = FastAPI(title="nova-voice-gateway", version="2.0.0", lifespan=lifespan)
app.include_router(router)


@app.get("/health/live")
async def health_live():
    return HealthStatus(status="ok", service="voice-gateway")


@app.get("/health/ready")
async def health_ready():
    return HealthStatus(status="ok", service="voice-gateway", checks={"router": True})
