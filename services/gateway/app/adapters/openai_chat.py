"""The `openai-chat` adapter: any endpoint speaking OpenAI Chat Completions.

OpenAI, OpenRouter, Groq, Cerebras, xAI, Mistral, DeepSeek, Together,
Fireworks, DashScope, Gemini's compat layer, Azure's v1 surface and
Bedrock's runtime endpoint are all THIS adapter with a different base URL
and auth shape (verified 2026-09-05 — see the slice plan's frontier facts).

Chat is a pure passthrough: no retries, no fallback, no routing. The
provider's bytes are relayed exactly, including how it fails. The one thing
added is the auth header the row asks for.
"""
from __future__ import annotations

import json
import logging

import httpx
from fastapi import Request
from fastapi.responses import Response, StreamingResponse

from app.adapters import base
from app.adapters.base import (
    COMPLETIONS_TIMEOUT,
    MODELS_TIMEOUT,
    VERIFY_TIMEOUT,
    Listing,
    ListingUnavailable,
    ProviderRefused,
    VerifyResult,
    http_client,
    reason,
    refusal_detail,
)
from app.providers import base_url_of

logger = logging.getLogger("gateway")

# Headers a proxy must not relay verbatim — they describe THIS hop, not the
# payload.
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

# The non-200 branch fully buffers the body via upstream.aread(), which
# httpx transparently DEcompresses — the bytes handed to Response() are
# already plain, so the original Content-Encoding and Content-Length would
# both be lies about them.
_BUFFERED_EXCLUDE = frozenset({"content-encoding", "content-length"})

# The streaming path may append an SSE error chunk AFTER the upstream body
# ended (a mid-stream failure) — a declared Content-Length would then stop
# matching the bytes sent, and a compressed body plus our plain tail decodes
# as neither. Both dropped unconditionally: headers are on the wire before
# we know whether a failure will happen.
_STREAMING_EXCLUDE = frozenset({"content-length", "content-encoding"})


def forwardable_headers(
    upstream_headers: httpx.Headers, *, exclude: frozenset[str] = frozenset()
) -> dict[str, str]:
    skip = _HOP_BY_HOP | exclude
    return {
        key: value
        for key, value in upstream_headers.items()
        if key.lower() not in skip and not key.lower().startswith("proxy-")
    }


def sse_error_chunk(message: str) -> bytes:
    """OpenAI's own error shape, injected into an otherwise-200 stream —
    the only way to report a failure once headers are already sent."""
    return f"data: {json.dumps({'error': {'message': message}})}\n\n".encode()


def normalize_models(body: object, *, owned_by: str) -> list[dict]:
    """OpenAI's `{data: [{id, ...}]}` (and OpenRouter's richer rows) mapped to
    the one listing shape every provider reports: id, plus whatever
    context/pricing facts the provider stated. Unknown facts are ABSENT,
    never zero."""
    if not isinstance(body, dict):
        raise ProviderRefused(502, "the model listing was not a JSON object")
    data = body.get("data")
    if not isinstance(data, list):
        raise ProviderRefused(502, "the model listing carried no `data` array")
    models = []
    for entry in data:
        if not isinstance(entry, dict) or not entry.get("id"):
            continue
        row: dict = {"id": str(entry["id"]), "owned_by": owned_by}
        if entry.get("name"):
            row["name"] = str(entry["name"])
        context = entry.get("context_length")
        if isinstance(context, int | float) and context > 0:
            row["context_length"] = int(context)
        pricing = entry.get("pricing")
        if isinstance(pricing, dict):
            prices = {}
            for field in ("prompt", "completion"):
                value = pricing.get(field)
                try:
                    if value is not None:
                        prices[field] = float(value)
                except (TypeError, ValueError):
                    continue
            if prices:
                row["pricing"] = prices
        models.append(row)
    return models


