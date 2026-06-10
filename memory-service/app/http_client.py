"""Shared httpx.AsyncClient singleton for memory-service.

A single client is created on first use and reused across all modules.
close_http_client() is called from the FastAPI lifespan shutdown to
release sockets cleanly.

P3 fix: prior code created a fresh AsyncClient per call (8 sites), each
spinning up a new TCP+TLS pool. With the singleton, connections are
reused, reducing p99 latency on the no-GPU Beelink target.
"""

from __future__ import annotations

import httpx

_client: httpx.AsyncClient | None = None


def get_http_client() -> httpx.AsyncClient:
    """Lazy-init shared httpx.AsyncClient. Per-call construction is the leak."""
    global _client
    if _client is None:
        # Downstream callers can override per-request via timeout=... on
        # individual calls.
        _client = httpx.AsyncClient(timeout=httpx.Timeout(30.0))
    return _client


async def close_http_client() -> None:
    """Close the module-level httpx client. Call at shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
