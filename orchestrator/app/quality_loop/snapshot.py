"""Capture, hash, and persist quality-relevant configuration snapshots.

A snapshot freezes everything that could affect quality scores: model
assignments, retrieval params, prompt versions, consolidation params.
Hashed for dedup — most adjacent benchmark runs have identical configs.
"""
from __future__ import annotations

import hashlib
import json
import logging
from typing import Any
from uuid import UUID

import redis.asyncio as aioredis
from app.db import get_pool

log = logging.getLogger(__name__)

# Redis keys whose values become part of the snapshot
_RUNTIME_CONFIG_KEYS = [
    "nova:config:retrieval.top_k",
    "nova:config:retrieval.threshold",
    "nova:config:retrieval.spread_weight",
    "nova:config:llm.routing_strategy",
    "nova:config:inference.backend",
    "nova:config:memory.backend",
]


def normalize_config(config: dict[str, Any]) -> str:
    """Deterministic JSON serialization for hashing.

    Recursive sort_keys ensures {"a": 1, "b": 2} hashes identically to
    {"b": 2, "a": 1}. separators removes whitespace variation.
    """
    return json.dumps(config, sort_keys=True, separators=(",", ":"))


def hash_config(config: dict[str, Any]) -> str:
    """SHA-256 of the normalized config — used as the unique key for dedup."""
    return hashlib.sha256(normalize_config(config).encode("utf-8")).hexdigest()


async def _read_runtime_config() -> dict[str, Any]:
    """Read all relevant Redis runtime-config keys + DB platform_config rows.

    Note: nova:config:* keys live in Redis db1 (the gateway's namespace), populated
    by sync_*_config_to_redis() functions in app.config_sync. We open a dedicated
    connection there rather than reusing app.store.get_redis() (db2).

    Redis and DB reads are not transactional — they happen sequentially within
    the same function call but not atomically.
    """
    from app.config_sync import _gateway_redis_url
    pool = get_pool()

    runtime: dict[str, Any] = {}
    redis = aioredis.from_url(_gateway_redis_url(), decode_responses=True)
    try:
        for key in _RUNTIME_CONFIG_KEYS:
            try:
                val = await redis.get(key)
                if val is not None:
                    runtime[key.replace("nova:config:", "")] = val
            except Exception as e:
                log.debug("snapshot: failed to read %s: %s", key, e)
    finally:
        await redis.aclose()

    # Pull current model assignments from platform_config
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT key, value FROM platform_config WHERE key LIKE 'llm.%' OR key LIKE 'models.%'"
        )
    models = {row["key"]: row["value"] for row in rows}
    return {"runtime": runtime, "models": models}


async def capture_snapshot(captured_by: str) -> tuple[UUID, dict[str, Any]]:
    """Capture current config, dedup by hash, return (snapshot_id, config_dict).

    `captured_by`: one of "benchmark_run", "loop_session", "manual".
    """
    config = await _read_runtime_config()
    config_hash = hash_config(config)

    pool = get_pool()
    async with pool.acquire() as conn:
        # INSERT ... ON CONFLICT returns existing row's id when hash already present
        row = await conn.fetchrow(
            """
            INSERT INTO quality_config_snapshots (config_hash, config, captured_by)
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT (config_hash) DO UPDATE
                SET config_hash = EXCLUDED.config_hash
            RETURNING id
            """,
            config_hash,
            json.dumps(config),
            captured_by,
        )
    return row["id"], config
