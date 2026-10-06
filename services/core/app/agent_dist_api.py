"""/api/v1/agent — the hub's build of Nova's agent, public (S42b P19).

A machine that is not paired yet has no cookie, no bearer and no key: the
one-liner on the card downloads from here before anything else exists. The
binaries are public anyway (the repo is), so the paths are exact entries in
identity.PUBLIC_PATHS, and the only guard they need is a rate limit.

The limit is per client, as far as core can tell one — network.bucket_of,
the key enroll's failure limit counts by too. Behind nginx that is the door a
request came through, from the X-Real-IP nginx writes (its own $remote_addr,
set over whatever the caller sent), believed only from web's fixed address
(network.client_of, the rule door_of keeps): the hub's loopback port arrives
from the subnet gateway, the tailnet from the sidecar. A visitor who came
through a public relay — the owner's cloudflared tunnel, which shares the
loopback door, or Tailscale Funnel — is counted apart from its door's own
clients (S42b Task 26). So a stranger on the tunnel never spends ./install's
minute, one door spending its minute never locks another out, and a header
the caller wrote (X-Forwarded-For, or an X-Real-IP or relay mark sent
straight to core) neither buys a fresh budget nor spends another client's.

A download streams from the open file agent_dist checked (agent_dist.stream):
a response that completes is the manifest's bytes.

The manifest also carries the card's one command per OS (S42b P18), with a
{CODE} slot that /add and Settings fill in on the page — so it never carries
a code — plus where each OS has been walked and each OS's note. The build is
read ONCE and that very Build is both described and signed.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections import deque

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from app import agent_card, agent_dist, db, network, platform_walks

router = APIRouter(prefix="/api/v1/agent", tags=["agent"])

RATE_PER_MINUTE = 30
WINDOW_SECONDS = 60.0
_clock = time.monotonic
# client -> the times of its requests inside the window. A client whose
# window empties is dropped, so what is kept is bounded by who asked lately.
_HITS: dict[str, deque[float]] = {}


def _client(request: Request) -> str:
    peer = request.client.host if request.client else None
    return network.bucket_of(peer, request.headers)


def _admit(client: str) -> int | None:
    """Count this request against `client`'s minute and return None — or,
    when its minute is spent, return the whole seconds until the oldest hit
    in its window leaves it (rounded up, at least 1): the 429's Retry-After,
    which a client that waits that long finds true (fix round 1)."""
    now = _clock()
    cutoff = now - WINDOW_SECONDS
    for key in list(_HITS):
        hits = _HITS[key]
        while hits and hits[0] <= cutoff:
            hits.popleft()
        if not hits:
            del _HITS[key]
    hits = _HITS.setdefault(client, deque())
    if len(hits) >= RATE_PER_MINUTE:
        oldest = hits[0] if hits else now
        return max(1, math.ceil(oldest + WINDOW_SECONDS - now))
    hits.append(now)
    return None


def _too_many(retry_after: int) -> HTTPException:
    return HTTPException(
        status_code=429,
        detail="too many requests for Nova's agent in the last minute — try again shortly",
        headers={"Retry-After": str(retry_after)},
    )


@router.get("/manifest")
async def manifest(request: Request, origin: str | None = None) -> dict:
    if origin not in (None, "loopback"):
        raise HTTPException(
            status_code=400, detail="origin is loopback or left out — no other is known"
        )
    wait = _admit(_client(request))
    if wait is not None:
        raise _too_many(wait)
    pool = await db.get_pool()
    try:
        build = await agent_dist.read()
    except agent_dist.DistUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    # The build read above, signed as it is: never read a second time.
    signed = await agent_dist.signed_manifest(pool, build)
    got = network.address()
    where, hubs = got.origin, None
    if origin == "loopback":
        # The machine running the stack (./install on a WSL hub prints the
        # Windows command, F9): it downloads through the hub's own loopback
        # door, and gets the tailnet origin behind it as a second locator.
        where = agent_card.LOOPBACK
        hubs = [agent_card.LOOPBACK, *([got.origin] if got.origin else [])]
    return {
        **signed,
        "version": build.version,
        "commands": (
            agent_card.commands(build, origin=where, hubs=hubs, code=agent_card.CODE_SLOT)
            if where
            else None
        ),
        "commands_reason": None if where else got.reason,
        "walks": platform_walks.statuses(),
        "notes": agent_card.notes(),
    }


@router.get("/dist/{name}")
async def dist_file(name: str, request: Request) -> StreamingResponse:
    if name not in agent_dist.FILE_NAMES:
        raise HTTPException(status_code=404, detail="no such agent build")
    wait = _admit(_client(request))
    if wait is not None:
        raise _too_many(wait)
    try:
        opened = await asyncio.to_thread(agent_dist.open_file, name)
    except agent_dist.DistUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return StreamingResponse(
        agent_dist.stream(opened),
        media_type="application/octet-stream",
        headers={
            "Content-Length": str(opened.size),
            "Content-Disposition": f'attachment; filename="{opened.name}"',
        },
        # The stream closes the file when it ends or fails. This closes it
        # when the stream never started — a client gone before the first
        # byte: on uvicorn's ASGI 2.3 Starlette runs the background after a
        # disconnect. Closing twice is harmless.
        background=BackgroundTask(opened.close),
    )
