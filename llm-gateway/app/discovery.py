"""Dynamic model discovery — queries active local backend for available models.

Results are cached in-memory (5 min TTL on success, 30s on failure) to avoid
hammering backends on every chat open.  Pass force=True to bypass the cache.
"""
from __future__ import annotations

import logging
import time

import httpx

from .config import settings

logger = logging.getLogger(__name__)

_CACHE_TTL = 300.0       # 5 min — successful discovery
_FAIL_CACHE_TTL = 30.0   # 30 s  — backend unreachable, retry quickly
_TIMEOUT = 5.0           # per-request timeout to local backend

_local_cache: list[dict] | None = None
_local_cache_time: float = 0.0
_local_cache_failed: bool = False


async def discover_local_models(force: bool = False) -> list[dict]:
    """Return [{id, registered: True}, ...] for the active local backend.

    Queries:
      - ollama / ollama-host  →  GET {url}/api/tags
      - vllm / llamacpp / sglang / lmstudio  →  GET {url}/v1/models  (OpenAI-compat)

    Returns empty list if the backend is 'none' or unreachable.
    """
    global _local_cache, _local_cache_time, _local_cache_failed

    now = time.monotonic()
    ttl = _FAIL_CACHE_TTL if _local_cache_failed else _CACHE_TTL
    if not force and _local_cache is not None and (now - _local_cache_time) < ttl:
        return _local_cache

    backend = settings.nova_inference_backend
    url = settings.local_inference_url

    if backend == "none":
        _local_cache = []
        _local_cache_time = now
        _local_cache_failed = False
        return []

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            if backend in ("ollama-host", "ollama"):
                resp = await client.get(f"{url}/api/tags")
                resp.raise_for_status()
                data = resp.json()
                models = [
                    {"id": m["name"].removesuffix(":latest"), "registered": True}
                    for m in data.get("models", [])
                ]
            else:
                # vllm, llamacpp, sglang, lmstudio — OpenAI-compatible /v1/models
                resp = await client.get(f"{url}/v1/models")
                resp.raise_for_status()
                data = resp.json()
                models = [{"id": m["id"], "registered": True} for m in data.get("data", [])]

        _local_cache = models
        _local_cache_time = now
        _local_cache_failed = False
        logger.debug("Discovered %d models from %s (%s)", len(models), backend, url)
        return models

    except Exception as exc:
        logger.debug("Local model discovery failed (%s at %s): %s", backend, url, exc)
        _local_cache = []
        _local_cache_time = now
        _local_cache_failed = True
        return []


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


def _local_provider_entry(models: list[dict]) -> dict:
    """Build the provider entry for the active local backend."""
    backend = settings.nova_inference_backend
    url = settings.local_inference_url

    name_map = {
        "ollama-host": "Ollama (Host)",
        "ollama": "Ollama",
        "llamacpp": "llama.cpp",
        "vllm": "vLLM",
        "sglang": "SGLang",
        "lmstudio": "LM Studio",
    }

    return {
        "slug": backend,
        "name": name_map.get(backend, backend),
        "type": "local",
        "available": len(models) > 0,
        "auth_methods": [f"Local inference at {url}"],
        "models": models,
    }
