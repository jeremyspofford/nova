"""The builtin ollama adapter: OpenAI-shaped chat at OLLAMA_URL/v1, and
ollama's own /api/tags for the listing (its /v1/models exists too, but
/api/tags is what carries the local truth S10a will read — one path), plus
/api/show for what ollama knows about each installed model.

Live shapes, verified 2026-09-06:

  GET /api/tags   rows {name, model, modified_at, size (bytes), digest,
                  details{parent_model, format, family, families,
                  parameter_size ("8.2B"), quantization_level ("Q4_K_M"),
                  context_length, embedding_length}}
  POST /api/show  {"model": name} → {capabilities: [completion | tools |
                  insert | vision | embedding | thinking | image | audio],
                  details (as above), model_info: a flat GGUF key/value
                  map — general.architecture, general.parameter_count
                  (int), "<architecture>.context_length" (the key is
                  namespaced by general.architecture) — license (text),
                  modelfile, template, parameters}
"""
from __future__ import annotations

import asyncio
import copy
import re
from datetime import UTC, datetime

import httpx
from fastapi import Request
from starlette.responses import Response

from app.adapters import openai_chat
from app.adapters.base import (
    MODELS_TIMEOUT,
    Listing,
    ProviderRefused,
    VerifyResult,
    http_client,
    positive_int,
    reason,
    refusal_detail,
)
from app.cache import TTLCache
from app.providers import base_url_of

# ollama's /api/show `capabilities` enum (2026-09-06). The list on a row is
# a manifest of what the model HAS; a value missing from it is not stated,
# never a denial — so the reader below emits an entry per listed value and
# nothing for the rest.
SHOW_CAPABILITIES = (
    "completion",
    "tools",
    "insert",
    "vision",
    "embedding",
    "thinking",
    "image",
    "audio",
)
SHOW_SOURCE = "ollama-show"
# At most this many /api/show calls in flight per listing: a host with
# forty tags must not open forty connections to the server that is also
# serving its chat.
SHOW_CONCURRENCY = 4
# /api/show answers keyed by the /api/tags digest. The digest names the
# CONTENT, so the same digest is the same model and a re-pull produces a
# new digest — invalidation by construction, with no clock to be wrong
# about; hence no TTL. Bounded so a long-lived gateway stays bounded.
SHOW_CACHE = TTLCache(ttl_s=None, max_entries=1024)

_PARAMETER_SIZE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([KMBT])\s*$", re.IGNORECASE)
_SCALE_TO_BILLIONS = {"K": 1e-6, "M": 1e-3, "B": 1.0, "T": 1e3}
_LICENSE_LINE_CAP = 200


def tags_to_models(tags: dict) -> list[dict]:
    """Ollama's /api/tags rows mapped onto the one listing shape. Only what
    the row states: a missing size, digest or context length stays absent."""
    models = []
    for entry in tags.get("models") or []:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name") or entry.get("model")
        if not name:
            continue
        row: dict = {"id": name, "owned_by": "ollama"}
        size = entry.get("size")
        if isinstance(size, int | float) and size > 0:
            row["size_bytes"] = int(size)
        details = entry.get("details")
        if isinstance(details, dict):
            for key in ("family", "parameter_size", "quantization_level"):
                if details.get(key):
                    row[key] = details[key]
        for key in ("digest", "modified_at"):
            value = entry.get(key)
            if isinstance(value, str) and value:
                row[key] = value
        if isinstance(details, dict):
            context = positive_int(details.get("context_length"))
            if context is not None:
                row["context_length"] = context
        models.append(row)
    return models


