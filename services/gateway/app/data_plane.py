"""POST /v1/chat/completions and GET /v1/models — the OpenAI-compat data
plane. Pure passthrough: no retries, no fallback, no routing intelligence.
Routing is explicitly a later slice; this file's only job is to reach the
one configured backend and relay exactly what it says, including how it
fails.
"""
from __future__ import annotations

import json
import logging

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from app import backends, db

router = APIRouter(tags=["data-plane"])
logger = logging.getLogger("gateway")

# No read timeout on completions: a model thinking is not a failure.
# Connect/write stay bounded so a truly dead backend is reported quickly.
COMPLETIONS_TIMEOUT = httpx.Timeout(connect=5.0, read=300.0, write=10.0, pool=5.0)
MODELS_TIMEOUT = httpx.Timeout(10.0)

# Headers a proxy must not relay verbatim — they describe THIS hop, not the
# payload. Content-Encoding is deliberately NOT here: aiter_raw() yields the
# upstream's still-compressed wire bytes, so the encoding header describing
# them has to travel with them or the caller cannot decompress the body.
_HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "transfer-encoding",
    "upgrade",
    "te",
    "trailer",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
}


def _forwardable_headers(
    upstream_headers: httpx.Headers, *, exclude: frozenset[str] = frozenset()
) -> dict[str, str]:
    """Every upstream response header except the hop-by-hop ones (plus any
    caller-specified exclusions) — used both where we relay bytes we did not
    decode ourselves (aiter_raw, so content-type and content-encoding must
    ride along untouched) and where we relay bytes we DID decode (aread() on
    the non-200 branch), where the caller-specified exclusions exist
    precisely to drop the headers that describe the pre-decode body rather
    than the one we are actually sending."""
    skip = _HOP_BY_HOP | exclude
    return {
        key: value
        for key, value in upstream_headers.items()
        if key.lower() not in skip and not key.lower().startswith("proxy-")
    }


# The non-200 branch fully buffers the body via upstream.aread(), which
# httpx transparently DEcompresses according to whatever Content-Encoding
# the backend sent — the bytes handed to Response() are already plain.
# Forwarding the original Content-Encoding here would tell the caller to
# decompress already-decompressed bytes (core's own aread() on the relay
# raises DecodingError doing exactly that, which is how a provider's plain
# "invalid api key" 401 turned into an opaque "could not reach the gateway"
# for the operator). Content-Length is equally false once the body has been
# re-framed by decompression. Both are dropped so Starlette computes the one
# number and one (lack of) encoding that are actually true for the bytes we
# send.
_BUFFERED_EXCLUDE = frozenset({"content-encoding", "content-length"})

# The streaming/relay path may append an SSE error chunk AFTER the upstream
# body has already ended (a mid-stream failure) — bytes relay() can still
# hand the client even though the upstream declared how many there would
# be, or what encoding they were in. Forwarding that Content-Length would
# then be a lie: declared length stops matching bytes actually sent, an HTTP
# framing violation. Forwarding Content-Encoding is the same lie in a
# different shape — our appended chunk is always plain UTF-8 JSON, never
# whatever compression the upstream used, so a compressed body plus our
# plain-text tail decodes as neither (a corrupt tail). Because headers are
# already on the wire before we know whether a failure will happen, both
# are dropped unconditionally rather than only when a failure actually
# occurs (the non-200 branch is exempt from both — it fully buffers content
# first, so nothing is ever appended to it after the fact; see
# _BUFFERED_EXCLUDE above).
_STREAMING_EXCLUDE = frozenset({"content-length", "content-encoding"})


def _served_by_header(kind: str, model: str) -> dict[str, str]:
    return {"X-Nova-Served-By": f"{kind}:{model}"}


def _sse_error_chunk(message: str) -> bytes:
    """OpenAI's own error shape, injected into an otherwise-200 stream —
    the only way to report a failure once headers are already sent."""
    return f"data: {json.dumps({'error': {'message': message}})}\n\n".encode()


def ollama_tags_to_openai_list(tags: dict) -> dict:
    """Ollama's /api/tags shape mapped onto OpenAI's GET /v1/models list."""
    models = tags.get("models") or []
    return {
        "object": "list",
        "data": [
            {
                "id": m.get("name") or m.get("model"),
                "object": "model",
                "created": 0,
                "owned_by": "ollama",
            }
            for m in models
            if isinstance(m, dict)
        ],
    }


@router.post("/v1/chat/completions")
async def chat_completions(request: Request) -> Response:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(
            status_code=400, detail=f"request body is not valid JSON: {exc}"
        ) from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="request body must be a JSON object")

    pool = await db.get_pool()
    config = await backends.read_config(pool)
    resolved_model = body.get("model") or config.get("model") or ""
    if resolved_model:
        body["model"] = resolved_model

    base_url = backends.resolve_base_url(config)
    if not base_url:
        raise HTTPException(
            status_code=502, detail=f"no base URL configured for backend kind={config['kind']}"
        )
    served_by = _served_by_header(config["kind"], resolved_model)
    client = backends.http_client(
        request.app, COMPLETIONS_TIMEOUT, base_url=base_url, headers=backends.auth_headers(config)
    )
    try:
        upstream = await client.send(
            client.build_request("POST", "/v1/chat/completions", json=body), stream=True
        )
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(
            status_code=502, detail=f"could not reach the backend — {backends.reason(exc)}"
        ) from exc

    if upstream.status_code != 200:
        content = await upstream.aread()
        headers = _forwardable_headers(upstream.headers, exclude=_BUFFERED_EXCLUDE)
        headers.update(served_by)
        await upstream.aclose()
        await client.aclose()
        return Response(content=content, status_code=upstream.status_code, headers=headers)

    async def relay():
        try:
            async for chunk in upstream.aiter_raw():
                yield chunk
        except httpx.HTTPError as exc:
            failure = backends.reason(exc)
            logger.warning("chat completion stream failed mid-flight: %s", failure)
            yield _sse_error_chunk(f"the backend stream failed — {failure}")
        finally:
            await upstream.aclose()
            await client.aclose()

    relay_headers = _forwardable_headers(upstream.headers, exclude=_STREAMING_EXCLUDE)
    relay_headers.update(served_by)
    return StreamingResponse(relay(), status_code=200, headers=relay_headers)


@router.get("/v1/models")
async def list_models(request: Request) -> Response:
    pool = await db.get_pool()
    config = await backends.read_config(pool)
    base_url = backends.resolve_base_url(config)
    if not base_url:
        raise HTTPException(
            status_code=502, detail=f"no base URL configured for backend kind={config['kind']}"
        )

    path = "/api/tags" if config["kind"] == "ollama" else "/v1/models"
    client = backends.http_client(
        request.app, MODELS_TIMEOUT, base_url=base_url, headers=backends.auth_headers(config)
    )
    try:
        async with client as c:
            upstream = await c.get(path)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=502, detail=f"could not reach the backend — {backends.reason(exc)}"
        ) from exc

    if config["kind"] != "ollama":
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type"),
        )

    if upstream.status_code != 200:
        return Response(
            content=upstream.content,
            status_code=upstream.status_code,
            media_type=upstream.headers.get("content-type"),
        )
    try:
        tags = upstream.json()
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=502, detail=f"ollama returned a non-JSON /api/tags response: {exc}"
        ) from exc
    return Response(
        content=json.dumps(ollama_tags_to_openai_list(tags)).encode(),
        media_type="application/json",
    )
