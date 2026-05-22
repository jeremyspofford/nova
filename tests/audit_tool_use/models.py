"""Discover usable models from llm-gateway.

The live /providers response shape (verified 2026-05-22 against agent-core):

    {"providers": [
        {"name": "ollama-host", "model": "qwen2.5-coder:7b", "available": true, "local": true, ...},
        {"name": "openai", "model": "gpt-4o-mini", "available": true, ...},
        ...
    ], "routing_strategy": "...", ...}

Each provider exposes ONE model (its default), not a list. The key is `name`, not `id`.
"""
from __future__ import annotations
import httpx


def filter_available_models(providers_payload: dict) -> list[dict]:
    """Given GET /providers response, return list of {provider_id, model_id} for usable providers."""
    result = []
    for p in providers_payload.get("providers", []):
        if not p.get("available"):
            continue
        # Real shape: each provider has a single `model` field (its configured default).
        model = p.get("model")
        if not model:
            continue
        result.append({
            "provider_id": p.get("name", "unknown"),
            "model_id": model,
            "local": bool(p.get("local")),
        })
    return result


async def discover_models(llm_gateway_url: str = "http://localhost:8001") -> list[dict]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(f"{llm_gateway_url}/providers")
        r.raise_for_status()
    return filter_available_models(r.json())
