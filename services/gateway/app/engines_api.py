"""GET/PUT /admin/engines — every engine, one engine in full, and the owner's
serving switch (S40).

Replaces GET /admin/vram (deleted in T4): the card and what an engine holds
on it now live on the engine they belong to, under `vram`, in exactly the
keys /admin/vram answered — so its three readers in core move by path alone.
Only the hub's own card is readable here; another machine's is stated
unreadable and its fit frame is omitted, never guessed (ruling C3).
Reports, never decides (owner ruling 2026-09-03): the PUT stores the owner's
switch and answers with the row read back.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict

from fastapi import APIRouter, HTTPException, Request

from app import db, devices_vram, engines
from app import fit as fit_mod

router = APIRouter(prefix="/admin", tags=["engines"])
logger = logging.getLogger("gateway")

SETTABLE = frozenset({"serving"})


def _not_found(name: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"no engine named {name!r}")


def _card(vram: devices_vram.Vram) -> dict:
    out = vram.as_dict()
    out["total_gb"] = round(vram.total_mb / 1024, 1) if vram.total_mb is not None else None
    out["free_gb"] = round(vram.free_mb / 1024, 1) if vram.free_mb is not None else None
    out["used_gb"] = round(vram.used_mb / 1024, 1) if vram.used_mb is not None else None
    return out


async def _vram(app, row: dict, view: engines.EngineView) -> tuple[dict, str | None]:
    """(the card block, fit_frame) for one engine.

    The hub: its card read now, what it holds resident, and free-after-switch
    (S2f-R2: the card's free memory plus what a switch would evict). Another
    machine: its card is NOT read (engines.NOT_THIS_CARD), its frame is None,
    and what it holds is its own /api/ps — asked only when the engine may be
    asked: a wake-on-LAN engine this request did not observe is left asleep,
    the rule `engines.observe` keeps."""
    if not row["builtin"]:
        out = _card(devices_vram.Vram(reason=engines.NOT_THIS_CARD.format(name=row["name"])))
        if view.observed_at is None:
            resident, reason = (
                None,
                f"{row['name']} was not asked what is resident: it wakes on LAN and asking "
                "could wake it",
            )
        else:
            resident, reason = await engines.resident(app, row)
        out.update(resident=resident, resident_reason=reason, free_after_switch_gb=None)
        return out, engines.fit_frame(row, None)
    vram = await devices_vram.read_vram()
    out = _card(vram)
    resident, reason = await engines.resident(app, row)
    out["resident"] = resident
    out["resident_reason"] = reason
    out["free_after_switch_gb"] = (
        round(fit_mod.free_gb_after_switch(vram.free_mb, resident), 1)
        if resident is not None and vram.free_mb is not None
        else None
    )
    # No nvidia-smi in this container = no GPU passed through: models are
    # fitted against RAM. A card that exists but cannot be read stays the
    # VRAM frame — fit is then `unknown` with the card's own reason.
    return out, engines.fit_frame(row, vram.as_dict())


@router.get("/engines")
async def list_engines(request: Request, live: bool = False) -> dict:
    pool = await db.get_pool()
    views = [
        await engines.observe(request.app, pool, row, live=live) for row in await engines.rows(pool)
    ]
    return {"engines": [asdict(view) for view in views]}


@router.get("/engines/{name}")
async def get_engine(name: str, request: Request, live: bool = False) -> dict:
    pool = await db.get_pool()
    try:
        row = await engines.get(pool, name)
    except engines.UnknownEngine:
        raise _not_found(name) from None
    view = await engines.observe(request.app, pool, row, live=live)
    vram, frame = await _vram(request.app, row, view)
    return {**asdict(view), "vram": vram, "fit_frame": frame}


@router.put("/engines/{name}")
async def put_engine(name: str, request: Request) -> dict:
    raw = await request.body()
    try:
        body = json.loads(raw) if raw else {}
    except ValueError:
        raise HTTPException(status_code=400, detail="request body is not valid JSON") from None
    if not isinstance(body, dict) or not body:
        raise HTTPException(status_code=400, detail="the body must carry serving: true or false")
    extra = sorted(set(body) - SETTABLE)
    if extra:
        raise HTTPException(
            status_code=400,
            detail=f"cannot set {', '.join(extra)} on an engine — only serving can be set",
        )
    pool = await db.get_pool()
    try:
        stored = await engines.set_serving(pool, name, body.get("serving"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except engines.UnknownEngine:
        raise _not_found(name) from None
    logger.info("engine %s serving=%s", name, stored["serving"])
    return engines.to_public(stored)
