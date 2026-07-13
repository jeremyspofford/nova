"""Backend pool CRUD — /v1/backends (Phase 1, models/inference unified plan).

The dashboard Models page manages the pool here: list entries with live
status, add/update user-named remotes, enable/disable, remove. Container
entries are upserted by the recovery service when bundled backends
start/stop; they can be disabled/removed here too (removal does not stop
the container — that stays with recovery's start/stop controls).

Mounted in main.py with the shared admin-auth dependency.
"""
from __future__ import annotations

import logging

from app.pool import VALID_ENGINES, VALID_KINDS, BackendEntry, pool
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)

backends_router = APIRouter(prefix="/backends", tags=["backends"])


class BackendUpsert(BaseModel):
    kind: str = "remote"
    engine: str
    url: str
    enabled: bool = True
    auth_header: str = ""


@backends_router.get("")
async def list_backends() -> list[dict]:
    """Pool entries with live status, in configured (priority) order."""
    from app.registry import get_local_provider

    # Refresh catalogs/health so status reflects reality, not the last request.
    await get_local_provider().refresh_config()
    await pool.refresh(force=True)

    out = []
    primary = pool.primary()
    for rt in pool.runtimes():
        out.append({
            **rt.entry.to_dict(),
            "available": rt.available,
            "model_count": len(rt.models),
            "models": sorted(rt.models),
            "is_primary": primary is not None and rt.entry.id == primary.entry.id,
        })
    return out


@backends_router.put("/{backend_id}")
async def upsert_backend(backend_id: str, req: BackendUpsert) -> dict:
    """Add or update a pool entry. The path id is authoritative."""
    if req.kind not in VALID_KINDS:
        raise HTTPException(422, f"kind must be one of {sorted(VALID_KINDS)}")
    if req.engine not in VALID_ENGINES:
        raise HTTPException(422, f"engine must be one of {sorted(VALID_ENGINES)}")
    try:
        entry = BackendEntry(
            id=backend_id.strip(),
            kind=req.kind,
            engine=req.engine,
            url=req.url.rstrip("/"),
            enabled=req.enabled,
            auth_header=req.auth_header,
        )
        entry.validate()
        await pool.upsert(entry)
    except ValueError as e:
        raise HTTPException(422, str(e))
    log.info("Backend '%s' upserted (%s %s, enabled=%s)",
             entry.id, entry.kind, entry.engine, entry.enabled)
    rt = pool.get(entry.id)
    return {**entry.to_dict(), "available": rt.available if rt else False}


@backends_router.delete("/{backend_id}", status_code=204)
async def delete_backend(backend_id: str) -> None:
    """Remove a pool entry (does not stop a running container)."""
    if not await pool.remove(backend_id):
        raise HTTPException(404, f"No backend named '{backend_id}'")
    log.info("Backend '%s' removed from pool", backend_id)
