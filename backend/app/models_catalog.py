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
    # Auth gate: no key = no access = the models don't exist for this
    # install. (Same rule for every future provider: unauthenticated
    # providers contribute nothing to any catalog view.)
    if not settings.has_openrouter():
        return []
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


def invalidate():
    _cache["at"] = 0.0


# ── background pulls (only Ollama exposes a pull API; LM Studio / llama.cpp
#    / vLLM manage their own downloads — future named-endpoint backends will
#    surface as list-only) ─────────────────────────────────────────────────

_active_pulls: set[str] = set()


def active_pulls() -> list[str]:
    return sorted(_active_pulls)


async def start_pull(name: str) -> str:
    """Kick off a background Ollama pull. Returns a status string immediately."""
    import asyncio

    if name in _active_pulls:
        return f"'{name}' is already being pulled."
    base = str(settings_store.get("inference.ollama_url")).rstrip("/")
    _active_pulls.add(name)

    async def run():
        from app.memory.memory import memory
        try:
            last_status = ""
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", f"{base}/api/pull",
                                         json={"name": name}) as resp:
                    if resp.status_code != 200:
                        detail = (await resp.aread()).decode(errors="replace")[:200]
                        log.warning("model pull '%s' failed: %s", name, detail)
                        return
                    async for line in resp.aiter_lines():
                        if line.strip():
                            last_status = line
            if '"success"' in last_status:
                invalidate()
                log.info("model pull complete: %s", name)
                await memory.write(
                    f"Pulled new local model '{name}' — now available for agents.",
                    type="journal", source_type="tool")
            else:
                log.warning("model pull '%s' ended without success: %.200s",
                            name, last_status)
        except Exception:
            log.exception("model pull '%s' crashed", name)
        finally:
            _active_pulls.discard(name)

    asyncio.ensure_future(run())
    return (f"Pull of '{name}' started in the background. It will appear in "
            f"list_models when complete (check back in a bit — larger models "
            f"take minutes).")


async def list_models(force: bool = False, full: bool = False) -> list[dict]:
    """The models this install can actually use.

    Default (filtered) view = what dropdowns should offer: models INSTALLED
    on running local backends + cloud models the operator has approved (the
    enabled curated rows). full=True = everything served by authenticated
    providers — the validity universe for the pin guard and for operators
    who ask to see the whole catalog. Either way, unauthenticated providers
    contribute nothing.
    """
    if not force and time.monotonic() - _cache["at"] < _CACHE_TTL and _cache["models"]:
        models = _cache["models"]
    else:
        ollama = await _ollama_models()
        openrouter = await _openrouter_models()
        models = ollama + openrouter
        if models:
            _cache.update(at=time.monotonic(), models=models)
    if full:
        return models
    from app import curated_models
    curated = await curated_models.list_all(enabled_only=True)
    approved_cloud = {r["model"] for r in curated if r["provider"] != "ollama"}
    return [m for m in models
            if m["provider"] == "ollama" or m["id"] in approved_cloud]
