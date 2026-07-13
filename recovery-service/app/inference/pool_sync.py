"""Backend-pool writes from the recovery service (Phase 1, unified plan).

The gateway's canonical local-inference inventory is the JSON list at
``nova:config:inference.backends`` (llm-gateway/app/pool.py). Recovery is
the writer for **container** entries: starting a bundled backend upserts
its entry (front of the list = primary), stopping disables it. The legacy
scalar keys (``inference.backend``/``inference.url``) are still mirrored
for the transition so older UI readers keep displaying state, but the
gateway routes exclusively from the pool once seeded.
"""
from __future__ import annotations

import json
import logging

from app.redis_client import get_config_redis

logger = logging.getLogger(__name__)

_POOL_REDIS_KEY = "nova:config:inference.backends"


async def _read_entries() -> list[dict]:
    r = await get_config_redis()
    raw = await r.get(_POOL_REDIS_KEY)
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except (json.JSONDecodeError, TypeError):
        logger.warning("inference.backends held invalid JSON — treating as empty")
        return []


async def _write_entries(entries: list[dict]) -> None:
    r = await get_config_redis()
    await r.set(_POOL_REDIS_KEY, json.dumps(entries))


async def upsert_pool_entry(
    entry_id: str,
    engine: str,
    url: str,
    *,
    kind: str = "container",
    enabled: bool = True,
    front: bool = False,
) -> None:
    """Add or update a pool entry; ``front=True`` also makes it primary
    (first enabled entry wins ties in the gateway's routing)."""
    entries = await _read_entries()
    entry = next((e for e in entries if e.get("id") == entry_id), None)
    if entry is None:
        entry = {"id": entry_id, "auth_header": ""}
        entries.append(entry)
    entry.update({
        "kind": kind, "engine": engine,
        "url": url.rstrip("/"), "enabled": enabled,
    })
    if front:
        entries = [entry] + [e for e in entries if e.get("id") != entry_id]
    await _write_entries(entries)
    logger.info("Pool entry '%s' upserted (%s %s enabled=%s front=%s)",
                entry_id, kind, engine, enabled, front)


async def disable_all_pool_entries() -> None:
    """Disable every pool entry — the pool analogue of selecting 'none'."""
    entries = await _read_entries()
    for e in entries:
        e["enabled"] = False
    if entries:
        await _write_entries(entries)
        logger.info("All %d pool entr%s disabled", len(entries),
                    "y" if len(entries) == 1 else "ies")


async def set_pool_entry_enabled(entry_id: str, enabled: bool) -> bool:
    """Flip one entry's enabled flag. Returns False when the id is unknown."""
    entries = await _read_entries()
    found = False
    for e in entries:
        if e.get("id") == entry_id:
            e["enabled"] = enabled
            found = True
    if found:
        await _write_entries(entries)
        logger.info("Pool entry '%s' %s", entry_id, "enabled" if enabled else "disabled")
    return found
