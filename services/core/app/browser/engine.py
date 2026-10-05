"""The one way core calls her browser's engine (S38).

The engine is Microsoft's Playwright MCP server in the `browser` service
(deploy/docker-compose.yml), reached at BROWSER_MCP_URL through S37a's MCP
client — never through her mcp_call, and never a row in mcp_servers. It speaks
only the 2025 protocol era (measured 2026-09-30: `server/discover` answers
HTTP 400 with -32000 "Bad Request: Server not initialized"), which the client
finds, remembers, and re-establishes when the engine forgets its session.

One page serves every turn and session (`--shared-browser-context`, which a
persistent profile requires), so a tool runs its calls inside session(): a
navigation and the read after it are never split by another turn's call.
Between two tool calls another turn may still move the page; every result
names the page it saw, so that is visible, never silent.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import os
import weakref
from collections.abc import AsyncIterator, Mapping
from typing import Any

from app.browser import page
from app.mcp import client

ENDPOINT_ENV = "BROWSER_MCP_URL"
DEFAULT_URL = "http://browser:8931/mcp"
ENGINE_NAME = "browser"
CALL_TIMEOUT_S = 60.0

# One lock per event loop: an asyncio.Lock that has waited is bound to the
# loop it waited on, and a test suite runs many loops. Production has one.
_LOCKS: weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = (
    weakref.WeakKeyDictionary()
)


class EngineError(Exception):
    """The engine could not be asked — not answering, not an MCP server, or
    the exchange broke. `reason` is a sentence for her."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def endpoint() -> client.Endpoint:
    return client.Endpoint(ENGINE_NAME, os.environ.get(ENDPOINT_ENV) or DEFAULT_URL)


@contextlib.asynccontextmanager
async def session() -> AsyncIterator[None]:
    """Hold the engine for one tool's whole sequence of calls."""
    loop = asyncio.get_running_loop()
    lock = _LOCKS.get(loop)
    if lock is None:
        lock = _LOCKS[loop] = asyncio.Lock()
    async with lock:
        yield


async def call(
    tool: str, arguments: Mapping[str, Any], *, timeout_s: float = CALL_TIMEOUT_S
) -> page.EngineAnswer:
    """One engine tool call, read. A call the engine ANSWERED always comes
    back as an EngineAnswer — its own refusal (a stale ref, an open dialog, a
    page that did not load) is the answer's `error`. Only a call that could
    not be made raises EngineError. Callers hold session()."""
    target = endpoint()
    try:
        result = await client.call(target, tool, arguments, timeout_s=timeout_s)
    except client.ClientError as exc:
        if exc.reachable:
            raise EngineError(
                f"the browser engine at {target.origin} answered, but not usefully: {exc.reason}"
            ) from exc
        raise EngineError(
            f"the browser engine is not answering at {target.origin} — {exc.reason}"
        ) from exc
    answer = page.parse(result.text)
    if result.is_error and answer.error is None:
        lines = (result.text or "").strip().splitlines()
        answer = dataclasses.replace(
            answer, error=lines[0] if lines else "the engine reported an error and gave no reason"
        )
    return answer
