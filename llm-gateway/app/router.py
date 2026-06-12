import json
import logging
import time
from typing import Any

import httpx
import litellm
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from nova_contracts import EmbedRequest, LLMRequest
from pydantic import BaseModel

from . import council, hardware, secrets_client, selector, wol
from . import endpoints as ep_mod
from .config import settings
from .discovery import (
    _cloud_providers,
    _local_provider_entry,
    discover_all_endpoints,
    discover_endpoint_models,
    invalidate,
)
from .manifest import get_manifest
from .selector import VALID_STRATEGIES

logger = logging.getLogger(__name__)
router = APIRouter(tags=["llm"])

litellm.suppress_debug_info = True

# JSON Schema keywords unsupported by Gemini's function declaration format.
_GEMINI_UNSUPPORTED_SCHEMA_KEYS = frozenset({
    "propertyNames", "additionalProperties", "unevaluatedProperties",
    "patternProperties", "$schema", "$id", "$ref", "if", "then", "else",
    "allOf", "anyOf", "oneOf", "not",
})


def _sanitize_schema(schema: Any) -> Any:
    """Recursively strip JSON Schema keywords Gemini doesn't accept."""
    if isinstance(schema, dict):
        return {
            k: _sanitize_schema(v)
            for k, v in schema.items()
            if k not in _GEMINI_UNSUPPORTED_SCHEMA_KEYS
        }
    if isinstance(schema, list):
        return [_sanitize_schema(item) for item in schema]
    return schema


def _sanitize_tools_for_gemini(tools: list) -> list:
    sanitized = []
    for tool in tools:
        if not isinstance(tool, dict):
            sanitized.append(tool)
            continue
        t = dict(tool)
        if "function" in t and isinstance(t["function"], dict):
            fn = dict(t["function"])
            if "parameters" in fn:
                fn["parameters"] = _sanitize_schema(fn["parameters"])
            t["function"] = fn
        sanitized.append(t)
    return sanitized


_cloud_cache: set[str] | None = None
_cloud_cache_time: float = 0.0
_CLOUD_CACHE_TTL = 60.0  # seconds


async def _available_cloud() -> set[str]:
    global _cloud_cache, _cloud_cache_time
    now = time.monotonic()
    if _cloud_cache is None or (now - _cloud_cache_time) > _CLOUD_CACHE_TTL:
        probed: set[str] = set()
        if await secrets_client.resolve("anthropic_api_key"):
            probed.add("anthropic")
        if await secrets_client.resolve("openai_api_key"):
            probed.add("openai")
        if await secrets_client.resolve("gemini_api_key"):
            probed.add("gemini")
        if await secrets_client.resolve("groq_api_key"):
            probed.add("groq")
        _cloud_cache = probed
        _cloud_cache_time = now
    return _cloud_cache


async def _api_key_for(model: str) -> str | None:
    if model.startswith("claude") or "anthropic" in model:
        return await secrets_client.resolve("anthropic_api_key")
    if model.startswith(("gpt", "text-embedding")):
        return await secrets_client.resolve("openai_api_key")
    if "gemini" in model:
        return await secrets_client.resolve("gemini_api_key")
    if model.startswith("groq/"):
        return await secrets_client.resolve("groq_api_key")
    # Local backends (ollama_chat/, openai/ with local api_base): no API key needed
    return None


async def _resolve_explicit_model(model_id: str) -> tuple[str, dict]:
    """Return (litellm_model, extra_kwargs) for a user-supplied model ID.

    If the ID matches a discovered local model, wraps it as openai/ with the
    backend's OpenAI-compatible api_base (Ollama serves one under /v1 — used
    instead of litellm's ollama_chat, whose tool support forces format=json
    and wrecks conversational turns). Otherwise returns the ID unchanged for
    cloud routing.
    """
    for ep in ep_mod.routable():
        local_models = await discover_endpoint_models(ep)
        if any(m["id"] == model_id for m in local_models):
            return selector.endpoint_candidate(ep, model_id)
    return model_id, {}


