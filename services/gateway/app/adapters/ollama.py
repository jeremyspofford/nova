"""The builtin ollama adapter: OpenAI-shaped chat at OLLAMA_URL/v1, and
ollama's own /api/tags for the listing (its /v1/models exists too, but
/api/tags is what carries the local truth S10a will read — one path).
"""
from __future__ import annotations

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
    reason,
    refusal_detail,
)
from app.providers import base_url_of


def tags_to_models(tags: dict) -> list[dict]:
    """Ollama's /api/tags rows mapped onto the one listing shape."""
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
        models.append(row)
    return models


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
