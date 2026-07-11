import asyncio
import logging
import time

import httpx
from fastapi import APIRouter

log = logging.getLogger(__name__)
health_router = APIRouter(prefix="/health", tags=["health"])

# Per-candidate budgets for the provider test probe. Without these a hung
# upstream (NVIDIA NIM completions can stall for minutes) rides litellm's
# 600s default and the dashboard's nginx proxy 504s at 60s instead of the
# probe reporting anything useful. Local gets one generous budget (cold
# model loads are legitimate); cloud gets a short one so trying three
# candidates still finishes under the proxy cap.
_TEST_TIMEOUT_CLOUD = 15.0
_TEST_TIMEOUT_LOCAL = 55.0


@health_router.get("/live")
async def liveness():
    return {"status": "alive"}


@health_router.get("/ready")
async def readiness():
    checks = {}

    # Check Ollama connectivity (informational — not required for readiness)
    import httpx
    from app.registry import get_ollama_base_url
    ollama_url = await get_ollama_base_url()
    try:
        async with httpx.AsyncClient(base_url=ollama_url, timeout=3.0) as c:
            r = await c.get("/api/tags")
            checks["ollama"] = "ok" if r.status_code == 200 else f"http_{r.status_code}"
    except Exception as e:
        checks["ollama"] = f"unreachable: {e}"

    # Check Redis connectivity (required for rate limiting + caching)
    try:
        from app.rate_limiter import _get_redis
        r = await _get_redis()
        await r.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e}"

    # Ollama is optional — only Redis is required for readiness
    redis_ok = checks.get("redis") == "ok"
    return {"status": "ready" if redis_ok else "degraded", "checks": checks}


@health_router.get("/providers")
async def provider_status():
    """Return availability and model count for each configured LLM provider.

    Overlays validated discovery onto the static catalog: `key_status` comes
    from a real provider call (cached ≤5 min), `available` means the provider
    actually answered — a present-but-rejected key shows `invalid_key`, and
    `model_count` prefers the live discovered list over the hardcoded registry.
    """
    from app.discovery import provider_key_statuses
    from app.registry import get_provider_catalog

    catalog = get_provider_catalog()
    try:
        statuses = await provider_key_statuses()
    except Exception:
        statuses = {}

    for entry in catalog:
        disc = statuses.get(entry["slug"])
        if disc is None:
            entry["key_status"] = "unknown"
            entry["key_detail"] = ""
            continue
        entry["key_status"] = disc.key_status
        entry["key_detail"] = disc.detail
        # "configured" (key present / local backend active) stays visible via
        # key_status != "not_configured"; available now means "answers".
        entry["available"] = disc.key_status == "ok"
        if disc.models:
            entry["model_count"] = len(disc.models)
    return catalog


async def _pick_local_test_model() -> str | None:
    """A model to smoke-test the active local backend: prefer one already
    resident (no cold-load), else the first available."""
    info = await inference_loaded()
    loaded = info.get("loaded_models") or []
    if loaded:
        return loaded[0]
    if info.get("backend") == "lmstudio":
        st = await lmstudio_status()
        models = st.get("models") or []
        return models[0] if models else None
    return None


async def _cloud_test_candidates(slug: str, default_model: str) -> list[str]:
    """Models to smoke-test a cloud provider, best-first.

    Static per-provider defaults go stale (OpenRouter retired its
    llama-3.1-8b :free slug), and free-tier models are individually
    rate-limited upstream at any given moment — so test the default plus a
    couple of discovered alternates before calling the provider broken.
    A default that discovery no longer lists is dropped entirely."""
    candidates = [default_model] if default_model else []
    try:
        from app.discovery import provider_key_statuses
        disc = (await provider_key_statuses()).get(slug)
    except Exception:
        return candidates
    if not disc or disc.key_status != "ok" or not disc.models:
        return candidates
    listed = [m.id for m in disc.models]
    if default_model and default_model not in listed:
        candidates = []
    for mid in listed:
        if mid not in candidates:
            candidates.append(mid)
        if len(candidates) >= 3:
            break
    return candidates


