"""SEC-006a — platform secrets HTTP layer.

Admin-gated endpoints for reading/writing platform_secrets. The /resolve
endpoint returns plaintext and is the path the gateway/bridge/etc. call when
they need to use a secret. List + patch + delete drive the dashboard UI.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.auth import AdminDep
from app.db import get_pool
from app.secrets_store import (
    delete_secret,
    get_secret,
    list_secrets,
    set_secret,
)

logger = logging.getLogger(__name__)

router = APIRouter()


class SecretsPatchRequest(BaseModel):
    updates: dict[str, str]


class SecretsResolveRequest(BaseModel):
    keys: list[str]


@router.get("/api/v1/admin/secrets")
async def list_admin_secrets(_admin: AdminDep) -> dict:
    """List configured platform secret keys (no values)."""
    keys = await list_secrets(get_pool())
    return {"keys": keys}


@router.patch("/api/v1/admin/secrets")
async def patch_admin_secrets(req: SecretsPatchRequest, _admin: AdminDep) -> dict:
    """Encrypt and upsert one or more platform secrets."""
    if not req.updates:
        raise HTTPException(status_code=400, detail="updates may not be empty")
    pool = get_pool()
    for k, v in req.updates.items():
        await set_secret(pool, k, v)
    return {"updated": sorted(req.updates.keys())}


@router.post("/api/v1/admin/secrets/resolve")
async def resolve_admin_secrets(req: SecretsResolveRequest, _admin: AdminDep) -> dict:
    """Decrypt and return plaintext for the requested keys.

    Missing keys are simply absent from the response (no 404 — callers can
    distinguish "not configured" from "wrong key" by inspection).
    """
    pool = get_pool()
    values: dict[str, str] = {}
    for k in req.keys:
        v = await get_secret(pool, k)
        if v is not None:
            values[k] = v
    return {"values": values}


@router.delete("/api/v1/admin/secrets/{key}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_admin_secret(key: str, _admin: AdminDep) -> None:
    """Delete a platform secret. 204 on success, 404 if not present."""
    removed = await delete_secret(get_pool(), key)
    if not removed:
        raise HTTPException(status_code=404, detail=f"secret {key!r} not found")
