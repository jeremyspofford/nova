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
# The gateway's own probe work is bounded by its own PROBE_TIMEOUT=30.0
# (services/gateway/app/admin.py) plus a DB insert after — the READ side of
# this has to comfortably dominate that whole downstream budget, or a
# cold-model probe the gateway is still legitimately working on times out
# here first and gets reported as if the gateway itself were unreachable.
# Connect/write/pool stay at the same 5s as every other admin route: a
# dead gateway (nothing answering the TCP connect at all) is a fast, cheap
# fact, not something a 35s-wide flat timeout should make the wizard wait
# out — only the "still answering, just slow" case needs the wide budget.
PROBE_TIMEOUT = httpx.Timeout(connect=5.0, read=35.0, write=5.0, pool=5.0)
# verify_live's own inner liveness check is httpx.Timeout(5.0)
# (services/gateway/app/backends.py) plus a DB write after saving — same
# reasoning, smaller downstream budget, same tight connect/write/pool.
BACKEND_PUT_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=5.0)
# A pull can spend minutes between progress lines, so only the connect
# phase is bounded — a slow download is not a hang.
PULL_TIMEOUT = httpx.Timeout(connect=5.0, read=None, write=10.0, pool=5.0)


def _unreachable(exc: Exception) -> HTTPException:
    return HTTPException(
        status_code=502, detail=f"the gateway is unreachable — {peers.reason(exc)}"
    )


def _timed_out(path: str, timeout: httpx.Timeout) -> HTTPException:
    """A ReadTimeout is not the same fact as an unreachable gateway — the
    gateway answered the connection and may still be genuinely working (a
    cold-model probe, a slow verify-then-save); naming the route and the
    budget it was given says what actually happened instead of implying the
    gateway is down."""
    budget = "an unbounded read" if timeout.read is None else f"{timeout.read:g}s"
    return HTTPException(
        status_code=502, detail=f"the gateway timed out — {path} did not answer within {budget}"
    )


def _forward_headers(request: Request) -> dict[str, str]:
    content_type = request.headers.get("content-type")
    return {"content-type": content_type} if content_type else {}


def _target(request: Request, path: str) -> httpx.URL:
    """The gateway path with this request's query string, byte for byte.

    Passed as raw bytes rather than re-parsed parameters so that whatever
    the browser sent — encodings included — is what the gateway sees.
    """
    query = request.scope.get("query_string") or b""
    return httpx.URL(path, query=query) if query else httpx.URL(path)


async def _forward(
    request: Request, method: str, path: str, *, timeout: httpx.Timeout = ADMIN_TIMEOUT
) -> Response:
    body = await request.body()
    try:
        async with peers.client(request.app, peers.GATEWAY, timeout) as client:
            upstream = await client.request(
                method,
                _target(request, path),
                content=body or None,
                headers=_forward_headers(request),
            )
    except httpx.ReadTimeout as exc:
        raise _timed_out(path, timeout) from exc
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
    return await _forward(request, "POST", "/admin/probe", timeout=PROBE_TIMEOUT)


@router.get("/inference/backend")
async def get_backend(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/backend")


@router.get("/models")
async def list_models(request: Request) -> Response:
    """The gateway's OpenAI-compat GET /v1/models — not under /admin, since
    it is the data plane's own route (services/gateway/app/data_plane.py),
    but the browser still only ever reaches it through core (ruling R8).
    Settings -> Models uses this to know which curated slugs are already
    installed."""
    return await _forward(request, "GET", "/v1/models")


@router.put("/inference/backend")
async def put_backend(request: Request) -> Response:
    return await _forward(request, "PUT", "/admin/backend", timeout=BACKEND_PUT_TIMEOUT)


@router.post("/models/pull")
async def pull(request: Request) -> StreamingResponse:
    """Streamed through as it arrives — progress the wizard can show."""
    body = await request.body()
    try:
        client = peers.client(request.app, peers.GATEWAY, PULL_TIMEOUT)
        upstream = await client.send(
            client.build_request(
                "POST",
                _target(request, "/admin/pull"),
                content=body or None,
                headers=_forward_headers(request),
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
