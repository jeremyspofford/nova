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


# ── the model catalogue (S10a): Hugging Face search, a repo's quants, a
# typed ref resolved live — forwarded 1:1, query string byte-for-byte. The
# catalogue itself (GET /models/catalog) is NOT a bare forward: core adds
# the one fact only it holds (eval measurements) — see app/models_catalog.py.
CATALOG_HF_TIMEOUT = httpx.Timeout(connect=5.0, read=25.0, write=5.0, pool=5.0)


@router.get("/models/catalog/hf")
async def catalog_hf(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/catalog/hf", timeout=CATALOG_HF_TIMEOUT)


@router.get("/models/catalog/hf/{org}/{repo}")
async def catalog_hf_repo(org: str, repo: str, request: Request) -> Response:
    return await _forward(
        request, "GET", f"/admin/catalog/hf/{org}/{repo}", timeout=CATALOG_HF_TIMEOUT
    )


@router.get("/models/catalog/resolve")
async def catalog_resolve(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/catalog/resolve", timeout=CATALOG_HF_TIMEOUT)


@router.delete("/models")
async def remove_model(request: Request) -> Response:
    """Remove an installed model from the bundled ollama (`?model=`), verified
    by the gateway against /api/tags. 1:1."""
    return await _forward(request, "DELETE", "/admin/models", timeout=CATALOG_HF_TIMEOUT)


@router.post("/models/catalog/drift")
async def catalog_drift(request: Request) -> Response:
    """Has the source moved since a model was pulled (S10a-2)? 1:1."""
    return await _forward(request, "POST", "/admin/catalog/drift", timeout=CATALOG_HF_TIMEOUT)


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


# ── the provider registry (S10-pre) — forwarded 1:1, ruling R8 ───────────
# Create/update run the gateway's verify-before-save (a live call to the
# provider), so their read budget dominates a slow provider's listing.
PROVIDER_WRITE_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)
PROVIDER_LISTING_TIMEOUT = httpx.Timeout(connect=5.0, read=20.0, write=5.0, pool=5.0)


@router.get("/providers")
async def list_providers(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/providers")


@router.get("/providers/presets")
async def provider_presets(request: Request) -> Response:
    return await _forward(request, "GET", "/admin/providers/presets")


@router.post("/providers")
async def create_provider(request: Request) -> Response:
    return await _forward(request, "POST", "/admin/providers", timeout=PROVIDER_WRITE_TIMEOUT)


@router.get("/providers/{name}")
async def get_provider(name: str, request: Request) -> Response:
    return await _forward(request, "GET", f"/admin/providers/{name}")


@router.put("/providers/{name}")
async def update_provider(name: str, request: Request) -> Response:
    return await _forward(
        request, "PUT", f"/admin/providers/{name}", timeout=PROVIDER_WRITE_TIMEOUT
    )


@router.delete("/providers/{name}")
async def delete_provider(name: str, request: Request) -> Response:
    return await _forward(request, "DELETE", f"/admin/providers/{name}")


@router.put("/providers/{name}/default")
async def make_default_provider(name: str, request: Request) -> Response:
    return await _forward(request, "PUT", f"/admin/providers/{name}/default")


@router.get("/providers/{name}/models")
async def provider_models(name: str, request: Request) -> Response:
    return await _forward(
        request, "GET", f"/admin/providers/{name}/models", timeout=PROVIDER_LISTING_TIMEOUT
    )


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