async def show(app, base_url: str, name: str) -> dict:
    """POST /api/show for one installed model: ollama's own facts about it.
    Anything but a 200 JSON object is a ProviderRefused carrying ollama's
    status and words (a 404 `model 'x' not found` is the common one) —
    never an empty dict that would read downstream as "states nothing"."""
    client = http_client(app, MODELS_TIMEOUT, base_url=base_url)
    try:
        async with client as c:
            resp = await c.post("/api/show", json={"model": name})
    except httpx.HTTPError as exc:
        raise ProviderRefused(
            502, f"could not reach ollama at {base_url} — {reason(exc)}"
        ) from exc
    if resp.status_code != 200:
        raise ProviderRefused(resp.status_code, refusal_detail(resp))
    try:
        body = resp.json()
    except ValueError as exc:
        raise ProviderRefused(
            502, f"ollama returned a non-JSON /api/show response for {name!r}: {exc}"
        ) from exc
    if not isinstance(body, dict):
        raise ProviderRefused(
            502, f"ollama's /api/show response for {name!r} was not a JSON object"
        )
    return body


def _declared(value: object) -> dict:
    return {"value": value, "basis": "declared", "source": SHOW_SOURCE}


def _params_b(model_info: dict, details: dict) -> float | None:
    """Billions of parameters: the exact GGUF count when stated, else the
    rounded label ollama prints ("8.2B", "494.03M")."""
    count = model_info.get("general.parameter_count")
    if isinstance(count, int | float) and not isinstance(count, bool) and count > 0:
        return round(count / 1e9, 2)
    label = details.get("parameter_size")
    if isinstance(label, str):
        match = _PARAMETER_SIZE.match(label)
        if match:
            return round(float(match.group(1)) * _SCALE_TO_BILLIONS[match.group(2).upper()], 2)
    return None


def _context_length(model_info: dict) -> int | None:
    """`<general.architecture>.context_length` first — the key is namespaced
    by the architecture — else the first key that ends in `.context_length`
    (a model_info with no architecture line still states its context)."""
    candidates: list[str] = []
    architecture = model_info.get("general.architecture")
    if isinstance(architecture, str) and architecture:
        candidates.append(f"{architecture}.context_length")
    candidates.extend(k for k in model_info if isinstance(k, str) and k.endswith(".context_length"))
    for key in candidates:
        value = positive_int(model_info.get(key))
        if value is not None:
            return value
    return None


def _first_line(text: object) -> str | None:
    if not isinstance(text, str):
        return None
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line[:_LICENSE_LINE_CAP]
    return None


def show_to_facts(show: dict) -> tuple[dict, dict]:
    """(facts, capabilities) in the catalogue's fact shape from one /api/show
    body. Every entry is `declared` by `ollama-show`; a fact ollama did not
    state (an empty parent_model, a missing licence, an unparsable size) is
    ABSENT — never null, never zero."""
    details = show.get("details")
    details = details if isinstance(details, dict) else {}
    model_info = show.get("model_info")
    model_info = model_info if isinstance(model_info, dict) else {}

    facts: dict = {}
    params = _params_b(model_info, details)
    if params is not None:
        facts["params_b"] = _declared(params)
    for fact, key in (
        ("quant", "quantization_level"),
        ("family", "family"),
        ("parent_model", "parent_model"),
    ):
        value = details.get(key)
        if isinstance(value, str) and value.strip():
            facts[fact] = _declared(value.strip())
    context = _context_length(model_info)
    if context is not None:
        facts["context_length"] = _declared(context)
    license_line = _first_line(show.get("license"))
    if license_line:
        facts["license"] = _declared(license_line)

    capabilities: dict = {}
    listed = show.get("capabilities")
    if isinstance(listed, list):
        for value in listed:
            if isinstance(value, str) and value.strip():
                capabilities[value.strip()] = _declared(True)
    return facts, capabilities


def _now_iso() -> str:
    return datetime.now(UTC).isoformat()


