"""
LLM Gateway FastAPI router.
Exposes /complete, /stream, /embed endpoints backed by ModelProvider abstraction.
"""
from __future__ import annotations

import json
import logging
import time as _time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import AsyncIterator

from app.rate_limiter import check_rate_limit
from app.registry import get_embed_provider, get_provider
from app.response_cache import get_cached, set_cached
from app.tier_resolver import BudgetExhaustedError, resolve_model
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from nova_contracts import (
    CompleteRequest,
    CompleteResponse,
    EmbedRequest,
    EmbedResponse,
    ModelInfo,
)

log = logging.getLogger(__name__)
router = APIRouter(tags=["llm"])

_local_inflight = 0
_inference_metrics: deque = deque(maxlen=1000)


def get_local_inflight() -> int:
    return _local_inflight


def record_inference_metric(tokens: int, duration_s: float, ttft_ms: float):
    """Record a completed inference request metric."""
    _inference_metrics.append({
        "ts": _time.time(),
        "tokens_per_sec": tokens / duration_s if duration_s > 0 else 0,
        "ttft_ms": ttft_ms,
    })


async def _enforce_rate_limit(model: str) -> None:
    allowed, prefix, remaining = await check_rate_limit(model)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Daily quota exhausted for provider '{prefix}'. Try a different provider or wait until the quota resets.",
        )


async def _resolve_request_model(request: CompleteRequest, raw_request: Request) -> CompleteRequest:
    """Resolve model via tier system if not explicitly set. Mutates request.model."""
    caller = raw_request.headers.get("x-caller")
    resolved = await resolve_model(
        model=request.model,
        tier=request.tier,
        task_type=request.task_type,
        request=request,
        caller=caller,
    )
    request.model = resolved
    return request


@router.post("/complete", response_model=CompleteResponse)
async def complete(request: CompleteRequest, raw_request: Request):
    """Non-streaming LLM completion."""
    try:
        request = await _resolve_request_model(request, raw_request)
    except BudgetExhaustedError:
        tomorrow = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        return JSONResponse(status_code=429, content={"error": "budget_exhausted", "detail": "Daily budget exceeded", "resets_at": tomorrow.isoformat()})
    except ValueError as e:
        return JSONResponse(status_code=503, content={"error": str(e)})

    await _enforce_rate_limit(request.model)

    # Check cache (only for temperature=0 deterministic requests)
    cache_body = None
    if request.temperature == 0:
        cache_body = request.model_dump(exclude={"metadata", "stream"})
        cached = await get_cached("complete", cache_body)
        if cached:
            return CompleteResponse(**cached)

    provider = await get_provider(request.model)
    is_local = provider.is_local

    global _local_inflight
    if is_local:
        _local_inflight += 1
    try:
        response = await provider.complete(request)
    finally:
        if is_local:
            _local_inflight -= 1

    log.info(
        "complete model=%s in=%d out=%d cost=$%.4f",
        response.model, response.input_tokens, response.output_tokens, response.cost_usd or 0,
    )

    if cache_body is not None:
        await set_cached("complete", cache_body, response.model_dump())

    return response


@router.post("/stream")
async def stream(request: CompleteRequest, raw_request: Request):
    """
    Server-Sent Events streaming completion.
    Each chunk is a JSON line; the final chunk has finish_reason set.
    """
    try:
        request = await _resolve_request_model(request, raw_request)
    except BudgetExhaustedError:
        tomorrow = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
        return JSONResponse(status_code=429, content={"error": "budget_exhausted", "detail": "Daily budget exceeded", "resets_at": tomorrow.isoformat()})
    except ValueError as e:
        return JSONResponse(status_code=503, content={"error": str(e)})

    await _enforce_rate_limit(request.model)
    provider = await get_provider(request.model)
    is_local = provider.is_local

    async def generate() -> AsyncIterator[bytes]:
        global _local_inflight
        if is_local:
            _local_inflight += 1
        try:
            async for chunk in provider.stream(request):
                yield f"data: {chunk.model_dump_json()}\n\n".encode()
            yield b"data: [DONE]\n\n"
        except Exception as e:
            log.error("Stream error from %s (model=%s): %s", provider.name, request.model, e)
            # Nova internal SSE format — intentionally different from the OpenAI-compat
            # endpoint (/v1/chat/completions) which uses {"error": {"message": ..., "type": ...}}.
            error_payload = json.dumps({"error": str(e), "provider": provider.name})
            yield f"data: {error_payload}\n\n".encode()
            yield b"data: [DONE]\n\n"
        finally:
            if is_local:
                _local_inflight -= 1

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest):
    """Generate embeddings for a list of texts."""
    # Embedding provider override (llm.embed_provider / llm.embed_model).
    # When set, routes to the named provider regardless of the model string
    # memory-service sent, and substitutes llm.embed_model as the model name.
    # Default ("auto") preserves model-name registry lookup. Resolved BEFORE
    # caching so the cache key reflects the effective provider+model (avoids
    # returning stale vectors from a different provider after a config change).
    from app.registry import _resolve_embed_override
    override_provider, override_model = await _resolve_embed_override()
    if override_provider is not None:
        provider = override_provider
        if override_model and override_model != request.model:
            request = request.model_copy(update={"model": override_model})
    else:
        provider = await get_embed_provider(request.model)

    await _enforce_rate_limit(request.model)

    # Embeddings are always deterministic — cache unconditionally
    cache_body = request.model_dump()
    cached = await get_cached("embed", cache_body)
    if cached:
        return EmbedResponse(**cached)

    is_local = provider.is_local

    global _local_inflight
    if is_local:
        _local_inflight += 1
    try:
        response = await provider.embed(request)
    finally:
        if is_local:
            _local_inflight -= 1

    await set_cached("embed", cache_body, response.model_dump())
    return response


@router.get("/v1/inference/stats")
async def get_inference_stats():
    """Return rolling inference performance metrics."""
    cutoff = _time.time() - 300
    recent = [m for m in _inference_metrics if m["ts"] > cutoff]

    if not recent:
        return {
            "requests_5m": 0,
            "avg_tokens_per_sec": 0,
            "avg_ttft_ms": 0,
            "error_rate_pct": 0,
        }

    avg_tps = sum(m["tokens_per_sec"] for m in recent) / len(recent)
    avg_ttft = sum(m["ttft_ms"] for m in recent) / len(recent)

    return {
        "requests_5m": len(recent),
        "avg_tokens_per_sec": round(avg_tps, 1),
        "avg_ttft_ms": round(avg_ttft, 0),
        "error_rate_pct": 0,
    }


@router.get("/models", response_model=list[ModelInfo])
async def list_models():
    """List available models and their capabilities."""
    from app.registry import MODEL_REGISTRY, get_model_spec
    results = []
    for model_id, provider in MODEL_REGISTRY.items():
        ctx_window, max_out = get_model_spec(model_id)
        results.append(ModelInfo(
            id=model_id,
            provider=provider.name,
            capabilities=list(provider.capabilities),
            context_window=ctx_window,
            max_output_tokens=max_out,
        ))
    return results