async def _try_complete(
    messages: list[dict],
    max_tokens: int,
    temperature: float,
    model: str = "auto",
    stream: bool = False,
    extra_kwargs: dict | None = None,
) -> tuple[Any, str]:
    # When an explicit model is requested, use only that model — no fallback chain.
    if model != "auto":
        litellm_model, model_kwargs = await _resolve_explicit_model(model)
        kwargs: dict[str, Any] = {**model_kwargs}
        if extra_kwargs:
            kwargs.update(extra_kwargs)
        api_key = await _api_key_for(litellm_model)
        if api_key:
            kwargs["api_key"] = api_key
        try:
            resp = await litellm.acompletion(
                model=litellm_model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=stream,
                **kwargs,
            )
            return resp, model
        except Exception as exc:
            # Models without a tool template (e.g. gemma on Ollama /v1) reject
            # requests that offer tools. They couldn't have called one anyway —
            # retry the turn without tools instead of failing it.
            if "tools" in kwargs and "does not support tools" in str(exc):
                logger.info("Model %s lacks tool support — retrying without tools", model)
                retry_kwargs = {k: v for k, v in kwargs.items() if k != "tools"}
                try:
                    resp = await litellm.acompletion(
                        model=litellm_model,
                        messages=messages,
                        max_tokens=max_tokens,
                        temperature=temperature,
                        stream=stream,
                        **retry_kwargs,
                    )
                    return resp, model
                except Exception as retry_exc:
                    exc = retry_exc
            logger.warning("Requested model %s failed: %s", model, exc)
            raise HTTPException(status_code=503, detail=f"Model {model} unavailable: {exc}")

    cloud = await _available_cloud()
    candidates = selector.completion_candidates(cloud)
    if not candidates:
        raise HTTPException(status_code=503, detail="No LLM providers configured")

    last_exc: Exception | None = None
    woke_host = False
    for cand_model, model_extra in candidates:
        kwargs = {**model_extra}
        if extra_kwargs:
            kwargs.update(extra_kwargs)
        api_key = await _api_key_for(cand_model)
        if api_key:
            kwargs["api_key"] = api_key
        try:
            resp = await litellm.acompletion(
                model=cand_model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=stream,
                **kwargs,
            )
            return resp, cand_model
        except Exception as exc:
            logger.warning("Provider %s failed: %s", cand_model, exc)
            last_exc = exc
            # A local candidate failing to connect may just be a sleeping GPU
            # box — fire a rate-limited Wake-on-LAN for that endpoint.
            failed_ep = ep_mod.by_api_base(str(model_extra.get("api_base", "")))
            if failed_ep is not None and _is_connection_error(exc):
                woke_host = await wol.wake_if_due(
                    f"local candidate {cand_model} unreachable", failed_ep
                ) or woke_host

    detail = f"All LLM providers failed: {last_exc}"
    if woke_host:
        detail += " — sent Wake-on-LAN to the inference host; retry in a minute or two"
    raise HTTPException(status_code=503, detail=detail)


def _is_connection_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(s in text for s in ("connection", "connect", "timed out", "timeout", "unreachable"))


@router.get("/providers")
async def list_providers():
    cloud = await _available_cloud()
    providers = [
        {
            "name": settings.nova_inference_backend,
            "model": settings.local_completion_model,
            "available": settings.nova_inference_backend != "none",
            "local": True,
            "supports_embed": settings.nova_inference_backend in ("ollama-host", "ollama"),
            "url": settings.local_inference_url,
        }
    ]
    if "anthropic" in cloud:
        providers.append({
            "name": "anthropic",
            "model": "claude-haiku-4-5-20251001",
            "available": True,
            "local": False,
            "supports_embed": False,
        })
    if "openai" in cloud:
        providers.append({
            "name": "openai",
            "model": "gpt-4o-mini",
            "available": True,
            "local": False,
            "supports_embed": True,
        })
    if "gemini" in cloud:
        providers.append({
            "name": "gemini",
            "model": "gemini/gemini-2.5-flash",
            "available": True,
            "local": False,
            "supports_embed": False,
        })
    if "groq" in cloud:
        providers.append({
            "name": "groq",
            "model": "groq/llama3-8b-8192",
            "available": True,
            "local": False,
            "supports_embed": False,
        })
    return {
        "providers": providers,
        "routing_strategy": selector.get_routing_strategy(),
        "local_backend": settings.nova_inference_backend,
        "local_inference_url": settings.local_inference_url,
    }


