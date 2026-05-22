"""Discover usable models from llm-gateway."""
from __future__ import annotations
import httpx


def filter_available_models(providers_payload: dict) -> list[dict]:
    """Given GET /providers response, return list of {provider_id, model_id} for usable models."""
    result = []
    for p in providers_payload.get("providers", []):
        if not p.get("available"):
            continue
        for m in p.get("models", []) or []:
            result.append({"provider_id": p["id"], "model_id": m})
    return result


async def discover_models(llm_gateway_url: str = "http://localhost:8001") -> list[dict]:
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(f"{llm_gateway_url}/providers")
        r.raise_for_status()
    return filter_available_models(r.json())
