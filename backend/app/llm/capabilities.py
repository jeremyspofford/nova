"""What a local model can do, according to the server running it.

There is deliberately NO list of model names anywhere in this module, and
there should never be one. Which models reason, call tools, or take images
changes every week and differs by build, quantization and server version —
a hardcoded list is wrong the day someone pulls a new model, and wrong in a
way that fails silently (Nova would just never offer thinking on a model
that supports it). Ollama already answers the question, so we ask it.

    GET /api/show {"model": "..."} -> {"capabilities": ["completion",
                                                        "tools", "thinking"]}

Cached, because this sits behind a per-turn decision and the answer changes
only when someone pulls or removes a model. Unknown is a first-class
answer: on any failure this returns None and callers fall back to leaving
the model alone, which is the pre-existing behavior.
"""

import logging
import time
from typing import Optional

import httpx

log = logging.getLogger(__name__)

_TTL_S = 600
_TIMEOUT_S = 3.0

# model id -> (fetched_at, capabilities | None)
_cache: dict[str, tuple[float, Optional[frozenset]]] = {}


def invalidate() -> None:
    """Drop the cache — call after a pull/uninstall changes what is here."""
    _cache.clear()


async def capabilities(model: str) -> Optional[frozenset]:
    """The server's own capability list for a local model, or None if it
    could not be determined. `model` may carry the 'ollama:' prefix."""
    name = model.split(":", 1)[1] if model.startswith("ollama:") else model
    if not name:
        return None
    hit = _cache.get(name)
    now = time.monotonic()
    if hit and now - hit[0] < _TTL_S:
        return hit[1]

    caps: Optional[frozenset] = None
    try:
        from app import settings_store
        base = str(settings_store.get("inference.ollama_url")).rstrip("/")
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.post(f"{base}/api/show", json={"model": name})
            resp.raise_for_status()
        listed = resp.json().get("capabilities") or []
        caps = frozenset(str(c).lower() for c in listed)
    except Exception as e:  # noqa: BLE001 — a capability probe must never break a turn
        log.debug("capability probe failed for %s: %s", name, e)
    _cache[name] = (now, caps)
    return caps


async def supports(model: str, capability: str) -> Optional[bool]:
    """True/False when the server said so, None when we could not ask.

    Three-valued on purpose: "we don't know" must not read as "no". A
    caller that treats unknown as no would silently stop offering thinking
    the moment the inference server was briefly unreachable.
    """
    caps = await capabilities(model)
    return None if caps is None else (capability.lower() in caps)
