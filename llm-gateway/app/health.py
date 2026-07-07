import logging
import time

import httpx
from fastapi import APIRouter

log = logging.getLogger(__name__)
health_router = APIRouter(prefix="/health", tags=["health"])


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
    """Return availability and model count for each configured LLM provider."""
    from app.registry import get_provider_catalog
    return get_provider_catalog()


@health_router.post("/providers/{slug}/test")
async def test_provider(slug: str):
    """Send a minimal completion to a provider and report latency."""
    from app.registry import get_provider, get_provider_catalog
    from nova_contracts import CompleteRequest, Message

    catalog = get_provider_catalog()
    entry = next((p for p in catalog if p["slug"] == slug), None)
    if not entry:
        return {"ok": False, "latency_ms": 0, "error": f"Unknown provider: {slug}"}
    if not entry["available"]:
        return {"ok": False, "latency_ms": 0, "error": "Provider not configured"}

    model = entry["default_model"]
    try:
        provider = await get_provider(model)
        req = CompleteRequest(
            model=model,
            messages=[Message(role="user", content="Say hi")],
            max_tokens=5,
        )
        t0 = time.monotonic()
        await provider.complete(req)
        latency = int((time.monotonic() - t0) * 1000)
        return {"ok": True, "latency_ms": latency}
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
        "healthy": ollama.healthy,
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
            st = await lmstudio_status()
            out["healthy"] = bool(st.get("healthy"))
            out["loaded_models"] = st.get("models", [])

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
