"""Lazily resolves secrets from agent-core. Cached briefly — secrets can be
created and removed at runtime (e.g. the WoL setup flow), so a lifetime cache
would serve stale values until restart. force=True bypasses the cache for
flows that must see a change immediately."""
import logging
import time

import httpx

from .config import settings

logger = logging.getLogger(__name__)

_CACHE_TTL = 300.0
_cache: dict[str, tuple[float, str | None]] = {}


async def resolve(name: str, force: bool = False) -> str | None:
    """Resolve a secret by name. Returns None if not found or agent-core unreachable."""
    now = time.monotonic()
    if not force:
        cached = _cache.get(name)
        if cached is not None and (now - cached[0]) < _CACHE_TTL:
            return cached[1]
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                f"{settings.agent_core_url}/api/v1/secrets/resolve",
                json={"name": name},
                headers={"X-Admin-Secret": settings.admin_secret},
            )
            if r.status_code == 200:
                value = r.json()["value"]
                _cache[name] = (now, value)
                return value
            if r.status_code == 404:
                # A definitive miss is cacheable too — the secret doesn't exist.
                _cache[name] = (now, None)
                return None
    except Exception as exc:
        logger.warning("Failed to resolve secret '%s': %s", name, exc)
    return None
