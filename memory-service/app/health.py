"""
Health check endpoints — liveness, readiness, startup.
Every Nova service implements all three for K8s probe compatibility.
"""

from __future__ import annotations

import logging

from app.redis_client import get_redis
from fastapi import APIRouter

log = logging.getLogger(__name__)
health_router = APIRouter(prefix="/health", tags=["health"])


@health_router.get("/live")
async def liveness():
    """K8s liveness probe — is the process alive? No dependency checks."""
    return {"status": "alive"}


@health_router.get("/ready")
async def readiness():
    """K8s readiness probe — can the service handle traffic? Checks all dependencies."""
    checks = {}

    # Check Redis
    try:
        redis = get_redis()
        await redis.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e}"

    all_ok = all(v == "ok" for v in checks.values())
    return {"status": "ready" if all_ok else "degraded", "checks": checks}


@health_router.get("/startup")
async def startup():
    """K8s startup probe — has initialization completed?"""
    return {"status": "started"}
