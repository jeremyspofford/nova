"""Available-models catalog — feeds model dropdowns in the UI.

Combines installed Ollama models (local truth) with the catalog of every
configured provider in the registry (`llm/providers.py`). Cached 5 minutes;
each source fails soft so an offline local-only user still gets their Ollama
list.
"""

import logging
import time

import httpx

from app import settings_store

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


def _price_per_million(v) -> float | None:
    """OpenAI-compat pricing is per-token as a string; show it per-million."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return round(f * 1_000_000, 2) if f > 0 else None


def _model_meta(m: dict) -> dict:
    """The provider's OWN 'what is this good for' facts, when it supplies them.

    This is the honest source for catalog models we have no curated row for:
    the provider's description, context window, input modalities (vision), and
    price — surfaced verbatim, never invented. Providers whose /models endpoint
    returns only ids (most OpenAI-compat servers) yield an empty dict. OpenRouter
    is the rich case.
    """
    meta: dict = {}
    desc = (m.get("description") or "").strip()
    if desc:
        meta["description"] = desc[:500]
    ctx = m.get("context_length") or (m.get("top_provider") or {}).get("context_length")
    if isinstance(ctx, int) and ctx > 0:
        meta["context_length"] = ctx
    arch = m.get("architecture") or {}
    mods = arch.get("input_modalities") or []
    if "image" in mods or "image" in (arch.get("modality") or ""):
        meta["vision"] = True
    pricing = m.get("pricing") or {}
    pin = _price_per_million(pricing.get("prompt"))
    pout = _price_per_million(pricing.get("completion"))
    if pin is not None:
        meta["price_in"] = pin
    if pout is not None:
        meta["price_out"] = pout
    return meta


async def _provider_models() -> list[dict]:
    """Every configured registry provider's catalog, as `slug:id` entries.

    Auth gate per provider: an unconfigured provider (no key, or disabled)
    contributes nothing. One provider failing — offline, or no /models endpoint
    — never sinks the rest; it just logs and yields nothing. Providers with an
    empty catalog_path can't list, so the operator approves their models by id.
    Each entry carries whatever `_model_meta` the provider supplied (description,
    context window, vision, price) so the full-catalog browser can say what a
    model is good for, not just its name.
    """
    from app.llm import providers
    out: list[dict] = []
    for slug in sorted(providers.known_slugs()):
        row = providers.get(slug)
        if not row or not row["catalog_path"] or not providers.is_configured(slug):
            continue
        headers = dict(row["extra_headers"])
        key = providers.resolve_key(row)
        if key:
            headers["Authorization"] = f"Bearer {key}"
        url = f"{row['base_url'].rstrip('/')}{row['catalog_path']}"
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                resp = await client.get(url, headers=headers)
                resp.raise_for_status()
            models = [{"id": f"{slug}:{m['id']}", "provider": slug, "name": m["id"],
                       **_model_meta(m)}
                      for m in resp.json().get("data", []) if m.get("id")]
            models.sort(key=lambda m: m["name"])
            out.extend(models)
        except Exception as e:
            log.warning("provider '%s' model list unavailable: %s", slug, e)
    return out


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
        provider_models = await _provider_models()
        models = ollama + provider_models
        if models:
            _cache.update(at=time.monotonic(), models=models)
    if full:
        return models
    from app import curated_models
    curated = await curated_models.list_all(enabled_only=True)
    approved_cloud = {r["model"] for r in curated if r["provider"] != "ollama"}
    return [m for m in models
            if m["provider"] == "ollama" or m["id"] in approved_cloud]