@router.get("/models/discover")
async def discover_models(refresh: bool = False):
    """Return all providers with their available models.

    Local models are discovered live, one provider entry per enabled pool
    endpoint (cached 5 min). Cloud providers are included when their API key is
    configured. Pass ?refresh=true to bypass the discovery cache.
    """
    cloud = await _available_cloud()
    providers = _cloud_providers(cloud)
    local_entries = []
    for ep, models in await discover_all_endpoints(force=refresh):
        local_entries.append(_local_provider_entry(models, ep))
    for entry in reversed(local_entries):
        providers.insert(0, entry)
    return providers


def _litellm_to_display_id(litellm_model: str) -> str:
    for prefix in ("ollama_chat/", "ollama/", "openai/"):
        if litellm_model.startswith(prefix):
            return litellm_model[len(prefix):]
    return litellm_model


@router.get("/models/resolve")
async def resolve_best_model():
    """Return the best model ID to use given the current routing strategy."""
    cloud = await _available_cloud()
    candidates = selector.completion_candidates(cloud)
    if not candidates:
        raise HTTPException(status_code=503, detail="No models available")

    litellm_model, _ = candidates[0]
    display_id = _litellm_to_display_id(litellm_model)
    source = "local" if litellm_model != display_id else "cloud"
    return {"model": display_id, "source": source}


# ── Endpoint pool ─────────────────────────────────────────────────────────────


def _resolve_ep(endpoint_id: str) -> dict:
    ep = ep_mod.get(endpoint_id)
    if ep is None:
        raise HTTPException(status_code=404, detail=f"Unknown endpoint '{endpoint_id}'")
    return ep


@router.get("/endpoints")
async def list_inference_endpoints():
    """The inference endpoint pool. With no saved config: the env default."""
    return {"endpoints": ep_mod.list_endpoints()}


class EndpointsUpdate(BaseModel):
    endpoints: list[dict]


@router.put("/endpoints")
async def put_inference_endpoints(body: EndpointsUpdate):
    try:
        saved = ep_mod.save(body.endpoints)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    invalidate()  # endpoint set changed — discovery caches are stale
    _caps_cache.clear()
    return {"endpoints": saved}


# ── Recommended models, hardware profile, pull lifecycle ─────────────────────


def _norm(model_id: str) -> str:
    return model_id.removesuffix(":latest")


def _require_ollama(ep: dict) -> None:
    if ep["engine"] not in ("ollama", "ollama-host"):
        raise HTTPException(
            status_code=400,
            detail=f"Model management requires an Ollama endpoint ('{ep['id']}' is {ep['engine']})",
        )


@router.get("/hardware")
async def get_hardware(refresh: bool = False, endpoint: str = "default"):
    """Inference host profile (detected/declared/unknown) + live observed signals.

    refresh=true bypasses the 60s wol_mac cache — the dashboard uses it right
    after creating/removing the secret so the UI reflects the change instantly.
    """
    ep = _resolve_ep(endpoint)
    profile = hardware.read_profile(ep["id"])
    secret_name = ep.get("wol_mac_secret") or wol.MAC_SECRET_NAME
    return {
        **profile,
        "endpoint": ep["id"],
        "inference_url": ep["url"],
        "backend": ep["engine"],
        "observed": await hardware.observe(ep),
        "wol_configured": (await wol.get_mac(force=refresh, secret_name=secret_name)) is not None,
    }


