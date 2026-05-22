"""NDJSON stream consumption + concurrent approval-grant.

The agent-core stream endpoint returns text/plain NDJSON (not SSE).
MUTATE tools block 300s on capability.py:97 waiting for approval — we grant
concurrently as soon as a tool_approval_request line appears.
"""
from __future__ import annotations
import asyncio
import json
from typing import AsyncIterator, Awaitable, Callable


async def parse_ndjson_lines(
    line_iter: AsyncIterator[bytes],
) -> AsyncIterator[dict]:
    """Yield parsed JSON objects from a byte-line iterator. Skip blanks and unparseable lines."""
    async for raw in line_iter:
        line = raw.decode("utf-8", errors="replace").strip() if isinstance(raw, bytes) else raw.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


async def consume_stream_with_approval_grant(
    line_iter: AsyncIterator[bytes],
    grant_fn: Callable[[str], Awaitable[None]],
) -> dict:
    """Consume NDJSON, dispatch grant_fn for each unique tool_approval_request,
    return the final assistant-text-bearing line (or the last line seen).

    grant_fn is called at most once per tool_call_id, in a fire-and-forget task
    so it doesn't block stream consumption.
    """
    granted: set[str] = set()
    pending_grants: list[asyncio.Task] = []
    final: dict = {}
    saw_text = False
    async for event in parse_ndjson_lines(line_iter):
        if event.get("type") == "tool_approval_request":
            call_id = event.get("tool_call_id")
            if call_id and call_id not in granted:
                granted.add(call_id)
                pending_grants.append(asyncio.create_task(grant_fn(call_id)))
        elif "text" in event:
            final = event
            saw_text = True
        elif event.get("type") in {"meta", "error"} and not saw_text:
            # Capture meta/error as fallback, but never let a trailing meta/error
            # overwrite an assistant text we already captured — the harness reads
            # final["text"] for response-contains verification.
            final = event
    if pending_grants:
        await asyncio.gather(*pending_grants, return_exceptions=True)
    return final
