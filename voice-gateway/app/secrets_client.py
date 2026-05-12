"""Lazily resolves secrets from agent-core. Identical pattern to llm-gateway."""
import logging

import httpx

from .config import settings

logger = logging.getLogger(__name__)

_cache: dict[str, str] = {}


async def resolve(name: str) -> str | None:
    if name in _cache:
        return _cache[name]
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                f"{settings.agent_core_url}/api/v1/secrets/resolve",
                json={"name": name},
                headers={"X-Admin-Secret": settings.admin_secret},
            )
            if r.status_code == 200:
                value = r.json()["value"]
                _cache[name] = value
                return value
    except Exception as exc:
        logger.warning("Failed to resolve secret '%s': %s", name, exc)
    return None