_GPU_CHECK_HINTS = {
    "gpu": "All layers resident in VRAM — Nova is using the GPU.",
    "partial": "The model doesn't fully fit in VRAM, so layers spill to system RAM and "
               "responses slow down. Use a smaller model or tighter quantization.",
    "cpu": "Ollama sees no usable GPU. On the inference host: restart Ollama (it probes "
           "GPUs only at startup), update it, verify nvidia-smi works there, then check "
           "the Ollama server log's GPU detection lines near startup.",
    "unknown": "No model stayed loaded to measure. Try again, or check that the "
               "configured completion model is installed.",
    "error": "The check could not run — see detail.",
}


@router.post("/hardware/gpu-check")
async def gpu_check(endpoint: str = "default"):
    """End-to-end GPU verification through Nova's own inference path.

    Loads the configured completion model with a 1-token generation, then reads
    /api/ps for the real VRAM offload state. One click answers "is Nova using
    the GPU?" — no host-side forensics required.
    """
    ep = _resolve_ep(endpoint)
    _require_ollama(ep)
    model = settings.local_completion_model
    started = time.monotonic()
    detail = None
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(
                f"{ep['url']}/api/generate",
                json={"model": model, "prompt": "hi", "stream": False,
                      "options": {"num_predict": 1}},
            )
            if r.status_code == 404:
                return {
                    "verdict": "error",
                    "detail": f"Model '{model}' is not installed on endpoint '{ep['id']}' — pull it first.",
                    "hint": _GPU_CHECK_HINTS["error"],
                    "model_tested": model,
                }
            r.raise_for_status()
    except Exception as exc:
        return {
            "verdict": "error",
            "detail": f"Inference host unreachable or generation failed: {exc}",
            "hint": _GPU_CHECK_HINTS["error"],
            "model_tested": model,
        }

    observed = await hardware.observe(ep)
    loaded = observed.get("loaded") or []
    verdict = hardware.gpu_verdict(loaded)
    return {
        "verdict": verdict,
        "model_tested": model,
        "loaded": loaded,
        "elapsed_s": round(time.monotonic() - started, 1),
        "hint": _GPU_CHECK_HINTS[verdict],
        "detail": detail,
    }


@router.post("/hardware/wake", status_code=202)
async def wake_inference_host(endpoint: str = "default"):
    """Manually send a Wake-on-LAN magic packet to an inference host."""
    ep = _resolve_ep(endpoint)
    secret_name = ep.get("wol_mac_secret") or wol.MAC_SECRET_NAME
    mac = await wol.get_mac(force=True, secret_name=secret_name)
    if not mac:
        raise HTTPException(
            status_code=409,
            detail=f"Wake-on-LAN not configured — add a '{secret_name}' secret with the inference host's MAC",
        )
    try:
        result = await wol.send_wake(mac)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Wake send failed: {exc}")
    return {"triggered": True, **result}


class HardwareDeclare(BaseModel):
    gpus: list[dict] | None = None     # [{"name": "RTX 3090", "vram_gb": 24}]
    ram_gb: float | None = None
    cpu_cores: int | None = None
    disk_free_gb: float | None = None


@router.put("/hardware")
async def put_hardware(body: HardwareDeclare, endpoint: str = "default"):
    """Declare an inference host's specs (split deployments — remote GPU box)."""
    ep = _resolve_ep(endpoint)
    profile = hardware.write_declared(body.model_dump(), ep["id"])
    return {
        **profile,
        "endpoint": ep["id"],
        "inference_url": ep["url"],
        "backend": ep["engine"],
        "observed": await hardware.observe(ep),
    }


