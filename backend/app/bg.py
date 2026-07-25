"""Fire-and-forget background tasks that actually survive.

asyncio keeps only a WEAK reference to a running task. `ensure_future(f())`
with nothing holding the returned future is therefore a task the garbage
collector may collect — and so cancel — at any point before it finishes.
CPython's own docs say to save a reference; nothing in this codebase did, at
ten call sites, and they were not decorative work:

    trace.py            the whole turn-ledger flush
    router_chat.py      tool-audit message rows, compaction, the reply push
    runner.py           drain-after-cancel, fallback alert, narration journal
    rules.py            rule hit counts
    tools/registry.py   the MCP tool-cache refresh
    models_catalog.py   an in-progress model pull (multi-GB, minutes long)
    recommendations.py  the recommendation ping

The failure mode is the nastiest kind: rare, load-dependent, and silent —
the work simply did not happen, with no error anywhere. Holding a strong
reference until the task completes costs one set.

Exceptions are logged here too. A bare ensure_future swallows them into a
"Task exception was never retrieved" warning at GC time, long after the
context that would have explained it is gone.
"""

import asyncio
import logging
from typing import Any, Coroutine

log = logging.getLogger(__name__)

_tasks: set[asyncio.Task] = set()


def spawn(coro: Coroutine[Any, Any, Any], *, name: str | None = None) -> asyncio.Task:
    """Run `coro` detached, keeping it alive until it finishes."""
    task = asyncio.ensure_future(coro)
    if name:
        try:
            task.set_name(name)
        except AttributeError:      # a Future, not a Task
            pass
    _tasks.add(task)
    task.add_done_callback(_finished)
    return task


def _finished(task: asyncio.Task) -> None:
    _tasks.discard(task)
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        log.error("background task %s failed: %r", task.get_name(), exc,
                  exc_info=exc)


def pending() -> int:
    """How many are in flight — for tests and the observability surface."""
    return len(_tasks)
