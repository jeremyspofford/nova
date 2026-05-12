import json
import logging
import time
from typing import Any

import litellm
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from nova_contracts import EmbedRequest, LLMRequest

from . import secrets_client, selector

logger = logging.getLogger(__name__)
router = APIRouter(tags=["llm"])

litellm.suppress_debug_info = True


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
        _cloud_cache = probed
        _cloud_cache_time = now
    return _cloud_cache


async def _api_key_for(model: str) -> str | None:
    if model.startswith("claude") or "anthropic" in model:
        return await secrets_client.resolve("anthropic_api_key")
    if model.startswith(("gpt", "text-embedding")):
        return await secrets_client.resolve("openai_api_key")
    return None


async def _try_complete(
    messages: list[dict],
    max_tokens: int,
    temperature: float,
    stream: bool = False,
) -> tuple[Any, str]:
    cloud = await _available_cloud()
    candidates = selector.completion_candidates(cloud)
    if not candidates:
        raise HTTPException(status_code=503, detail="No LLM providers configured")

    last_exc: Exception | None = None
    for model, extra_kwargs in candidates:
        kwargs: dict[str, Any] = {**extra_kwargs}
        api_key = await _api_key_for(model)
        if api_key:
            kwargs["api_key"] = api_key
        try:
            resp = await litellm.acompletion(
                model=model,
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=stream,
                **kwargs,
            )
            return resp, model
        except Exception as exc:
            logger.warning("Provider %s failed: %s", model, exc)
            last_exc = exc

    raise HTTPException(status_code=503, detail=f"All LLM providers failed: {last_exc}")


@router.get("/providers")
async def list_providers():
    cloud = await _available_cloud()
    from .config import settings

    providers = [
        {
            "name": "ollama",
            "model": settings.ollama_completion_model,
            "available": True,
            "local": True,
            "supports_embed": True,
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
    return {"providers": providers, "routing_strategy": settings.routing_strategy}


@router.post("/complete")
async def complete(body: LLMRequest):
    resp, model_used = await _try_complete(
        messages=[m.model_dump() for m in body.messages],
        max_tokens=body.max_tokens,
        temperature=body.temperature,
    )
    content = resp.choices[0].message.content or ""
    usage = {}
    if resp.usage:
        usage = {
            "prompt_tokens": resp.usage.prompt_tokens,
            "completion_tokens": resp.usage.completion_tokens,
        }
    return {"content": content, "model": model_used, "usage": usage}


@router.post("/stream")
async def stream_complete(body: LLMRequest):
    resp_stream, model_used = await _try_complete(
        messages=[m.model_dump() for m in body.messages],
        max_tokens=body.max_tokens,
        temperature=body.temperature,
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
