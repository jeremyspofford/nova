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

from app import db, identity, machines, model_speed, peers, settings_store
from app.identity import Person

router = APIRouter(prefix="/api/v1/system", tags=["system"])

#: The gateway is the only thing that reads this host's /proc; the card is the
#: gateway's reading of each machine (app/machines.py, S40 — /admin/vram is gone).
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


def _card_words(body: dict) -> dict:
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


async def _card(app) -> dict:
    """The card of THE machine whose card can be read, named — or a reason.
    Two readable cards are not guessed between (the panel shows one)."""
    try:
        pairs = await machines.cards(app)
    except machines.PlantUnavailable as exc:
        return {"reason": f"the gateway could not be asked — {exc}"}
    read = [(view, detail) for view, detail in pairs if detail is not None]
    if len(read) != 1:
        return {
            "reason": "the gateway lists no machine whose card could be read"
            if not read
            else f"{len(read)} machines report a card; the panel shows one only when there is one"
        }
    view, detail = read[0]
    body = detail.get("vram") if isinstance(detail.get("vram"), dict) else {}
    return {"machine": view["name"], **_card_words(body)}


@router.get("/resources")
async def resources(request: Request, person: Person = Depends(identity.require_person)) -> dict:
    """The card, the machine, and how fast the chat model is generating."""
    pool = await db.get_pool()

    card = await _card(request.app)
    machine, machine_error = await _from_gateway(request.app, MACHINE_PATH)

    model = await settings_store.read_value(pool, "chat.model")
    speed = None
    if model:
        # Where its rounds last ran decides whose normal it is (S40, D10).
        serving = await model_speed.latest_serving(pool, model)
        if serving is not None:
            speed = (await model_speed.speed_of(pool, *serving.key)).as_dict()

    return {
        "card": card,
        "machine": machine if machine is not None else {"reason": machine_error},
        # None when this model has no placed history here yet — never a
        # zero, which would read as a dead card. `model_speed` refuses a
        # token count too small to be a measurement, and a round the gateway
        # could not place is not counted at all.
        "throughput": speed,
        "model": model or None,
    }
