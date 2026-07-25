"""One shared httpx client, so connections are reused.

Nova opened a brand-new `httpx.AsyncClient` per request, at 39 call sites —
including the LLM stream, which is the single hottest outbound path in the
app. Every client is its own connection pool, so every LLM round paid a
fresh TCP handshake plus a full TLS negotiation to OpenRouter before the
model could start generating, and threw the warm connection away
immediately afterwards. Multi-round turns paid it once per round.

A module-level client keeps the pool alive across calls, so the second and
subsequent requests to a host reuse an already-negotiated connection.

Timeouts stay per-request (`client.stream(..., timeout=...)`) because they
genuinely differ: a 20s page fetch and a 30-minute media extraction cannot
share a default. Only the pool is shared.
"""

import logging
from typing import Optional

import httpx

log = logging.getLogger(__name__)

_client: Optional[httpx.AsyncClient] = None

# Sized for one operator, not a fleet. keepalive_expiry comfortably outlives
# the gap between rounds of a single turn, which is the reuse that matters.
_LIMITS = httpx.Limits(max_connections=32, max_keepalive_connections=16,
                       keepalive_expiry=90.0)


def client() -> httpx.AsyncClient:
    """The shared client. Created on first use so importing this module is
    free and does not need a running event loop."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(limits=_LIMITS, timeout=30.0,
                                    follow_redirects=False)
    return _client


async def aclose() -> None:
    """Called from the lifespan shutdown."""
    global _client
    if _client is not None and not _client.is_closed:
        await _client.aclose()
    _client = None
