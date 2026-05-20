import json
import logging
import time
from typing import Any

import litellm
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from fastapi.responses import StreamingResponse
from nova_contracts import EmbedRequest, LLMRequest

from . import secrets_client, selector
from .config import settings
from .discovery import _cloud_providers, _local_provider_entry, discover_local_models
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

    If the ID matches a discovered local model, wraps it in the correct
    LiteLLM format (ollama_chat/ or openai/ with api_base). Otherwise
    returns the ID unchanged for cloud routing.
    """
    backend = settings.nova_inference_backend
    if backend != "none":
        local_models = await discover_local_models()
        if any(m["id"] == model_id for m in local_models):
            url = settings.local_inference_url
            if backend in ("ollama-host", "ollama"):
                return f"ollama_chat/{model_id}", {"api_base": url}
            else:
                return f"openai/{model_id}", {"api_base": url, "api_key": "none"}
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
            logger.warning("Requested model %s failed: %s", model, exc)
            raise HTTPException(status_code=503, detail=f"Model {model} unavailable: {exc}")

    cloud = await _available_cloud()
    candidates = selector.completion_candidates(cloud)
    if not candidates:
        raise HTTPException(status_code=503, detail="No LLM providers configured")

    last_exc: Exception | None = None
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

    raise HTTPException(status_code=503, detail=f"All LLM providers failed: {last_exc}")


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
            "model": "gemini/gemini-1.5-flash",
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

    Local models are discovered live from the active backend (cached 5 min).
    Cloud providers are included when their API key is configured.
    Pass ?refresh=true to bypass the discovery cache.
    """
    local_models = await discover_local_models(force=refresh)
    cloud = await _available_cloud()
    providers = _cloud_providers(cloud)
    if settings.nova_inference_backend != "none":
        providers.insert(0, _local_provider_entry(local_models))
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
    return {"content": content, "model": model_used, "usage": usage, "tool_calls": tool_calls}


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
