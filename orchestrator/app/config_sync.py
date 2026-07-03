"""Sync platform_config (DB) → Redis so LLM gateway picks up saved settings on boot."""
from __future__ import annotations

import json
import logging

import redis.asyncio as aioredis
from app.config import settings
from app.db import get_pool

log = logging.getLogger(__name__)


def _gateway_redis_url() -> str:
    """Redis URL targeting db1 (llm-gateway's database)."""
    return settings.redis_url.rsplit("/", 1)[0] + "/1"


async def push_config_to_redis(key: str, value) -> None:
    """Write a single config key to the gateway Redis (db1)."""
    r = aioredis.from_url(_gateway_redis_url(), decode_responses=True)
    try:
        raw = json.dumps(value) if not isinstance(value, str) else value
        await r.set(f"nova:config:{key}", raw)
    finally:
        await r.aclose()


async def sync_llm_config_to_redis() -> None:
    """Push all llm.* config from DB to Redis so LLM gateway has correct values on boot."""
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM platform_config WHERE key LIKE 'llm.%'"
            )
        if not rows:
            return

        r = aioredis.from_url(_gateway_redis_url(), decode_responses=True)
        try:
            for row in rows:
                val = row["value"]
                if val is not None:
                    raw = json.dumps(val) if not isinstance(val, str) else val
                    await r.set(f"nova:config:{row['key']}", raw)
        finally:
            await r.aclose()

        log.info("Synced %d llm config keys to Redis", len(rows))
    except Exception as e:
        log.warning("Config sync to Redis failed (non-fatal): %s", e)


async def sync_inference_config_to_redis() -> None:
    """Push inference.* defaults from DB to Redis, preserving runtime overrides.

    The recovery service writes backend choices directly to Redis (not DB),
    so existing Redis values take precedence over DB defaults.  DB values
    only fill in keys that are missing from Redis.
    """
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM platform_config WHERE key LIKE 'inference.%'"
            )
        if not rows:
            return

        r = aioredis.from_url(_gateway_redis_url(), decode_responses=True)
        try:
            seeded = 0
            for row in rows:
                val = row["value"]
                if val is None:
                    continue
                redis_key = f"nova:config:{row['key']}"
                existing = await r.get(redis_key)
                if existing is not None:
                    log.debug("Keeping runtime value for %s", row["key"])
                    continue
                raw = json.dumps(val) if not isinstance(val, str) else val
                await r.set(redis_key, raw)
                seeded += 1
        finally:
            await r.aclose()

        log.info("Inference config: seeded %d keys, %d already set at runtime",
                 seeded, len(rows) - seeded)
    except Exception as e:
        log.warning("Inference config sync to Redis failed (non-fatal): %s", e)


async def sync_voice_config_to_redis() -> None:
    """Push voice.* config from DB to Redis so voice-service picks up saved settings."""
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM platform_config WHERE key LIKE 'voice.%'"
            )
        if not rows:
            return

        r = aioredis.from_url(_gateway_redis_url(), decode_responses=True)
        try:
            for row in rows:
                val = row["value"]
                if val is not None:
                    raw = json.dumps(val) if not isinstance(val, str) else val
                    await r.set(f"nova:config:{row['key']}", raw)
        finally:
            await r.aclose()

        log.info("Synced %d voice config keys to Redis", len(rows))
    except Exception as e:
        log.warning("Voice config sync to Redis failed (non-fatal): %s", e)


async def sync_retrieval_config_to_redis() -> None:
    """Push retrieval.* config from DB to Redis so memory-service picks up saved settings."""
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM platform_config WHERE key LIKE 'retrieval.%'"
            )
        if not rows:
            return

        r = aioredis.from_url(_gateway_redis_url(), decode_responses=True)
        try:
            for row in rows:
                val = row["value"]
                if val is not None:
                    raw = json.dumps(val) if not isinstance(val, str) else val
                    await r.set(f"nova:config:{row['key']}", raw)
        finally:
            await r.aclose()

        log.info("Synced %d retrieval config keys to Redis", len(rows))
    except Exception as e:
        log.warning("Retrieval config sync to Redis failed (non-fatal): %s", e)


async def sync_quality_config_to_redis() -> None:
    """Push quality.* config from DB to Redis."""
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM platform_config WHERE key LIKE 'quality.%'"
            )
        if not rows:
            return

        r = aioredis.from_url(_gateway_redis_url(), decode_responses=True)
        try:
            for row in rows:
                val = row["value"]
                if val is not None:
                    raw = json.dumps(val) if not isinstance(val, str) else val
                    await r.set(f"nova:config:{row['key']}", raw)
        finally:
            await r.aclose()

        log.info("Synced %d quality config keys to Redis", len(rows))
    except Exception as e:
        log.warning("Quality config sync to Redis failed (non-fatal): %s", e)


async def sync_screenpipe_config_to_redis() -> None:
    """Push screenpipe.* and capture.* config from DB to Redis so screenpipe-bridge picks up saved settings."""
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM platform_config "
                "WHERE key LIKE 'screenpipe.%' OR key LIKE 'capture.%'"
            )
        if not rows:
            return

        r = aioredis.from_url(_gateway_redis_url(), decode_responses=True)
        try:
            for row in rows:
                val = row["value"]
                if val is not None:
                    raw = json.dumps(val) if not isinstance(val, str) else val
                    await r.set(f"nova:config:{row['key']}", raw)
        finally:
            await r.aclose()

        log.info("Synced %d screenpipe/capture config keys to Redis", len(rows))
    except Exception as e:
        log.warning("Screenpipe config sync to Redis failed (non-fatal): %s", e)


async def sync_features_config_to_redis() -> None:
    """Push features.* config to all service Redis DBs that need them.

    Unlike LLM config (db1 only), feature flags are read by cortex (db5),
    intel-worker (db6), and knowledge-worker (db8). Write to each.
    """
    SERVICE_DBS = [5, 6, 8]  # cortex, intel-worker, knowledge-worker
    try:
        pool = get_pool()
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                "SELECT key, value FROM platform_config WHERE key LIKE 'features.%'"
            )
        if not rows:
            return

        base_url = settings.redis_url.rsplit("/", 1)[0]
        for db in SERVICE_DBS:
            import re as _re
            db_url = _re.sub(r"/\d+$", f"/{db}", settings.redis_url)
            if f"/{db}" not in db_url:
                db_url = f"{base_url}/{db}"
            r = aioredis.from_url(db_url, decode_responses=True)
            try:
                for row in rows:
                    val = row["value"]
                    if val is not None:
                        raw = json.dumps(val) if not isinstance(val, str) else val
                        await r.set(f"nova:config:{row['key']}", raw)
            finally:
                await r.aclose()

        log.info("Synced %d features config keys to Redis dbs %s", len(rows), SERVICE_DBS)
    except Exception as e:
        log.warning("Features config sync to Redis failed (non-fatal): %s", e)
