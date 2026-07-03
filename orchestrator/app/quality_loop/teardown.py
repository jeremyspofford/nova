"""Delete benchmark-tagged memories after a run completes.

Without this, every benchmark pollutes the user's main memory store
with cases like "The user's favorite programming language is Rust" —
permanent test garbage tagged [benchmark:abc12345].

Neutral memory API: DELETE /api/v1/memory/item/{memory_id} → 204
"""
from __future__ import annotations

import logging

import httpx

log = logging.getLogger(__name__)

MEMORY_SERVICE = "http://memory-service:8002"


async def teardown_benchmark_memories(memory_ids: list[str]) -> int:
    """Delete the listed memory items. Returns count of successful deletes.

    Continues on individual failures — partial cleanup is better than
    aborting on the first error.
    """
    if not memory_ids:
        return 0
    deleted = 0
    async with httpx.AsyncClient(timeout=10) as client:
        for mid in memory_ids:
            try:
                r = await client.delete(f"{MEMORY_SERVICE}/api/v1/memory/item/{mid}")
                if 200 <= r.status_code < 300:
                    deleted += 1
                else:
                    log.warning(
                        "teardown: failed to delete memory %s: status=%s",
                        mid, r.status_code,
                    )
            except Exception as e:
                log.warning("teardown: exception deleting memory %s: %s", mid, e)
    return deleted
