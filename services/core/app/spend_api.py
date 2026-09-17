"""GET /api/v1/spend — the gateway's ledger rolled up, with the one fact
only core holds added: who each person id IS.

The gateway records per-person spend by id (core sends `X-Nova-Person` on
every completion); the names live in core's `people`. Everything else is
the gateway's answer, forwarded as it was. `report()` is also what her
`spend_report` tool reads, so a page and a reply never disagree.
"""

from __future__ import annotations

import uuid

import httpx
from fastapi import APIRouter, HTTPException, Request

from app import db, peers, settings_store

router = APIRouter(prefix="/api/v1", tags=["spend"])

SPEND_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)
WINDOWS = ("today", "7d", "30d", "month")
GONE = "(no longer exists)"


async def report(app, pool, window: str) -> dict:
    """The gateway's /admin/spend for `window`, people named. A gateway
    that cannot answer raises the same HTTPException the route would."""
    if window not in WINDOWS:
        raise HTTPException(status_code=400, detail=f"window must be one of {', '.join(WINDOWS)}")
    try:
        zone = str(await settings_store.read_value(pool, "nova.timezone") or "UTC")
    except Exception:  # noqa: BLE001
        zone = "UTC"
    try:
        async with peers.client(app, peers.GATEWAY, SPEND_TIMEOUT) as client:
            upstream = await client.get(
                "/admin/spend", params={"window": window}, headers={peers.HEADER_TIMEZONE: zone}
            )
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        raise HTTPException(
            status_code=502, detail=f"could not reach the gateway — {peers.reason(exc)}"
        ) from exc
    if upstream.status_code != 200:
        try:
            detail = upstream.json().get("error") or upstream.text[:200]
        except ValueError:
            detail = upstream.text[:200]
        raise HTTPException(status_code=upstream.status_code, detail=detail)
    try:
        body = upstream.json()
    except ValueError as exc:
        raise HTTPException(
            status_code=502, detail="the gateway's spend report was not JSON"
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=502, detail="the gateway's spend report was not an object")
    await _name_people(pool, body)
    return body


async def _name_people(pool, body: dict) -> None:
    rows = body.get("by_person")
    if not isinstance(rows, list):
        return
    ids = []
    for row in rows:
        key = row.get("key") if isinstance(row, dict) else None
        try:
            ids.append(uuid.UUID(str(key)))
        except (ValueError, TypeError):
            continue
    names = {}
    if ids:
        for r in await pool.fetch("SELECT id, name, role FROM people WHERE id = ANY($1)", ids):
            names[str(r["id"])] = {"name": r["name"], "role": r["role"]}
    for row in rows:
        if not isinstance(row, dict):
            continue
        key = row.get("key")
        if key is None:
            row["person"] = None  # calls with no person header
        else:
            row["person"] = names.get(str(key), {"name": GONE, "role": None})


@router.get("/spend")
async def spend(request: Request) -> dict:
    return await report(
        request.app, await db.get_pool(), request.query_params.get("window") or "month"
    )
