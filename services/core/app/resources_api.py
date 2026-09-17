"""GET /api/v1/system/resources — everything the context panel shows.

ONE read, because the panel opens on a click and three round trips from a
browser is three chances to render half a picture. Composed in core rather
than in the client for the same reason `_conversation_state` is: a second
place that assembles this shape is a second place for it to drift.

## Every half degrades on its own
The card, the machine and the throughput come from different sources and
fail for different reasons — the gateway unreachable, /proc unreadable, a
model with no measured history. Each carries its own `reason` and a null
figure rather than a zero. A panel that shows two facts and one stated
blank is more useful than a panel that shows an error, and far more honest
than one that shows a zero it did not measure.

## What is NOT here, deliberately
**Network throughput.** Nobody measures it. A number nobody measured looks
exactly as confident as one somebody did, which is how a dashboard starts
lying. Latency to the peers IS measured by the probes, and that is a
different claim made where it is true.
"""

from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, Request

from app import db, identity, model_speed, peers, settings_store
from app.identity import Person

router = APIRouter(prefix="/api/v1/system", tags=["system"])

#: The gateway is the only thing that can run nvidia-smi or read this host's
#: /proc, so both halves come from there.
VRAM_PATH = "/admin/vram"
MACHINE_PATH = "/admin/machine"

#: Short: a panel opening on a click must not hang on a busy peer. A slow
#: read costs its own section, which says so.
TIMEOUT = httpx.Timeout(connect=3.0, read=8.0, write=3.0, pool=3.0)


async def _from_gateway(app, path: str) -> tuple[dict | None, str | None]:
    try:
        async with peers.client(app, peers.GATEWAY, TIMEOUT) as client:
            resp = await client.get(path)
            resp.raise_for_status()
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        return None, f"the gateway could not be asked — {peers.reason(exc)}"
    return resp.json(), None


def _card(body: dict) -> dict:
    """The card, in the panel's own words.

    `others_gb` is the actionable half and the reason this is not just
    "free VRAM": the card's used figure minus what ollama holds is
    everything on this machine Nova cannot enumerate. On 2026-09-12 that
    was a video game, and on 2026-09-16 it was 99% of the shader cores with
    16 GB still free — which is why utilisation travels with it. Free
    memory and utilisation fail in opposite directions.
    """
    free = body.get("free_gb")
    used_mb, resident = body.get("used_mb"), body.get("resident") or []
    held_mb = sum(entry.get("vram_mb") or 0 for entry in resident)
    others = (used_mb - held_mb) / 1024 if used_mb is not None else None
    return {
        "free_gb": free,
        "total_gb": body.get("total_gb"),
        "used_gb": body.get("used_gb"),
        "utilisation_pct": body.get("util_pct"),
        "non_ollama_gb": round(others, 1) if others is not None else None,
        "resident": [
            {"model": entry.get("model"), "vram_gb": round((entry.get("vram_mb") or 0) / 1024, 1)}
            for entry in resident
        ],
        "reason": body.get("reason") or body.get("resident_reason"),
    }


@router.get("/resources")
async def resources(request: Request, person: Person = Depends(identity.require_person)) -> dict:
    """The card, the machine, and how fast the chat model is generating."""
    pool = await db.get_pool()

    vram, vram_error = await _from_gateway(request.app, VRAM_PATH)
    machine, machine_error = await _from_gateway(request.app, MACHINE_PATH)

    model = await settings_store.read_value(pool, "chat.model")
    speed = None
    if model:
        speeds = await model_speed.speeds(pool, model=model)
        found = speeds.get(model)
        speed = found.as_dict() if found is not None else None

    return {
        "card": _card(vram) if vram is not None else {"reason": vram_error},
        "machine": machine if machine is not None else {"reason": machine_error},
        # None when this model has no measured history here yet — never a
        # zero, which would read as a dead card. `model_speed` refuses a
        # token count too small to be a measurement, so a quiet day simply
        # has nothing to say.
        "throughput": speed,
        "model": model or None,
    }