@health_router.post("/providers/{slug}/test")
async def test_provider(slug: str):
    """Send a minimal completion to a provider and report latency."""
    from app.registry import (
        get_local_provider,
        get_provider_catalog,
        get_provider_for_slug,
    )
    from nova_contracts import CompleteRequest, Message

    catalog = get_provider_catalog()
    entry = next((p for p in catalog if p["slug"] == slug), None)
    if not entry:
        return {"ok": False, "latency_ms": 0, "error": f"Unknown provider: {slug}"}
    if not entry["available"]:
        return {"ok": False, "latency_ms": 0, "error": "Provider not configured"}

    model = entry["default_model"]
    try:
        # Local providers (LM Studio, Ollama, …) route to the local backend
        # directly — routing by model name sends an LM Studio model named
        # "openai/gpt-oss-20b" to cloud OpenAI, which fails with a key error.
        if entry.get("type") == "local":
            provider = get_local_provider()
            if not model:
                model = await _pick_local_test_model()
            if not model:
                return {"ok": False, "latency_ms": 0,
                        "error": "No model is loaded — load one from the list above, then test."}
            candidates = [model]
        else:
            # Probe the named provider directly — get_provider() applies
            # routing strategy / subscription preference and can silently
            # test a different backend than the one the user clicked.
            provider = get_provider_for_slug(slug)
            if provider is None:
                return {"ok": False, "latency_ms": 0,
                        "error": f"No provider instance for slug: {slug}"}
            candidates = await _cloud_test_candidates(slug, model)
            if not candidates:
                return {"ok": False, "latency_ms": 0,
                        "error": "No models discovered for this provider"}

        timeout = (_TEST_TIMEOUT_LOCAL if entry.get("type") == "local"
                   else _TEST_TIMEOUT_CLOUD)
        last_err: Exception | None = None
        for m in candidates:
            req = CompleteRequest(
                model=m,
                messages=[Message(role="user", content="Say hi")],
                max_tokens=16,
            )
            t0 = time.monotonic()
            try:
                await asyncio.wait_for(provider.complete(req), timeout=timeout)
            except asyncio.TimeoutError:
                last_err = RuntimeError(
                    f"{m} did not answer within {timeout:.0f}s")
                continue
            except Exception as e:
                # An empty completion truncated by our tiny token budget
                # (finish_reason='length' — reasoning models spend it all
                # before any content) still proves the provider answered,
                # which is all this probe measures.
                if "finish_reason='length'" not in str(e):
                    last_err = e
                    continue
            latency = int((time.monotonic() - t0) * 1000)
            return {"ok": True, "latency_ms": latency, "model": m}
        raise last_err if last_err else RuntimeError("no models to test")
    except Exception as e:
        return {"ok": False, "latency_ms": 0, "error": str(e)}


@health_router.get("/providers/ollama/status")
async def ollama_status():
    """Return detailed Ollama health info including WoL state."""
    from app.registry import get_ollama_provider, get_routing_strategy

    ollama = get_ollama_provider()
    strategy = await get_routing_strategy()

    from app.registry import get_ollama_base_url, get_wol_mac
    ollama_url = await get_ollama_base_url()
    wol_mac = await get_wol_mac()

    result = {
        "healthy": await ollama.probe(),
        "base_url": ollama_url,
        "routing_strategy": strategy,
        "wol_configured": bool(wol_mac),
        "gpu_available": False,
    }

    # Detect GPU availability from Ollama's /api/ps (running models show GPU layers)
    # or from /api/tags response details
    try:
        async with httpx.AsyncClient(base_url=ollama_url, timeout=3.0) as c:
            r = await c.get("/api/ps")
            if r.status_code == 200:
                ps_data = r.json()
                for m in ps_data.get("models", []):
                    # size_vram > 0 means GPU is being used
                    if m.get("size_vram", 0) > 0:
                        result["gpu_available"] = True
                        break
    except Exception:
        pass

    if wol_mac:
        import time as _time
        wol_age = _time.monotonic() - ollama._wol_sent_at if ollama._wol_sent_at > 0 else None
        result["wol_last_sent_seconds_ago"] = int(wol_age) if wol_age is not None else None

    return result


