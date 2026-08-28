"""Wizard passthroughs to the gateway.

Ruling R8: the browser only ever talks to core, so the wizard's hardware,
model and backend calls arrive here and are forwarded 1:1 over core's
gateway link. Nothing is interpreted on the way through — the gateway's
status and body are the answer, including its refusals.
"""
from __future__ import annotations

import json
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from starlette.responses import Response

from app import peers

router = APIRouter(prefix="/api/v1", tags=["wizard"])
logger = logging.getLogger("core")

ADMIN_TIMEOUT = httpx.Timeout(5.0)
# A pull can spend minutes between progress lines, so only the connect
# phase is bounded — a slow download is not a hang.
PULL_TIMEOUT = httpx.Timeout(connect=5.0, read=None, write=10.0, pool=5.0)


def _unreachable(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=502, detail=f"the gateway is unreachable — {peers.reason(exc)}"
    )


def _forward_headers(request: Request) -> dict[str, str]:
    content_type = request.headers.get("content-type")
    return {"content-type": content_type} if content_type else {}


async def _forward(request: Request, method: str, path: str) -> Response:
    body = await request.body()
    try:
        async with peers.client(request.app, peers.GATEWAY, ADMIN_TIMEOUT) as client:
            upstream = await client.request(
                method, path, content=body or None, headers=_forward_headers(request)
            )
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        raise _unreachable(exc) from exc
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )


@router.get("/system/hardware")
async def hardware(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/hardware")


@router.get("/models/suggest")
async def suggest(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/suggest")


@router.post("/models/probe")
async def probe(request: Request) -> Response:
    return await _forward(request, "POST", "/admin/probe")


@router.get("/inference/backend")
async def get_backend(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/backend")


@router.put("/inference/backend")
async def put_backend(request: Request) -> Response:
    return await _forward(request, "PUT", "/admin/backend")


@router.post("/models/pull")
async def pull(request: Request) -> StreamingResponse:
    """Streamed through as it arrives — progress the wizard can show."""
    body = await request.body()
    try:
        client = peers.client(request.app, peers.GATEWAY, PULL_TIMEOUT)
        upstream = await client.send(
            client.build_request(
                "POST", "/admin/pull", content=body or None, headers=_forward_headers(request)
            ),
            stream=True,
        )
    except (httpx.HTTPError, peers.PeerUnconfigured) as exc:
        raise _unreachable(exc) from exc

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.HTTPError as exc:
            # The stream died partway: say so in the progress channel rather
            # than letting a truncated download look finished.
            reason = peers.reason(exc)
            logger.warning("model pull stream failed: %s", reason)
            yield json.dumps({"error": f"the pull stream failed — {reason}"}).encode() + b"\n"
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(
        relay(),
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type"),
    )
