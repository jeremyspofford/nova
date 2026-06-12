"""Dynamic model discovery — queries inference endpoints for available models.

Results are cached per endpoint (5 min TTL on success, 30s on failure) to avoid
hammering backends on every chat open.  Pass force=True to bypass the cache.
"""
from __future__ import annotations

import logging
import time

import httpx

from . import endpoints as ep_mod
from .config import settings

logger = logging.getLogger(__name__)

_CACHE_TTL = 300.0       # 5 min — successful discovery
_FAIL_CACHE_TTL = 30.0   # 30 s  — backend unreachable, retry quickly
_TIMEOUT = 5.0           # per-request timeout to local backend

# endpoint id -> (time, models, failed)
_caches: dict[str, tuple[float, list[dict], bool]] = {}


async def discover_endpoint_models(ep: dict, force: bool = False) -> list[dict]:
    """Return [{id, registered: True}, ...] for one endpoint. Empty if unreachable.

    Queries:
      - ollama / ollama-host  →  GET {url}/api/tags
      - vllm / llamacpp / sglang / lmstudio  →  GET {url}/v1/models  (OpenAI-compat)
    """
    eid = ep["id"]
    now = time.monotonic()
    cached = _caches.get(eid)
    if not force and cached is not None:
        ttl = _FAIL_CACHE_TTL if cached[2] else _CACHE_TTL
        if (now - cached[0]) < ttl:
            return cached[1]

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            if ep["engine"] in ("ollama-host", "ollama"):
                resp = await client.get(f"{ep['url']}/api/tags")
                resp.raise_for_status()
                data = resp.json()
                models = [
                    {"id": m["name"].removesuffix(":latest"), "registered": True}
                    for m in data.get("models", [])
                ]
            else:
                resp = await client.get(f"{ep['url']}/v1/models")
                resp.raise_for_status()
                data = resp.json()
                models = [{"id": m["id"], "registered": True} for m in data.get("data", [])]

        _caches[eid] = (now, models, False)
        logger.debug("Discovered %d models from endpoint %s (%s)", len(models), eid, ep["url"])
        return models

    except Exception as exc:
        logger.debug("Discovery failed for endpoint %s (%s): %s", eid, ep["url"], exc)
        _caches[eid] = (now, [], True)
        return []


def invalidate(endpoint_id: str | None = None) -> None:
    """Drop discovery cache (one endpoint, or all) — after pulls/deletes."""
    if endpoint_id is None:
        _caches.clear()
    else:
        _caches.pop(endpoint_id, None)


async def discover_local_models(force: bool = False) -> list[dict]:
    """Back-compat: models on the default endpoint."""
    ep = ep_mod.get("default")
    if ep is None or not ep["enabled"]:
        return []
    return await discover_endpoint_models(ep, force=force)


async def discover_all_endpoints(force: bool = False) -> list[tuple[dict, list[dict]]]:
    """(endpoint, models) for every enabled endpoint, file order."""
    out = []
    for ep in ep_mod.list_endpoints():
        if not ep["enabled"]:
            continue
        out.append((ep, await discover_endpoint_models(ep, force=force)))
    return out


def _cloud_providers(available_cloud: set[str]) -> list[dict]:
    """Return provider entries for configured cloud API keys."""
    providers = []

    if "anthropic" in available_cloud:
        providers.append({
            "slug": "anthropic",
            "name": "Anthropic",
            "type": "paid",
            "available": True,
            "auth_methods": ["ANTHROPIC_API_KEY"],
            "models": [
                {"id": "claude-opus-4-7", "registered": True},
                {"id": "claude-sonnet-4-6", "registered": True},
                {"id": "claude-haiku-4-5-20251001", "registered": True},
            ],
        })
    else:
        providers.append({
            "slug": "anthropic", "name": "Anthropic", "type": "paid",
            "available": False, "auth_methods": ["ANTHROPIC_API_KEY"], "models": [],
        })

    if "openai" in available_cloud:
        providers.append({
            "slug": "openai",
            "name": "OpenAI",
            "type": "paid",
            "available": True,
            "auth_methods": ["OPENAI_API_KEY"],
            "models": [
                {"id": "gpt-4o", "registered": True},
                {"id": "gpt-4o-mini", "registered": True},
            ],
        })
    else:
        providers.append({
            "slug": "openai", "name": "OpenAI", "type": "paid",
            "available": False, "auth_methods": ["OPENAI_API_KEY"], "models": [],
        })

    if "gemini" in available_cloud:
        providers.append({
            "slug": "gemini",
            "name": "Google Gemini",
            "type": "paid",
            "available": True,
            "auth_methods": ["GEMINI_API_KEY"],
            "models": [
                {"id": "gemini/gemini-2.0-flash", "registered": True},
                {"id": "gemini/gemini-2.5-flash", "registered": True},
                {"id": "gemini/gemini-1.5-pro", "registered": True},
            ],
        })
    else:
        providers.append({
            "slug": "gemini", "name": "Google Gemini", "type": "paid",
            "available": False, "auth_methods": ["GEMINI_API_KEY"], "models": [],
        })

    if "groq" in available_cloud:
        providers.append({
            "slug": "groq",
            "name": "Groq",
            "type": "free",
            "available": True,
            "auth_methods": ["GROQ_API_KEY"],
            "models": [
                {"id": "groq/llama-3.3-70b-versatile", "registered": True},
                {"id": "groq/llama3-8b-8192", "registered": True},
            ],
        })
    else:
        providers.append({
            "slug": "groq", "name": "Groq", "type": "free",
            "available": False, "auth_methods": ["GROQ_API_KEY"], "models": [],
        })

    return providers


def _local_provider_entry(models: list[dict], ep: dict | None = None) -> dict:
    """Build the provider entry for a local endpoint.

    The default endpoint keeps the legacy slug (the backend name) so existing
    dashboard/tests see an unchanged shape; additional endpoints use their id.
    """
    name_map = {
        "ollama-host": "Ollama (Host)",
        "ollama": "Ollama",
        "llamacpp": "llama.cpp",
        "vllm": "vLLM",
        "sglang": "SGLang",
        "lmstudio": "LM Studio",
    }

    if ep is None or ep["id"] == "default":
        backend = settings.nova_inference_backend
        url = ep["url"] if ep else settings.local_inference_url
        slug = backend
        name = name_map.get(backend, backend)
    else:
        slug = ep["id"]
        name = f"{ep['name']} ({name_map.get(ep['engine'], ep['engine'])})"
        url = ep["url"]

    return {
        "slug": slug,
        "name": name,
        "type": "local",
        "available": len(models) > 0,
        "auth_methods": [f"Local inference at {url}"],
        "models": models,
    }
