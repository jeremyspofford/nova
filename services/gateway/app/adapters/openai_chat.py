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
import math

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
    positive_int,
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


# OpenRouter's `benchmarks.artificial_analysis` indices (2026-09-06) — a
# third party's numbers, relayed as such and never renamed into a verdict.
_BENCHMARK_FIELDS = ("intelligence_index", "coding_index", "agentic_index")
DESCRIPTION_CAP = 500
LISTING_SOURCE = "provider-listing"


def _str_list(value: object) -> list[str] | None:
    if not isinstance(value, list):
        return None
    items = [item for item in value if isinstance(item, str) and item]
    return items or None


def _stated_text(value: object, *, cap: int | None = None) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    return text[:cap] if cap else text


def normalize_models(body: object, *, owned_by: str) -> list[dict]:
    """OpenAI's `{data: [{id, ...}]}` (and OpenRouter's richer rows) mapped to
    the one listing shape every provider reports: id, plus whatever
    context/pricing/capability facts the provider stated. Unknown facts
    are ABSENT, never zero — a null `max_completion_tokens`, an empty
    description or a missing `reasoning` object put nothing on the row.

    OpenRouter's row keys (verified 2026-09-06) read here beyond id/name/
    context_length/pricing: `top_provider.max_completion_tokens`,
    `architecture.input_modalities`, `supported_parameters` (carries
    `tools`/`tool_choice` when function calling is supported), a
    `reasoning` object on models that reason, `benchmarks.
    artificial_analysis.{intelligence,coding,agentic}_index`,
    `hugging_face_id`, `description`, `expiration_date`.
    """
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
        top_provider = entry.get("top_provider")
        if isinstance(top_provider, dict):
            output_cap = positive_int(top_provider.get("max_completion_tokens"))
            if output_cap is not None:
                row["max_output_tokens"] = output_cap
        architecture = entry.get("architecture")
        if isinstance(architecture, dict):
            modalities = _str_list(architecture.get("input_modalities"))
            if modalities:
                row["input_modalities"] = modalities
        parameters = _str_list(entry.get("supported_parameters"))
        if parameters:
            row["supported_parameters"] = parameters
        if isinstance(entry.get("reasoning"), dict):
            row["reasoning"] = True
        benchmarks = entry.get("benchmarks")
        if isinstance(benchmarks, dict) and isinstance(benchmarks.get("artificial_analysis"), dict):
            indices = {}
            for field in _BENCHMARK_FIELDS:
                value = benchmarks["artificial_analysis"].get(field)
                if (
                    isinstance(value, int | float)
                    and not isinstance(value, bool)
                    and math.isfinite(value)
                ):
                    indices[field] = float(value)
            if indices:
                row["benchmarks"] = indices
        for key, cap in (
            ("hugging_face_id", None),
            ("description", DESCRIPTION_CAP),
            ("expiration_date", None),
        ):
            text = _stated_text(entry.get(key), cap=cap)
            if text is not None:
                row[key] = text
        models.append(row)
    return models


def _listed(value: object, note: str) -> dict:
    return {"value": value, "basis": "declared", "source": LISTING_SOURCE, "note": note}


def listing_capabilities(row: dict) -> tuple[dict, dict]:
    """(capabilities, suitability) in the catalogue's fact shape from one
    NORMALIZED listing row (`normalize_models` output).

    Only what the row states, each entry saying which field said so:
    tools ⇐ `supported_parameters` lists `tools`; vision/audio ⇐
    `input_modalities`; thinking ⇐ the `reasoning` flag. Suitability:
    every row of a chat-completions listing is declared a chat model; the
    coding/agentic/reasoning numbers are OpenRouter's third-party
    benchmark indices, relayed with that label and only when present. A
    row that states none of it gets `chat` and nothing else — absence is
    "not stated", never "no".
    """
    capabilities: dict = {}
    parameters = row.get("supported_parameters") or []
    if "tools" in parameters:
        capabilities["tools"] = _listed(True, "supported_parameters lists tools")
    modalities = row.get("input_modalities") or []
    if "image" in modalities:
        capabilities["vision"] = _listed(True, "architecture.input_modalities lists image")
    if "audio" in modalities:
        capabilities["audio"] = _listed(True, "architecture.input_modalities lists audio")
    if row.get("reasoning") is True:
        capabilities["thinking"] = _listed(True, "the listing carries a reasoning object")

    suitability: dict = {"chat": _listed(True, "a chat-completions listing")}
    benchmarks = row.get("benchmarks") or {}
    for key, field in (
        ("coding", "coding_index"),
        ("agentic", "agentic_index"),
        ("reasoning", "intelligence_index"),
    ):
        if field in benchmarks:
            suitability[key] = _listed(
                benchmarks[field],
                f"OpenRouter benchmarks.artificial_analysis.{field} (third-party)",
            )
    return capabilities, suitability


def _is_price(value: object) -> bool:
    """A price is a finite number greater than zero. OpenRouter publishes
    `-1` on its router rows (`openrouter/auto` and kin) to mean "varies" and
    `0` on free variants — neither is a price to rank by, and the auto
    router is the one place a probe must not go (it picks a model itself)."""
    return isinstance(value, int | float) and math.isfinite(value) and value > 0


