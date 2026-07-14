"""Available-models catalog — feeds model dropdowns in the UI.

Combines installed Ollama models (local truth) with the OpenRouter catalog
(public endpoint, keyless). Cached 5 minutes; each source fails soft so an
offline local-only user still gets their Ollama list.
"""

import logging
import time

import httpx

from app import settings_store
from app.config import settings

log = logging.getLogger(__name__)

_CACHE_TTL = 300
_cache: dict = {"at": 0.0, "models": []}


async def _ollama_models() -> list[dict]:
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{base}/api/tags")
            resp.raise_for_status()
        return [{"id": f"ollama:{m['name']}", "provider": "ollama",
                 "name": m["name"]}
                for m in resp.json().get("models", [])]
    except Exception as e:
        log.warning("ollama model list unavailable: %s", e)
        return []


async def _openrouter_models() -> list[dict]:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{settings.openrouter_base_url}/models")
            resp.raise_for_status()
        models = [{"id": f"openrouter:{m['id']}", "provider": "openrouter",
                   "name": m["id"]}
                  for m in resp.json().get("data", [])]
        models.sort(key=lambda m: m["name"])
        return models
    except Exception as e:
        log.warning("openrouter model list unavailable: %s", e)
        return []


async def list_models(force: bool = False) -> list[dict]:
    if not force and time.monotonic() - _cache["at"] < _CACHE_TTL and _cache["models"]:
        return _cache["models"]
    ollama = await _ollama_models()
    openrouter = await _openrouter_models()
    models = ollama + openrouter
    if models:
        _cache.update(at=time.monotonic(), models=models)
    return models
