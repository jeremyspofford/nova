"""
HTTP clients for downstream services.
Uses httpx with connection pooling; clients are module-level singletons.
Runtime memory provider URL can be overridden via Redis (nova:config:memory.provider_url).
"""
from __future__ import annotations

import logging

import httpx
from app.config import settings

log = logging.getLogger(__name__)

_memory_client: httpx.AsyncClient | None = None
_memory_client_url: str | None = None  # Track current URL for runtime switching
_llm_client: httpx.AsyncClient | None = None
_orchestrator_client: httpx.AsyncClient | None = None


async def _get_memory_url() -> str:
    """Resolve the memory service URL: Redis override > static config."""
    try:
        from app.redis import get_redis
        redis = get_redis()
        override = await redis.get("nova:config:memory.provider_url")
        if override:
            return override if isinstance(override, str) else override.decode()
    except Exception:
        pass
    return settings.memory_service_url


async def get_memory_client_async() -> httpx.AsyncClient:
    """Get memory client, checking for runtime URL override via Redis."""
    global _memory_client, _memory_client_url
    url = await _get_memory_url()
    if _memory_client is None or _memory_client.is_closed or url != _memory_client_url:
        if _memory_client and not _memory_client.is_closed:
            await _memory_client.aclose()
        _memory_client = httpx.AsyncClient(
            base_url=url,
            timeout=30.0,
            limits=httpx.Limits(max_connections=20),
        )
        if _memory_client_url and url != _memory_client_url:
            log.info("Memory provider switched: %s → %s", _memory_client_url, url)
        _memory_client_url = url
    return _memory_client


def get_memory_client() -> httpx.AsyncClient:
    """Sync getter for backwards compatibility. Uses last-known URL."""
    global _memory_client, _memory_client_url
    url = _memory_client_url or settings.memory_service_url
    if _memory_client is None or _memory_client.is_closed:
        _memory_client = httpx.AsyncClient(
            base_url=url,
            timeout=30.0,
            limits=httpx.Limits(max_connections=20),
        )
        _memory_client_url = url
    return _memory_client


def get_llm_client() -> httpx.AsyncClient:
    global _llm_client
    if _llm_client is None or _llm_client.is_closed:
        _llm_client = httpx.AsyncClient(
            base_url=settings.llm_gateway_url,
            timeout=settings.llm_request_timeout_seconds,
            limits=httpx.Limits(max_connections=20),
        )
    return _llm_client


def get_orchestrator_client() -> httpx.AsyncClient:
    """Self-referencing client for cross-agent task dispatch."""
    global _orchestrator_client
    if _orchestrator_client is None or _orchestrator_client.is_closed:
        _orchestrator_client = httpx.AsyncClient(
            base_url=f"http://{settings.service_host}:{settings.service_port}",
            timeout=120.0,
            limits=httpx.Limits(max_connections=10),
        )
    return _orchestrator_client


async def close_clients() -> None:
    if _memory_client and not _memory_client.is_closed:
        await _memory_client.aclose()
    if _llm_client and not _llm_client.is_closed:
        await _llm_client.aclose()
    if _orchestrator_client and not _orchestrator_client.is_closed:
        await _orchestrator_client.aclose()