def cheapest_model(models: list[dict]) -> str:
    """The model id a key probe spends its one token on: the cheapest by the
    provider's own stated prompt+completion price, over rows that state
    BOTH as real prices; else the first listed (a listing with no usable
    prices gives nothing better to choose by). The first listed on
    OpenRouter is its newest flagship — the wrong place to spend even a
    token when the same list says which is cheapest."""
    priced = []
    for m in models:
        pricing = m.get("pricing")
        if not isinstance(pricing, dict) or not m.get("id"):
            continue
        prompt, completion = pricing.get("prompt"), pricing.get("completion")
        if _is_price(prompt) and _is_price(completion):
            priced.append((prompt + completion, m["id"]))
    if priced:
        return min(priced)[1]
    return models[0]["id"]


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

    async def _listing_is_public(self, app, row: dict) -> tuple[bool | None, str]:
        """(is the listing public?, what decided it).

        Re-asks /models with a key that is certainly wrong. A 401/403 means
        the listing REQUIRES the key — so the real key's 200 was the provider
        accepting it. A 200 means the listing is public and proved nothing
        about the key. Anything else (429, 5xx, a transport error) decides
        NOTHING: it is returned as None with the words, never read as either
        answer (a rate-limited second call used to paint 'Key verified').
        """
        probe_row = dict(row, api_key="nova-verify-this-key-is-wrong")
        url = base_url_of(row)
        client = http_client(app, MODELS_TIMEOUT, base_url=url, headers=self.headers(probe_row))
        try:
            async with client as c:
                resp = await c.get("/models")
        except httpx.HTTPError as exc:
            return None, f"the wrong-key check could not reach {url}/models — {reason(exc)}"
        if resp.status_code == 200:
            return True, "the listing answered 200 to a wrong key"
        if resp.status_code in (401, 403):
            return False, f"the listing refused a wrong key ({resp.status_code})"
        return None, f"the wrong-key check answered {resp.status_code} ({refusal_detail(resp)})"

    async def _key_probe(self, app, row: dict, model: str) -> tuple[int, str, bool]:
        """A 1-token completion through the SAME code path a turn uses —
        (status, the provider's words, whether a COMPLETION came back). The
        only way to prove a key when the listing does not need one. A 200
        is not enough on its own: the relay answers 200 and then writes an
        error frame when the provider compressed despite being asked not
        to or the stream died — so the body has to hold `choices`."""
        response = await self._completions(
            app,
            row,
            model,
            {"messages": [{"role": "user", "content": "hi"}], "max_tokens": 1, "stream": False},
        )
        content = b""
        iterator = getattr(response, "body_iterator", None)
        if iterator is not None:
            async for chunk in iterator:
                content += chunk if isinstance(chunk, bytes) else str(chunk).encode()
        else:
            content = response.body
        words = content.decode(errors="replace")[:400]
        completed = False
        if response.status_code == 200:
            try:
                parsed = json.loads(content)
            except ValueError:
                parsed = None
            completed = (
                isinstance(parsed, dict)
                and isinstance(parsed.get("choices"), list)
                and parsed.get("error") is None
            )
        return response.status_code, words, completed

    async def verify(self, app, row: dict) -> VerifyResult:
        """What a save must prove: the provider is reachable AND the key is
        accepted — reported as a structured `key_proven`, never as prose a
        page has to parse. The listing call is the first probe (a 401/403
        there is the provider refusing the key); a 404/405 is recorded as
        `unavailable` (reachable, no listing — model ids are typed) and the
        key is NOT tested, which is said. When the listing answers 200 to a
        WRONG key too, it proved nothing about the key, so a 1-token
        completion on the cheapest priced model in the listing is the proof
        — a refusal there refuses the save; any other failure is stated on
        the row rather than read as success (rail 5)."""
        try:
            listing = await self.list_models(app, row)
        except ListingUnavailable as exc:
            return VerifyResult(
                listing="unavailable",
                note=f"{exc} — the key was not tested; the first chat turn will tell",
                key_proven=None,
            )
        note = f"{len(listing.models)} models listed"
        if row.get("auth_shape") == "none":
            return VerifyResult(listing="available", note=note, key_proven=None)
        if not listing.models:
            return VerifyResult(
                listing="available",
                note=f"{note} — nothing to test the key on; the first chat turn will tell",
                key_proven=None,
            )
        public, decided_by = await self._listing_is_public(app, row)
        if public is False:
            return VerifyResult(
                listing="available", note=f"{note}; the listing accepted the key", key_proven=True
            )
        if public is None:
            return VerifyResult(
                listing="available",
                note=f"{note}; whether the listing is public could not be determined — "
                f"{decided_by} — so the key is NOT proven; the first chat turn will tell",
                key_proven=None,
            )
        model = cheapest_model(listing.models)
        try:
            status, words, completed = await self._key_probe(app, row, model)
        except ProviderRefused as exc:
            status, words, completed = exc.status, exc.detail, False
        if status in (401, 403):
            raise ProviderRefused(status, f"the key was refused on a test completion — {words}")
        if completed:
            return VerifyResult(
                listing="available",
                note=f"{note}; the listing is public, so the key was proven with a 1-token "
                f"completion on {model}",
                key_proven=True,
            )
        return VerifyResult(
            listing="available",
            note=f"{note}; the listing is public and a 1-token test on {model} answered "
            f"{status} ({words}) — the key is NOT proven; the first chat turn will tell",
            key_proven=False,
        )

    async def completions(self, request: Request, row: dict, model: str, body: dict) -> Response:
        return await self._completions(request.app, row, model, body)

    async def _completions(self, app, row: dict, model: str, body: dict) -> Response:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        body = dict(body, model=model) if model else dict(body)
        client = http_client(app, COMPLETIONS_TIMEOUT, base_url=url, headers=self.headers(row))
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

__all__ = [
    "ADAPTER",
    "OpenAIChat",
    "VERIFY_TIMEOUT",
    "listing_capabilities",
    "normalize_models",
    "sse_error_chunk",
]
