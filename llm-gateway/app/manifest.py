"""Recommended-models manifest: bundled copy, daily remote refresh, disk cache.

The manifest is the single source of truth for the recommended list (the spec's fix
for v1's duplicated hardcoded lists). "Dynamic" means: update the file in the repo
and every install refetches it within a day — no registry scraping. Offline boxes
run on the bundled copy forever; failure here is never an error.
"""
from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import httpx

from .config import settings

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1
BUNDLED_PATH = Path(__file__).resolve().parent.parent / "data" / "recommended_models.json"

_memory_cache: dict[str, Any] | None = None
_memory_cache_time: float = 0.0
_MEMORY_TTL = 300.0  # re-evaluate sources every 5 min; remote fetch has its own 24h gate


def _cache_path() -> Path:
    return Path(settings.runtime_dir) / "manifest_cache.json"


def _valid(data: Any) -> bool:
    return (
        isinstance(data, dict)
        and isinstance(data.get("models"), list)
        and int(data.get("schema_version", 0)) <= SCHEMA_VERSION
    )


def _load_bundled() -> dict[str, Any]:
    data = json.loads(BUNDLED_PATH.read_text())
    data["_source"] = "bundled"
    data["_fetched_at"] = None
    return data


def _load_disk_cache() -> dict[str, Any] | None:
    path = _cache_path()
    try:
        if not path.exists():
            return None
        data = json.loads(path.read_text())
        if not _valid(data):
            return None
        data["_source"] = "remote"
        data["_fetched_at"] = path.stat().st_mtime
        return data
    except Exception as exc:
        logger.warning("manifest disk cache unreadable: %s", exc)
        return None


async def _refresh_remote() -> dict[str, Any] | None:
    """Fetch the manifest from the repo. Returns None on any failure."""
    try:
        async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
            r = await client.get(settings.manifest_url)
            r.raise_for_status()
            data = r.json()
        if not _valid(data):
            logger.warning("remote manifest invalid or newer schema — ignoring")
            return None
        path = _cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))
        data["_source"] = "remote"
        data["_fetched_at"] = time.time()
        logger.info("recommended-models manifest refreshed from %s", settings.manifest_url)
        return data
    except Exception as exc:
        logger.warning("manifest refresh failed (using cached/bundled): %s", exc)
        return None


async def get_manifest(force: bool = False) -> dict[str, Any]:
    """Best available manifest: fresh remote > disk cache > bundled."""
    global _memory_cache, _memory_cache_time
    now = time.monotonic()
    if not force and _memory_cache is not None and (now - _memory_cache_time) < _MEMORY_TTL:
        return _memory_cache

    disk = _load_disk_cache()
    disk_age = (time.time() - disk["_fetched_at"]) if disk else None
    stale = disk is None or disk_age is None or disk_age > settings.manifest_refresh_s

    result = None
    if force or stale:
        result = await _refresh_remote()
    if result is None:
        result = disk
    if result is None:
        result = _load_bundled()

    _memory_cache = result
    _memory_cache_time = now
    return result
