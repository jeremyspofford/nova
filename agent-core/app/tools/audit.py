"""Hash-chained event writer for task_events."""
import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_GENESIS_HASH = "0" * 64


async def write_event(pool, task_id: str, event_type: str, payload: dict) -> str:
    """Write one event. Returns event_id."""
    event_id = str(uuid.uuid4())
    occurred_at = datetime.now(timezone.utc)
    occurred_at_str = occurred_at.strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")

    async with pool.acquire() as conn:
        async with conn.transaction():
            row = await conn.fetchrow(
                "SELECT chain_hash FROM task_events "
                "WHERE task_id = $1 ORDER BY occurred_at DESC LIMIT 1 FOR UPDATE",
                task_id,
            )
            prev_hash = row["chain_hash"] if row and row["chain_hash"] else _GENESIS_HASH

            content = json.dumps({
                "event_id": event_id,
                "task_id": task_id,
                "event_type": event_type,
                "payload": payload,
                "occurred_at": occurred_at_str,
                "prev_hash": prev_hash,
            }, sort_keys=True)
            chain_hash = hashlib.sha256(content.encode()).hexdigest()

            await conn.execute(
                """
                INSERT INTO task_events
                    (id, task_id, type, event_type, payload, prev_hash, chain_hash, occurred_at, created_at, hash)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, $7)
                """,
                event_id, task_id, event_type, event_type,
                json.dumps(payload), prev_hash, chain_hash, occurred_at,
            )

    logger.debug("event %s:%s task=%s", event_type, event_id[:8], task_id[:8])
    return event_id


async def verify_chain(pool, task_id: str) -> tuple[bool, str]:
    """Walk task_events and recompute hashes."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, event_type, payload, occurred_at, prev_hash, chain_hash "
            "FROM task_events WHERE task_id = $1 AND chain_hash != '' ORDER BY occurred_at",
            task_id,
        )

    prev = _GENESIS_HASH
    for row in rows:
        occurred_at_str = row["occurred_at"].astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f+00:00")
        content = json.dumps({
            "event_id": row["id"],
            "task_id": task_id,
            "event_type": row["event_type"],
            "payload": json.loads(row["payload"]),
            "occurred_at": occurred_at_str,
            "prev_hash": row["prev_hash"],
        }, sort_keys=True)
        expected = hashlib.sha256(content.encode()).hexdigest()

        if row["prev_hash"] != prev:
            return False, f"Chain broken at {row['id']}: prev_hash mismatch"
        if row["chain_hash"] != expected:
            return False, f"Chain broken at {row['id']}: chain_hash mismatch"
        prev = row["chain_hash"]

    return True, ""
