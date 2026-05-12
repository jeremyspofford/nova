# agent-core/app/secrets/router.py
import re
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, field_validator

from ..config import settings
from ..db import get_pool
from . import store

router = APIRouter(prefix="/api/v1/secrets", tags=["secrets"])


def _require_admin(x_admin_secret: str = Header(...)):
    if x_admin_secret != settings.admin_secret:
        raise HTTPException(status_code=403, detail="Forbidden")


class SecretCreate(BaseModel):
    name: str
    value: str
    purpose: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not re.fullmatch(r"[a-z][a-z0-9_]*", v):
            raise ValueError("name must be lowercase letters/digits/underscore, start with a letter")
        return v


class SecretUpdate(BaseModel):
    value: Optional[str] = None
    purpose: Optional[str] = None


class SecretResolveRequest(BaseModel):
    name: str


@router.get("")
async def list_secrets(_: None = Depends(_require_admin)):
    pool = await get_pool()
    return await store.list_secrets(pool)


@router.post("", status_code=201)
async def create_secret(body: SecretCreate, _: None = Depends(_require_admin)):
    pool = await get_pool()
    await store.set_secret(pool, body.name, body.value, body.purpose, settings.credential_master_key)
    return {"name": body.name, "created": True}


@router.patch("/{name}")
async def update_secret(name: str, body: SecretUpdate, _: None = Depends(_require_admin)):
    if body.value is None and body.purpose is None:
        raise HTTPException(status_code=422, detail="At least one of 'value' or 'purpose' must be provided")
    pool = await get_pool()
    if body.value is not None:
        if not await store.secret_exists(pool, name):
            raise HTTPException(status_code=404, detail="Secret not found")
        await store.set_secret(pool, name, body.value, body.purpose, settings.credential_master_key)
    elif body.purpose is not None:
        updated = await store.update_purpose(pool, name, body.purpose)
        if not updated:
            raise HTTPException(status_code=404, detail="Secret not found")
    return {"name": name, "updated": True}


@router.delete("/{name}", status_code=204)
async def delete_secret(name: str, _: None = Depends(_require_admin)):
    pool = await get_pool()
    deleted = await store.delete_secret(pool, name)
    if not deleted:
        raise HTTPException(status_code=404, detail="Secret not found")


@router.post("/resolve")
async def resolve_secret(body: SecretResolveRequest, _: None = Depends(_require_admin)):
    pool = await get_pool()
    value = await store.get_secret(pool, body.name, settings.credential_master_key)
    if value is None:
        raise HTTPException(status_code=404, detail=f"Secret '{body.name}' not found")
    return {"name": body.name, "value": value}