@router.get("/models/recommended")
async def recommended_models(refresh: bool = False, endpoint: str = "default"):
    """The curated manifest merged with hardware fit + installed state.

    local entries: installed / fits / slow / denylisted flags resolved live
    against the chosen endpoint. cloud entries: availability keyed off
    configured provider keys.
    """
    ep = _resolve_ep(endpoint)
    data = await get_manifest(force=refresh)
    profile = hardware.read_profile(ep["id"])
    installed = {_norm(m["id"]) for m in await discover_endpoint_models(ep, force=refresh)}
    cloud_keys = await _available_cloud()

    deny = data.get("denylist") or []

    def deny_reason(ollama_id: str | None) -> str | None:
        if not ollama_id:
            return None
        for d in deny:
            if d.get("match") and ollama_id.startswith(d["match"]):
                return d.get("reason", "denylisted")
        return None

    local, cloud = [], []
    for entry in data.get("models", []):
        e = dict(entry)
        if e.get("cloud"):
            provider = e.get("provider")
            if provider == "ollama-cloud":
                e["available"] = ep["engine"] in ("ollama", "ollama-host")
                e["installed"] = bool(e.get("ollama_id")) and _norm(e["ollama_id"]) in installed
            else:
                e["available"] = provider in cloud_keys
            cloud.append(e)
            continue
        oid = e.get("ollama_id")
        e["installed"] = bool(oid) and _norm(oid) in installed
        e["fits"] = hardware.fits(profile, e.get("min_vram_gb") or 0, e.get("min_ram_gb") or 0)
        # CPU-only boxes crawl above ~7B — the 2026-06-09 dev-box lesson.
        e["slow_on_cpu"] = hardware.total_vram_gb(profile) == 0 and (e.get("size_gb") or 0) > 5
        e["deny_reason"] = deny_reason(oid)
        local.append(e)

    return {
        "manifest_source": data.get("_source"),
        "manifest_fetched_at": data.get("_fetched_at"),
        "manifest_updated": data.get("updated"),
        "hardware_source": profile.get("source"),
        "endpoint": ep["id"],
        "local": local,
        "cloud": cloud,
    }


@router.get("/models/pulled")
async def pulled_models(endpoint: str = "default"):
    """Installed Ollama models with size/digest/modified."""
    ep = _resolve_ep(endpoint)
    _require_ollama(ep)
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.get(f"{ep['url']}/api/tags")
            r.raise_for_status()
            models = r.json().get("models", [])
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Ollama unreachable: {exc}")
    return [
        {
            "name": m.get("name"),
            "id": _norm(m.get("name", "")),
            "size_bytes": m.get("size"),
            "digest": (m.get("digest") or "")[:12],
            "modified_at": m.get("modified_at"),
        }
        for m in models
    ]


class PullRequestBody(BaseModel):
    model: str


@router.post("/models/pull")
async def pull_model(body: PullRequestBody, endpoint: str = "default"):
    """Pull a model onto an inference host; Ollama's NDJSON progress as SSE."""
    ep = _resolve_ep(endpoint)
    _require_ollama(ep)

    async def generate():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{ep['url']}/api/pull",
                    json={"model": body.model, "stream": True},
                ) as resp:
                    async for line in resp.aiter_lines():
                        if line.strip():
                            yield f"data: {line}\n\n"
        except Exception as exc:
            yield f"data: {json.dumps({'error': str(exc)})}\n\n"
        # Pull changes the catalog — make new models visible without the 5-min wait.
        invalidate(ep["id"])
        _caps_cache.clear()

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.delete("/models/{model_name:path}")
async def delete_model(model_name: str, endpoint: str = "default"):
    ep = _resolve_ep(endpoint)
    _require_ollama(ep)
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.request(
                "DELETE",
                f"{ep['url']}/api/delete",
                json={"model": model_name},
            )
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Ollama unreachable: {exc}")
    if r.status_code == 404:
        raise HTTPException(status_code=404, detail=f"Model not found: {model_name}")
    if r.status_code >= 400:
        raise HTTPException(status_code=r.status_code, detail=r.text)
    invalidate(ep["id"])
    _caps_cache.clear()
    return {"deleted": model_name}


# ── Tool-capability verification ─────────────────────────────────────────────
# The proactivity guard (agent-core) must not run autonomous cycles on a model
# that can't tool-call; the Models page will use the probe as ground truth.

