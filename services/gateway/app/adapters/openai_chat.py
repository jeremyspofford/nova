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
import re

import httpx
from fastapi import Request
from fastapi.responses import Response, StreamingResponse

from app.adapters import base
from app.adapters.base import (
    COMPLETIONS_TIMEOUT,
    CONNECT_PHASE_ERRORS,
    DECISIONS,
    MODELS_TIMEOUT,
    VERIFY_TIMEOUT,
    Balance,
    Listing,
    ListingUnavailable,
    ProviderRefused,
    ProviderUnreachable,
    VerifyResult,
    http_client,
    positive_int,
    reason,
    refusal_detail,
    refusal_words,
)
from app.providers import base_url_of
from app.usage import Attribution

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
            outputs = _str_list(architecture.get("output_modalities"))
            if outputs:
                row["output_modalities"] = outputs
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

    # `chat` only when the row itself says it produces text: OpenRouter-
    # shaped rows carry output_modalities / supported_parameters; a plain
    # /models listing (OpenAI's lists whisper, tts and embeddings alongside)
    # states nothing about chat, and nothing is what the row gets.
    suitability: dict = {}
    output_modalities = row.get("output_modalities")
    if isinstance(output_modalities, list) and "text" in output_modalities:
        suitability["chat"] = _listed(True, "architecture.output_modalities lists text")
    elif isinstance(row.get("supported_parameters"), list) and row["supported_parameters"]:
        suitability["chat"] = _listed(True, "supported_parameters are stated (a chat model)")
    # A decision model answers typed questions (decision-role spec §3) — a
    # fact the row states, and the one thing it is suitable for.
    if isinstance(output_modalities, list) and DECISIONS in output_modalities:
        suitability["decisions"] = _listed(
            True, "the listing says it outputs decisions (a decision model)"
        )
    benchmarks = row.get("benchmarks") or {}
    for key, field in (
        ("coding", "coding_index"),
        ("agentic", "agentic_index"),
        # Artificial Analysis's Intelligence Index is a composite, not a
        # reasoning measure: it is read out under its own name.
        ("intelligence", "intelligence_index"),
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


OPENROUTER_HOSTS = frozenset({"openrouter.ai"})
_USAGE_FIELDS = ("stream_options", "usage")


def inject_usage(body: dict, base_url: str) -> tuple[dict, bool]:
    """Ask the provider to state its usage: `stream_options.include_usage`
    on a stream (OpenAI's and ollama's shape), and OpenRouter's own
    `usage: {include: true}` so its `usage.cost` — the provider's OWN
    reported cost — arrives too. Returns (body, whether anything was
    added). A provider that rejects the fields is retried once without
    them and remembered (providers.usage_supported)."""
    out = dict(body)
    added = False
    if out.get("stream"):
        options = dict(out.get("stream_options") or {})
        if not options.get("include_usage"):
            options["include_usage"] = True
            out["stream_options"] = options
            added = True
    host = (httpx.URL(base_url).host or "").lower()
    if host in OPENROUTER_HOSTS and not isinstance(out.get("usage"), dict):
        out["usage"] = {"include": True}
        added = True
    return out, added


def strip_usage(body: dict) -> dict:
    return {k: v for k, v in body.items() if k not in _USAGE_FIELDS}


# OpenRouter's prompt-caching guide (read 2026-10-14,
# openrouter.ai/docs/guides/best-practices/prompt-caching): "Include
# `session_id` as a top-level field in your request body" (at most 256
# characters) — with it, sticky routing to one provider starts on any
# successful request, so a turn's rounds stay on the provider holding their
# cache. Anthropic upstreams cache only what `cache_control` marks: explicit
# `{"type": "ephemeral"}` on content blocks, "a limit of four explicit
# breakpoints".
_CACHE_CONTROL = {"type": "ephemeral"}
_SESSION_ID_MAX = 256


def _vendor(model: object) -> str:
    """The vendor namespace of an OpenRouter model id as sent —
    `anthropic/claude-…`, or `~anthropic/claude-…-latest` (its alias form)."""
    if not isinstance(model, str) or "/" not in model:
        return ""
    return model.lstrip("~").split("/", 1)[0].strip().lower()


def _unmarked(value: dict) -> dict:
    return {k: v for k, v in value.items() if k != "cache_control"}


def _without_markers(message: object) -> object:
    if not isinstance(message, dict):
        return message
    out = _unmarked(message)
    content = out.get("content")
    if isinstance(content, list):
        out["content"] = [_unmarked(p) if isinstance(p, dict) else p for p in content]
    return out


def _markable(message: object) -> bool:
    if not isinstance(message, dict):
        return False
    content = message.get("content")
    if isinstance(content, str):
        return bool(content)
    return isinstance(content, list) and bool(content) and isinstance(content[-1], dict)


def _marked(message: dict) -> dict:
    """The message with its last content part marked (a string content
    becomes the one text part it is shorthand for)."""
    content = message["content"]
    if isinstance(content, str):
        parts = [{"type": "text", "text": content}]
    else:
        parts = list(content)
    parts[-1] = dict(parts[-1], cache_control=dict(_CACHE_CONTROL))
    return dict(message, content=parts)


def _turn_id(request) -> str | None:
    """The turn core named on this call (X-Nova-Turn-Id), read the way the
    ledger reads it — a UUID, or nothing."""
    headers = getattr(request, "headers", None)
    return Attribution.from_headers(headers).turn_id if headers is not None else None


def cache_hints(body: dict, base_url: str, turn_id: str | None) -> dict:
    """What OpenRouter needs to keep a turn's rounds cached (S38c T9).

    Any other host: the body as given. On OpenRouter: `session_id` = the
    turn id (a caller's own kept), and when the model's vendor namespace is
    `anthropic`, two breakpoints — the first system message's last part (the
    stable prompt) and the last part of the latest message with content (it
    moves forward each round, so the previous rounds are read from cache).
    The gateway owns the markers on that path: a caller's own never pass, so
    the request holds 2 of Anthropic's 4. Never writes to `body`."""
    host = (httpx.URL(base_url).host or "").lower()
    if host not in OPENROUTER_HOSTS:
        return body
    out = dict(body)
    if turn_id and not isinstance(out.get("session_id"), str):
        out["session_id"] = turn_id[:_SESSION_ID_MAX]
    messages = out.get("messages")
    if _vendor(out.get("model")) != "anthropic" or not isinstance(messages, list):
        return out
    out.pop("cache_control", None)
    if isinstance(out.get("tools"), list):
        out["tools"] = [_unmarked(t) if isinstance(t, dict) else t for t in out["tools"]]
    messages = [_without_markers(m) for m in messages]
    system = next(
        (i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "system"),
        None,
    )
    latest = next((i for i in range(len(messages) - 1, -1, -1) if _markable(messages[i])), None)
    for i in {system, latest} - {None}:
        if _markable(messages[i]):
            messages[i] = _marked(messages[i])
    out["messages"] = messages
    return out


# OpenRouter's credit refusal names the reply it CAN pay for: "You requested up
# to 65536 tokens, but can only afford 4321." With no max_tokens it reserves the
# model's whole output cap, so a low balance refused every turn outright
# (09-25..09-30) while it could still afford a reply. The number is the
# provider's own live statement, never a budget kept here.
_AFFORDS = re.compile(r"can only afford (\d+)")


def _affordable_tokens(status: int, content: bytes, body: dict) -> int | None:
    """The max_tokens to ask for again, or None: a 402 that states a positive
    affordable count below what this request asked for (or left unset)."""
    if status != 402:
        return None
    found = _AFFORDS.search(refusal_words(content))
    if found is None:
        return None
    affords = int(found.group(1))
    asked = body.get("max_tokens")
    if affords <= 0 or (isinstance(asked, int) and asked <= affords):
        return None
    return affords


def _finite(value: object) -> float | None:
    """`value` as a float when it is a real finite number, else None. bool is
    an int subclass, so a provider's `true` must not read as 1."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


async def _read_data(app, url: str, path: str, headers: dict) -> tuple[dict | None, str]:
    """GET {url}{path}'s `data` object, or (None, why in words)."""
    client = http_client(app, MODELS_TIMEOUT, base_url=url, headers=headers)
    try:
        async with client as c:
            resp = await c.get(path)
    except httpx.HTTPError as exc:
        return None, f"could not reach {url}{path} — {reason(exc)}"
    if resp.status_code != 200:
        return None, f"{url}{path} answered {resp.status_code} ({refusal_detail(resp)})"
    try:
        body = resp.json()
    except ValueError as exc:
        return None, f"{url}{path} returned non-JSON: {exc}"
    data = body.get("data") if isinstance(body, dict) else None
    if not isinstance(data, dict):
        return None, f"{url}{path} states no data object"
    return data, ""


def _refuses_usage_fields(content: bytes) -> bool:
    text = content.decode(errors="replace").lower()
    return any(field in text for field in _USAGE_FIELDS)


async def _remember_usage_support(row: dict, supported: bool) -> None:
    from app import db, providers

    try:
        await providers.record_usage_support(await db.get_pool(), row["name"], supported)
    except Exception:  # a note about the wire, never a reason to fail the call
        logger.warning("could not record usage_supported=%s for %s", supported, row["name"])


class OpenAIChat:
    name = "openai-chat"
    # OpenRouter serves Jev's typed questions at {base}/systemone with the
    # same key it serves chat with (decision-role spec §1), so an endpoint
    # of this protocol MAY carry both; one that does not answers /systemone
    # with a 404, and the decision walk passes that link over in the
    # provider's own words (systemone.NotCarried), never walling it.
    protocols = frozenset({"chat", "systemone"})

    def headers(self, row: dict) -> dict[str, str]:
        # `api-key-header` on this protocol is Azure's header name.
        return base.bearer_or_header(row, header_name="api-key")

    async def balance(self, app, row: dict) -> Balance | None:
        """What is left on this row's key, read live from the provider — or
        None when this provider states no balance (only OpenRouter does, by
        base_url host, the same derivation inject_usage uses).

        OpenRouter: GET {base}/key states `limit_remaining` for a key with a
        limit; a key with no limit (`limit: null`) is bounded by the
        account, GET {base}/credits `total_credits - total_usage`. Any read
        that does not yield a finite number is Balance(None, why) — never a
        number, so a failed read can never pass for money."""
        url = base_url_of(row)
        if not url or (httpx.URL(url).host or "").lower() not in OPENROUTER_HOSTS:
            return None
        headers = self.headers(row)
        data, why = await _read_data(app, url, "/key", headers)
        if data is None:
            return Balance(None, why)
        if "limit" not in data:
            return Balance(None, f"{url}/key states no limit field")
        limit = data["limit"]
        if limit is not None:
            if _finite(limit) is None:
                return Balance(None, f"{url}/key states a limit that is not a number: {limit!r}")
            remaining = _finite(data.get("limit_remaining"))
            if remaining is None:
                return Balance(
                    None,
                    f"{url}/key states no numeric limit_remaining "
                    f"({data.get('limit_remaining')!r})",
                )
            return Balance(remaining, f"{url}/key limit_remaining {remaining:g} of {limit:g}")
        data, why = await _read_data(app, url, "/credits", headers)
        if data is None:
            return Balance(None, f"the key has no limit, and {why}")
        credits = _finite(data.get("total_credits"))
        usage = _finite(data.get("total_usage"))
        if credits is None or usage is None:
            missing = "total_credits" if credits is None else "total_usage"
            return Balance(None, f"{url}/credits states no numeric {missing}")
        remaining = credits - usage
        return Balance(
            remaining,
            f"{url}/credits total_credits {credits:g} - total_usage {usage:g} = {remaining:g}",
        )

    async def list_models(self, app, row: dict) -> Listing:
        url = base_url_of(row)
        listing = await base.fetch_listing(
            app,
            row,
            url,
            headers=self.headers(row),
            normalize=normalize_models,
            unavailable_note="this provider has no model listing; type a model id",
        )
        models = listing.models
        note = None
        # Only a listing that speaks the modality vocabulary can be asked for
        # a modality; anything else is never asked.
        if any("output_modalities" in model for model in models):
            extra, note = await self._decision_models(
                app, row, url, {model["id"] for model in models}
            )
            models = models + extra
        return Listing(source=row["name"], models=models, fetched_at=listing.fetched_at, note=note)

    async def _decision_models(
        self, app, row: dict, url: str, listed: set[str]
    ) -> tuple[list[dict], str | None]:
        """The provider's DECISION models (decision-role spec §3). OpenRouter
        lists a model that outputs `decisions` — Jev, Kev-4B — only when asked
        for `?output_modalities=decisions`; its default listing is text
        models. A failure here is a NOTE on the listing, never a failed
        listing and never silence: the chat models it did list are still
        true, and the page says the decision models are missing."""
        client = http_client(app, MODELS_TIMEOUT, base_url=url, headers=self.headers(row))
        try:
            async with client as c:
                resp = await c.get("/models", params={"output_modalities": DECISIONS})
        except httpx.HTTPError as exc:
            return [], f"its decision models could not be listed — {reason(exc)}"
        if resp.status_code != 200:
            return [], (
                f"its decision models could not be listed "
                f"({resp.status_code}: {refusal_detail(resp)})"
            )
        try:
            rows = normalize_models(resp.json(), owned_by=row["name"])
        except (ValueError, ProviderRefused) as exc:
            return [], f"its decision-model listing was unreadable — {exc}"
        return [
            model
            for model in rows
            if model["id"] not in listed and DECISIONS in (model.get("output_modalities") or [])
        ], None

    async def _listing_is_public(self, app, row: dict) -> tuple[bool | None, str]:
        """(is the listing public?, what decided it).

        Re-asks /models with a key that is certainly wrong (base.wrong_key_probe).
        A 401/403 means the listing REQUIRES the key — so the real key's 200
        was the provider accepting it. A 200 means the listing is public and
        proved nothing about the key. Anything else (429, 5xx, a transport
        error) decides NOTHING: it is returned as None with the words, never
        read as either answer (a rate-limited second call used to paint 'Key
        verified').
        """
        url = base_url_of(row)
        bucket, status, detail = await base.wrong_key_probe(app, row, url, headers_for=self.headers)
        if bucket == "public":
            return True, "the listing answered 200 to a wrong key"
        if bucket == "protected":
            return False, f"the listing refused a wrong key ({status})"
        if status is None:
            return None, f"the wrong-key check could not reach {url}/models — {detail}"
        return None, f"the wrong-key check answered {status} ({detail})"

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
        note = listing.summary()
        if row.get("auth_shape") == "none":
            return VerifyResult(
                listing="available", models=listing.models, note=note, key_proven=None
            )
        if not listing.models:
            return VerifyResult(
                listing="available",
                models=listing.models,
                note=f"{note} — nothing to test the key on; the first chat turn will tell",
                key_proven=None,
            )
        public, decided_by = await self._listing_is_public(app, row)
        if public is False:
            return VerifyResult(
                listing="available",
                models=listing.models,
                note=f"{note}; the listing accepted the key",
                key_proven=True,
            )
        if public is None:
            return VerifyResult(
                listing="available",
                models=listing.models,
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
                models=listing.models,
                note=f"{note}; the listing is public, so the key was proven with a 1-token "
                f"completion on {model}",
                key_proven=True,
            )
        return VerifyResult(
            listing="available",
            models=listing.models,
            note=f"{note}; the listing is public and a 1-token test on {model} answered "
            f"{status} ({words}) — the key is NOT proven; the first chat turn will tell",
            key_proven=False,
        )

    async def completions(
        self, request: Request, row: dict, model: str, body: dict, *, engine: bool = False
    ) -> Response:
        """`engine` is True when an ENGINE's chat rides this adapter (the ollama
        adapter's /v1): a connect-phase failure is then ProviderUnreachable —
        never a wall (D21) — instead of a refusal.

        The cache hints go on here, once, before the call: both retries in
        `_completions` (usage fields refused, credit too low) re-send this
        body, so they keep the session and the markers."""
        url = base_url_of(row)
        if url:
            body = dict(body, model=model) if model else body
            body = cache_hints(body, url, _turn_id(request))
        return await self._completions(request.app, row, model, body, engine=engine)

    async def _completions(
        self,
        app,
        row: dict,
        model: str,
        body: dict,
        *,
        engine: bool = False,
        within_credit: bool = False,
    ) -> Response:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, f"provider {row['name']!r} has no base URL")
        body = dict(body, model=model) if model else dict(body)
        asked_for_usage = False
        if row.get("usage_supported") is not False:
            body, asked_for_usage = inject_usage(body, url)
        client = http_client(app, COMPLETIONS_TIMEOUT, base_url=url, headers=self.headers(row))
        try:
            upstream = await client.send(
                client.build_request("POST", "/chat/completions", json=body), stream=True
            )
        except httpx.HTTPError as exc:
            await client.aclose()
            detail = f"could not reach {row['name']} at {url} — {reason(exc)}"
            if engine and isinstance(exc, CONNECT_PHASE_ERRORS):
                raise ProviderUnreachable(502, detail) from exc
            raise ProviderRefused(502, detail) from exc

        if upstream.status_code != 200:
            content = await upstream.aread()
            headers = forwardable_headers(upstream.headers, exclude=_BUFFERED_EXCLUDE)
            await upstream.aclose()
            await client.aclose()
            if (
                asked_for_usage
                and upstream.status_code == 400
                and row.get("usage_supported") is None
                and _refuses_usage_fields(content)
            ):
                # The provider rejected the usage request itself. Remember
                # that on the row (its calls will be unmetered, said so) and
                # send this one again without it — once, never a loop.
                await _remember_usage_support(row, False)
                return await self._completions(
                    app,
                    dict(row, usage_supported=False),
                    model,
                    strip_usage(body),
                    engine=engine,
                    within_credit=within_credit,
                )
            affords = (
                None if within_credit else _affordable_tokens(upstream.status_code, content, body)
            )
            if affords is not None:
                # Asked again ONCE for the reply the credit covers — never a
                # loop, and never above what the caller itself set.
                logger.warning(
                    "%s: the credit affords %d tokens; asking again within it", row["name"], affords
                )
                return await self._completions(
                    app,
                    row,
                    model,
                    dict(body, max_tokens=affords),
                    engine=engine,
                    within_credit=True,
                )
            return Response(content=content, status_code=upstream.status_code, headers=headers)
        if asked_for_usage and row.get("usage_supported") is None:
            await _remember_usage_support(row, True)

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
