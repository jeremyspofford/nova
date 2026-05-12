# agent-core/app/memory_client.py
"""HTTP client for memory-service. Used by agent-core's agent loop."""
import logging

import httpx

from .config import settings

logger = logging.getLogger(__name__)


async def write(
    content: str,
    source_kind: str,
    source_uri: str | None = None,
) -> str | None:
    """Write a memory. Returns the new memory ID, or None on failure."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            r = await client.post(
                f"{settings.memory_service_url}/memories",
                json={"content": content, "source_kind": source_kind, "source_uri": source_uri},
            )
            r.raise_for_status()
            return r.json()["id"]
    except Exception as exc:
        logger.warning("memory_client.write failed: %s", exc)
        return None


async def search(
    query: str,
    limit: int = 10,
    source_kinds: list[str] | None = None,
    tags: list[str] | None = None,
    min_similarity: float | None = None,
) -> list[dict]:
    """Search memories. Returns empty list on failure."""
    body: dict = {"query": query, "limit": limit}
    if source_kinds:
        body["source_kinds"] = source_kinds
    if tags:
        body["tags"] = tags
    if min_similarity is not None:
        body["min_similarity"] = min_similarity

    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.post(
                f"{settings.memory_service_url}/memories/search",
                json=body,
            )
            r.raise_for_status()
            return r.json()["results"]
    except Exception as exc:
        logger.warning("memory_client.search failed: %s", exc)
        return []


async def mark_used(memory_id: str) -> None:
    """Increment used_count for a memory. Best-effort — failures are silent."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.patch(
                f"{settings.memory_service_url}/memories/{memory_id}/used",
            )
    except Exception as exc:
        logger.debug("memory_client.mark_used failed: %s", exc)