_caps_cache: dict[str, tuple[float, dict]] = {}
_CAPS_TTL = 600.0

_PROBE_TOOL = [{
    "type": "function",
    "function": {
        "name": "ping",
        "description": "Reply to a ping. Call this tool with the message 'pong'.",
        "parameters": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
        },
    },
}]


async def _ollama_show_capabilities(model: str, url: str | None = None) -> list[str] | None:
    """Query Ollama /api/show for a model's capabilities array. None on failure."""
    base = url or settings.local_inference_url
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(f"{base}/api/show", json={"model": model})
            r.raise_for_status()
            caps = r.json().get("capabilities")
            return caps if isinstance(caps, list) else None
    except Exception as exc:
        logger.debug("ollama /api/show failed for %s: %s", model, exc)
        return None


@router.get("/models/capabilities")
async def model_capabilities(model: str | None = None, probe: bool = False):
    """Tool-capability check. Defaults to the active completion model.

    tools: true/false from Ollama /api/show for local models; true (assumed) for
    cloud models; null (unknown) for non-Ollama local backends or on errors.
    probe=true additionally runs a one-shot completion with a trivial tool and
    reports whether a well-formed tool call came back.
    """
    serving_ep: dict | None = None
    if model is None:
        cloud = await _available_cloud()
        candidates = selector.completion_candidates(cloud)
        if not candidates:
            raise HTTPException(status_code=503, detail="No models available")
        litellm_model, kwargs0 = candidates[0]
        model = _litellm_to_display_id(litellm_model)
        is_local = litellm_model != model
        if is_local:
            serving_ep = ep_mod.by_api_base(kwargs0.get("api_base", ""))
    else:
        # Find which pool endpoint (if any) serves this model.
        for ep in ep_mod.routable():
            ids = {m["id"] for m in await discover_endpoint_models(ep)}
            if model in ids or model.removesuffix(":latest") in ids:
                serving_ep = ep
                break
        is_local = serving_ep is not None

    cache_key = f"{model}|probe={probe}"
    now = time.monotonic()
    cached = _caps_cache.get(cache_key)
    if cached and (now - cached[0]) < _CAPS_TTL:
        return cached[1]

    ep_engine = serving_ep["engine"] if serving_ep else settings.nova_inference_backend
    ep_url = serving_ep["url"] if serving_ep else settings.local_inference_url

    tools: bool | None
    if not is_local:
        tools, method = True, "assumed-cloud"
    elif ep_engine in ("ollama", "ollama-host"):
        caps = await _ollama_show_capabilities(model, url=ep_url)
        if caps is None:
            tools, method = None, "unknown"
        else:
            tools, method = ("tools" in caps), "ollama/api/show"
    else:
        # vllm / llamacpp / sglang / lmstudio expose no capability API.
        tools, method = None, "unknown"

    result: dict[str, Any] = {
        "model": model,
        "source": "local" if is_local else "cloud",
        "tools": tools,
        "method": method,
    }

    if probe:
        try:
            resp, _ = await _try_complete(
                messages=[{"role": "user", "content": "Use the ping tool to send the message 'pong'."}],
                max_tokens=80,
                temperature=0.0,
                model=model,
                extra_kwargs={"tools": _PROBE_TOOL, "tool_choice": "auto"},
            )
            raw_tc = getattr(resp.choices[0].message, "tool_calls", None)
            result["probe_passed"] = bool(raw_tc)
        except Exception as exc:
            logger.warning("tool probe failed for %s: %s", model, exc)
            result["probe_passed"] = None
            result["probe_error"] = str(exc)

    _caps_cache[cache_key] = (now, result)
    return result


class LLMConfigUpdate(BaseModel):
    routing_strategy: str | None = None


@router.patch("/config")
async def update_config(body: LLMConfigUpdate):
    if body.routing_strategy is not None:
        if body.routing_strategy not in VALID_STRATEGIES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid routing_strategy. Must be one of: {sorted(VALID_STRATEGIES)}",
            )
        selector.set_routing_strategy(body.routing_strategy)
    return {
        "routing_strategy": selector.get_routing_strategy(),
        "local_backend": settings.nova_inference_backend,
    }