@health_router.get("/providers/lmstudio/status")
async def lmstudio_status():
    """Return fresh LM Studio reachability + loaded models.

    LM Studio is a host-side desktop app, not a Nova container, so there's no
    Docker status to report \u2014 this endpoint probes the server directly (via
    host.docker.internal, which the gateway can reach) and returns the loaded
    models. Recovery's backend-status endpoint delegates here because the
    recovery container has no host.docker.internal mapping.
    """
    from app.registry import _lmstudio, _refresh_lmstudio_runtime_url
    url = await _refresh_lmstudio_runtime_url()
    # Force a fresh probe (bypass the 15s health cache) so the dashboard status
    # card reflects the current state, not a stale read.
    _lmstudio._last_health_check = 0.0
    healthy = await _lmstudio.check_health()

    models: list[str] = []
    active_model = None
    if healthy:
        try:
            async with httpx.AsyncClient(timeout=5.0, headers=_lmstudio._extra_headers) as client:
                r = await client.get(f"{url}/v1/models")
                if r.status_code == 200:
                    for m in r.json().get("data", []):
                        if m.get("id"):
                            models.append(m["id"])
                    active_model = models[0] if models else None
        except Exception as e:
            log.debug("LM Studio model probe failed: %s", e)

    return {
        "healthy": healthy,
        "base_url": url,
        "model_count": len(models),
        "active_model": active_model,
        "models": models,
    }


@health_router.get("/inference/loaded")
async def inference_loaded():
    """Which local models are resident in memory RIGHT NOW.

    The truth behind cold-start waits: local backends evict/lazy-load models
    (LM Studio evicts on single-model mode; Ollama unloads after idle), and
    without this the operator can't tell a warming model from a hang.
    Aggregates the ACTIVE backend only. Consumed by the Models page "Loaded"
    badge and the chat cold-model hint (exposed at /v1/health/... for the
    dashboard proxy).
    """
    from app.registry import _get_redis_config, get_ollama_base_url

    backend = await _get_redis_config("inference.backend", "ollama") or "ollama"
    out: dict = {"backend": backend, "healthy": False, "loaded_models": []}

    try:
        if backend == "none":
            out["healthy"] = True  # deliberately no local inference — nothing to load

        elif backend == "lmstudio":
            # /v1/models lists everything downloaded; only /api/v0/models
            # carries per-model state, so filter to actually-resident ones
            # (else every downloaded model wrongly reads "in memory").
            from app.registry import _lmstudio, _refresh_lmstudio_runtime_url
            url = await _refresh_lmstudio_runtime_url()
            _lmstudio._last_health_check = 0.0
            out["healthy"] = await _lmstudio.check_health()
            if out["healthy"]:
                try:
                    async with httpx.AsyncClient(
                        timeout=5.0, headers=_lmstudio._extra_headers
                    ) as c:
                        r = await c.get(f"{url}/api/v0/models")
                    if r.status_code == 200:
                        out["loaded_models"] = [
                            m["id"] for m in r.json().get("data", [])
                            if m.get("state") == "loaded" and m.get("id")
                        ]
                except Exception as e:
                    log.debug("LM Studio loaded-state probe failed: %s", e)

        elif backend == "ollama":
            url = await get_ollama_base_url()
            async with httpx.AsyncClient(base_url=url, timeout=3.0) as c:
                r = await c.get("/api/ps")
            if r.status_code == 200:
                out["healthy"] = True
                out["loaded_models"] = [
                    m["name"] for m in r.json().get("models", []) if m.get("name")
                ]

        else:
            # vllm / sglang / llamacpp / custom: single-model OpenAI-compatible
            # servers — if the server answers, its served model IS loaded.
            url = await _get_redis_config("inference.url", "")
            if url:
                async with httpx.AsyncClient(base_url=url, timeout=3.0) as c:
                    r = await c.get("/v1/models")
                if r.status_code == 200:
                    out["healthy"] = True
                    out["loaded_models"] = [
                        m["id"] for m in r.json().get("data", []) if m.get("id")
                    ]
    except Exception as e:
        log.debug("inference/loaded probe failed for %s: %s", backend, e)

    return out


@health_router.get("/inflight")
async def health_inflight():
    """Return count of in-flight requests to local inference backends."""
    from app.router import get_local_inflight
    return {"local_inflight": get_local_inflight()}


@health_router.get("/startup")
async def startup():
    return {"status": "started"}
