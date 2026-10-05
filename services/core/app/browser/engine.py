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
from contextvars import ContextVar
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

# Whether the current task is inside session() (fix round 1, item 2): a
# ContextVar, not a flag on the lock itself, because what call() must refuse
# is being called WITHOUT the contract, not being called while the lock
# happens to be free. A per-task copy, so two sessions on two gathered tasks
# never see each other's.
_IN_SESSION: ContextVar[bool] = ContextVar("browser_engine_in_session", default=False)


class EngineError(Exception):
    """The engine could not be asked — not answering, not an MCP server, or
    the exchange broke. `reason` is a sentence for her, passed through
    exactly as whatever established it stated — this module composes no
    claim of its own about what happened (fix round 1, G31: `reachable=True`
    means only that the engine HAD the request, which is not the same as it
    answering usefully, and saying both at once can contradict itself).
    `reachable` is a structured fact for a caller to read directly, never
    parsed out of `reason`'s prose: True the engine had the request (its own
    refusal, a broken stream, a malformed answer); False it never did
    (unreachable, a credential this client refused to send); None when the
    failure was decided before any call was attempted."""

    def __init__(self, reason: str, *, reachable: bool | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.reachable = reachable


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
        token = _IN_SESSION.set(True)
        try:
            yield
        finally:
            _IN_SESSION.reset(token)


async def call(
    tool: str, arguments: Mapping[str, Any], *, timeout_s: float = CALL_TIMEOUT_S
) -> page.EngineAnswer:
    """One engine tool call, read. A call the engine ANSWERED always comes
    back as an EngineAnswer — its own refusal (a stale ref, an open dialog, a
    page that did not load) is the answer's `error`. Only a call that could
    not be made raises EngineError. Callers hold session() — checked
    mechanically (fix round 1, item 2): a RuntimeError, never an EngineError,
    because a caller that forgot the `async with` is a bug in that caller's
    code, not a fact about the browser to show her."""
    if not _IN_SESSION.get():
        raise RuntimeError(
            "app.browser.engine.call() was called outside engine.session() — "
            "a tool's whole sequence of calls must run inside one `async with "
            "engine.session():` block, never split"
        )
    target = endpoint()
    try:
        result = await client.call(target, tool, arguments, timeout_s=timeout_s)
    except client.ClientError as exc:
        raise EngineError(exc.reason, reachable=exc.reachable) from exc
    answer = page.parse(result.text)
    if result.is_error and answer.error is None:
        lines = (result.text or "").strip().splitlines()
        answer = dataclasses.replace(
            answer, error=lines[0] if lines else "the engine reported an error and gave no reason"
        )
    return answer
