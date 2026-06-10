import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from nova_contracts import HealthStatus

from .config import settings
from .router import router

logging.basicConfig(level=settings.log_level)
# Suppress httpx request logging — it includes full URLs with embedded API keys
# (e.g. Gemini passes the key as ?key= query parameter).
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.getLogger(__name__).info("llm-gateway started (strategy=%s)", settings.routing_strategy)
    yield
    logging.getLogger(__name__).info("llm-gateway stopped")


app = FastAPI(title="nova-llm-gateway", version="2.0.0", lifespan=lifespan)
app.include_router(router)


@app.get("/health/live")
async def health_live():
    return HealthStatus(status="ok", service="llm-gateway")


@app.get("/health/ready")
async def health_ready():
    return HealthStatus(status="ok", service="llm-gateway", checks={"router": True})