async def facts_for_installed(app, base_url: str, rows: list[dict]) -> dict[str, dict]:
    """/api/show facts for every listed model, keyed by name: each gets
    `{facts, capabilities, fetched_at, cached, note}`.

    Rows are /api/tags rows as `tags_to_models` shapes them (`id`, `digest`);
    a raw ollama row (`name`/`model`) is read the same way. The fan-out runs
    at most SHOW_CONCURRENCY shows at once. Answers are cached under the
    row's digest (see SHOW_CACHE): a hit is handed back with its ORIGINAL
    `fetched_at` and `cached: true`; a row with no digest is fetched every
    time and never cached (nothing to address it by). One failing show is
    a `note` on that name in ollama's words with empty facts — never a
    raise that takes the whole listing down — and is not cached, because a
    refusal is not a fact about the content.
    """
    semaphore = asyncio.Semaphore(SHOW_CONCURRENCY)

    async def one(name: str, digest: str | None) -> tuple[str, dict]:
        if digest is not None:
            hit = SHOW_CACHE.get(digest)
            if hit is not None:
                (facts, capabilities), fetched_at = hit
                return name, {
                    # A copy, so no caller can edit the cached answer.
                    "facts": copy.deepcopy(facts),
                    "capabilities": copy.deepcopy(capabilities),
                    "fetched_at": fetched_at,
                    "cached": True,
                    "note": None,
                }
        async with semaphore:
            try:
                body = await show(app, base_url, name)
            except ProviderRefused as exc:
                return name, {
                    "facts": {},
                    "capabilities": {},
                    "fetched_at": _now_iso(),
                    "cached": False,
                    "note": exc.detail,
                }
        facts, capabilities = show_to_facts(body)
        if digest is not None:
            fetched_at = SHOW_CACHE.put(digest, (facts, capabilities))
        else:
            fetched_at = _now_iso()
        return name, {
            "facts": copy.deepcopy(facts),
            "capabilities": copy.deepcopy(capabilities),
            "fetched_at": fetched_at,
            "cached": False,
            "note": None,
        }

    jobs = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = row.get("id") or row.get("name") or row.get("model")
        if not isinstance(name, str) or not name:
            continue
        digest = row.get("digest")
        jobs.append(one(name, digest if isinstance(digest, str) and digest else None))
    return dict(await asyncio.gather(*jobs))


class Ollama:
    name = "ollama"

    def headers(self, row: dict) -> dict[str, str]:
        return {}

    async def list_models(self, app, row: dict) -> Listing:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, "OLLAMA_URL is unset — cannot reach ollama")
        client = http_client(app, MODELS_TIMEOUT, base_url=url)
        try:
            async with client as c:
                resp = await c.get("/api/tags")
        except httpx.HTTPError as exc:
            raise ProviderRefused(502, f"could not reach ollama at {url} — {reason(exc)}") from exc
        if resp.status_code != 200:
            raise ProviderRefused(resp.status_code, refusal_detail(resp))
        try:
            tags = resp.json()
        except ValueError as exc:
            raise ProviderRefused(
                502, f"ollama returned a non-JSON /api/tags response: {exc}"
            ) from exc
        return Listing(source=row["name"], models=tags_to_models(tags))

    async def verify(self, app, row: dict) -> VerifyResult:
        url = base_url_of(row)
        if not url:
            raise ProviderRefused(502, "OLLAMA_URL is unset — cannot verify the ollama backend")
        client = http_client(app, MODELS_TIMEOUT, base_url=url)
        try:
            async with client as c:
                resp = await c.get("/api/version")
                resp.raise_for_status()
        except httpx.HTTPError as exc:
            raise ProviderRefused(
                502, f"could not verify the ollama backend is live — {reason(exc)}"
            ) from exc
        return VerifyResult(
            listing="available", note="ollama answered /api/version", key_proven=None
        )

    async def completions(self, request: Request, row: dict, model: str, body: dict) -> Response:
        # Chat rides ollama's OpenAI-compatible surface at {OLLAMA_URL}/v1.
        if not base_url_of(row):
            raise ProviderRefused(502, "OLLAMA_URL is unset — cannot reach ollama")
        chat_row = dict(
            row, adapter="openai-chat", base_url=f"{base_url_of(row)}/v1", auth_shape="none"
        )
        return await openai_chat.ADAPTER.completions(request, chat_row, model, body)


ADAPTER = Ollama()