@router.post("/complete")
async def complete(body: LLMRequest):
    # Council mode: parallel proposers + chair synthesis. Tool-offering requests
    # downgrade to standard (the agent loop's tool turns must stay single-shot);
    # an unavailable council falls back to standard rather than failing the turn.
    if body.mode == "council":
        if body.tools:
            council_meta = {"downgraded": "tools offered — council runs tool-free turns only"}
        else:
            try:
                final, meta = await council.run_council(
                    messages=[m.model_dump() for m in body.messages],
                    max_tokens=body.max_tokens,
                    seed_proposal=body.seed_proposal,
                )
                return {
                    "content": final,
                    "model": f"council/{meta.get('aggregator') or 'best-proposal'}",
                    "usage": {"total_tokens": meta.get("total_tokens", 0)},
                    "tool_calls": None,
                    "council": meta,
                }
            except council.CouncilUnavailable as exc:
                council_meta = {"downgraded": str(exc)}
    else:
        council_meta = None

    extra: dict[str, Any] = {}
    if body.tools:
        extra["tools"] = _sanitize_tools_for_gemini(body.tools)
        extra["tool_choice"] = "auto"

    resp, model_used = await _try_complete(
        messages=[m.model_dump() for m in body.messages],
        max_tokens=body.max_tokens,
        temperature=body.temperature,
        model=body.model,
        extra_kwargs=extra or None,
    )
    content = resp.choices[0].message.content or ""

    tool_calls = None
    raw_tc = getattr(resp.choices[0].message, "tool_calls", None)
    if raw_tc:
        tool_calls = [
            {
                "id": tc.id,
                "type": "function",
                "function": {"name": tc.function.name, "arguments": tc.function.arguments},
            }
            for tc in raw_tc
        ]

    usage = {}
    if resp.usage:
        usage = {
            "prompt_tokens": resp.usage.prompt_tokens,
            "completion_tokens": resp.usage.completion_tokens,
        }
    out = {"content": content, "model": model_used, "usage": usage, "tool_calls": tool_calls}
    if council_meta is not None:
        out["council"] = council_meta
    return out


@router.post("/stream")
async def stream_complete(body: LLMRequest):
    resp_stream, model_used = await _try_complete(
        messages=[m.model_dump() for m in body.messages],
        max_tokens=body.max_tokens,
        temperature=body.temperature,
        model=body.model,
        stream=True,
    )

    async def generate():
        try:
            async for chunk in resp_stream:
                delta = chunk.choices[0].delta.content or ""
                done = chunk.choices[0].finish_reason is not None
                payload = {"chunk": delta, "done": done}
                if done:
                    payload["model"] = model_used
                yield f"data: {json.dumps(payload)}\n\n"
        except Exception as exc:
            logger.warning("Stream error: %s", exc)
            yield f"data: {json.dumps({'chunk': '', 'done': True, 'error': str(exc)})}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/embed")
async def embed(body: EmbedRequest):
    cloud = await _available_cloud()
    candidates = selector.embed_candidates(cloud)
    if not candidates:
        raise HTTPException(status_code=503, detail="No embedding providers configured")

    last_exc: Exception | None = None
    for model, extra_kwargs in candidates:
        kwargs: dict[str, Any] = {**extra_kwargs}
        api_key = await _api_key_for(model)
        if api_key:
            kwargs["api_key"] = api_key
        try:
            resp = await litellm.aembedding(model=model, input=body.input, **kwargs)
            embedding = resp.data[0]["embedding"]
            return {"embedding": embedding, "model": model, "dim": len(embedding)}
        except Exception as exc:
            logger.warning("Embed provider %s failed: %s", model, exc)
            last_exc = exc

    raise HTTPException(status_code=503, detail=f"All embed providers failed: {last_exc}")