class OpenAIChat:
    name = "openai-chat"

    def headers(self, row: dict) -> dict[str, str]:
        # `api-key-header` on this protocol is Azure's header name.
        return base.bearer_or_header(row, header_name="api-key")

    async def list_models(self, app, row: dict) -> Listing:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        client = http_client(app, MODELS_TIMEOUT, base_url=url, headers=self.headers(row))
        try:
            async with client as c:
                resp = await c.get("/models")
        except httpx.HTTPError as exc:
            raise ProviderRefused(502, f"could not reach {url} — {reason(exc)}") from exc
        if resp.status_code in (404, 405):
            raise ListingUnavailable(
                f"{url}/models answered {resp.status_code} — this provider has no model "
                "listing; type a model id"
            )
        if resp.status_code != 200:
            raise ProviderRefused(resp.status_code, refusal_detail(resp))
        try:
            body = resp.json()
        except ValueError as exc:
            raise ProviderRefused(502, f"{url}/models returned non-JSON: {exc}") from exc
        return Listing(source=row["name"], models=normalize_models(body, owned_by=row["name"]))

    async def verify(self, app, row: dict) -> VerifyResult:
        """The listing call where the provider has one. A 404/405 is
        recorded as `unavailable` (reachable, no listing — model ids are
        typed); a 401/403 is the provider refusing the key and the save
        does not happen."""
        try:
            listing = await self.list_models(app, row)
        except ListingUnavailable as exc:
            return VerifyResult(listing="unavailable", note=str(exc))
        return VerifyResult(
            listing="available", note=f"{len(listing.models)} models listed"
        )

    async def completions(self, request: Request, row: dict, model: str, body: dict) -> Response:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        if model:
            body["model"] = model
        client = http_client(
            request.app, COMPLETIONS_TIMEOUT, base_url=url, headers=self.headers(row)
        )
        try:
            upstream = await client.send(
                client.build_request("POST", "/chat/completions", json=body), stream=True
            )
        except httpx.HTTPError as exc:
            await client.aclose()
            raise ProviderRefused(
                502, f"could not reach {row['name']} at {url} — {reason(exc)}"
            ) from exc

        if upstream.status_code != 200:
            content = await upstream.aread()
            headers = forwardable_headers(upstream.headers, exclude=_BUFFERED_EXCLUDE)
            await upstream.aclose()
            await client.aclose()
            return Response(content=content, status_code=upstream.status_code, headers=headers)

        # Every call asks for Accept-Encoding: identity so aiter_raw() can
        # relay wire bytes straight through as plain text. A provider that
        # compresses anyway is caught here, before a single byte is relayed,
        # and reported as an OpenAI-shaped SSE error frame — never as
        # undecodable binary that looks exactly like an empty, silent reply.
        content_encoding = upstream.headers.get("content-encoding", "").strip().lower()
        if content_encoding and content_encoding != "identity":
            await upstream.aclose()
            await client.aclose()
            message = (
                f"the provider at {url} ignored the identity encoding request and "
                f"compressed its reply ({content_encoding}) — refusing to relay undecodable "
                "bytes as text"
            )
            logger.warning("chat completion stream refused: %s", message)

            async def relay_violation():
                yield sse_error_chunk(message)

            relay_headers = forwardable_headers(upstream.headers, exclude=_STREAMING_EXCLUDE)
            return StreamingResponse(relay_violation(), status_code=200, headers=relay_headers)

        async def relay():
            try:
                async for chunk in upstream.aiter_raw():
                    yield chunk
            except httpx.HTTPError as exc:
                failure = reason(exc)
                logger.warning("chat completion stream failed mid-flight: %s", failure)
                yield sse_error_chunk(f"the {row['name']} stream failed — {failure}")
            finally:
                await upstream.aclose()
                await client.aclose()

        relay_headers = forwardable_headers(upstream.headers, exclude=_STREAMING_EXCLUDE)
        return StreamingResponse(relay(), status_code=200, headers=relay_headers)


ADAPTER = OpenAIChat()

__all__ = ["ADAPTER", "OpenAIChat", "VERIFY_TIMEOUT", "normalize_models", "sse_error_chunk"]
