"""Memories proxy — /api/v1/memories/* → memory-service.

The dashboard can only reach agent-core (nginx proxies /api/ alone), so
memory endpoints must pass through here. memory-service itself stays
unauthenticated inside the compose network; admin auth is enforced at this
boundary, same as every other agent-core router.
"""
import logging

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, status

from .config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/memories", tags=["memories"])

_TIMEOUT = 30.0


def _require_admin(x_admin_secret: str | None = Header(default=None)) -> None:
    if not x_admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing admin secret")
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid admin secret")


async def _forward(method: str, path: str, json_body: dict | None = None, params: dict | None = None):
    url = f"{settings.memory_service_url}{path}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.request(method, url, json=json_body, params=params)
    except Exception as exc:
        logger.warning("memories proxy %s %s failed: %s", method, path, exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="memory-service unreachable")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    if r.status_code == 204 or not r.content:
        return {}
    return r.json()


@router.get("/stats")
async def stats(_: None = Depends(_require_admin)):
    return await _forward("GET", "/memories/stats")


@router.get("/profile")
async def profile(limit: int = 12, _: None = Depends(_require_admin)):
    return await _forward("GET", "/memories/profile", params={"limit": limit})


@router.post("/search")
async def search(body: dict, _: None = Depends(_require_admin)):
    return await _forward("POST", "/memories/search", json_body=body)


@router.get("/{memory_id}")
async def get_memory(memory_id: str, _: None = Depends(_require_admin)):
    return await _forward("GET", f"/memories/{memory_id}")


@router.delete("/{memory_id}")
async def delete_memory(memory_id: str, _: None = Depends(_require_admin)):
    return await _forward("DELETE", f"/memories/{memory_id}")
