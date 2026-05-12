# recovery/app/main.py
import asyncpg
from contextlib import asynccontextmanager
from fastapi import FastAPI
from nova_contracts import HealthStatus
from .config import settings
from .db import close_pool, get_pool


@asynccontextmanager
async def lifespan(app: FastAPI):
    await get_pool()
    yield
    await close_pool()


app = FastAPI(title="recovery", version="2.0.0", lifespan=lifespan)


@app.get("/health/live")
async def live():
    return {"status": "ok"}


@app.get("/health/ready")
async def ready():
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await conn.fetchval("SELECT 1")
        db_ok = True
    except Exception:
        db_ok = False
    return HealthStatus(status="ok" if db_ok else "error", service="recovery", checks={"db": db_ok})
