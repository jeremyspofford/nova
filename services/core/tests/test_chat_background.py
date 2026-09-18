"""drain_background must yield to the loop, or a finished task can hang it.

Item 0, 2026-09-18: the full core suite wedged at ~12%, a different chat test
each time, never in isolation. Measured, not argued: the set held ONE task,
finished (no exception, not cancelled), on the running loop, with both of its
done-callbacks — `_BACKGROUND.discard` among them — sitting uncancelled in the
loop's ready queue and never run. drain_background was spinning over it.

The mechanism: since CPython 3.12, `asyncio.gather` completes EAGERLY when
every child is already done — it runs its own done-callbacks synchronously and
hands back a finished future, and awaiting a finished future does not yield.
A task that has finished but whose `discard` has not run yet is a normal state
for one loop iteration. Enter drain_background in that window and `while
_BACKGROUND: await gather(...)` never lets the loop run again, so the discard
never runs, so the set never empties. The conftest's `wait_for(..., 15)` could
not fire either: a timeout needs the loop too.

No database here: the defect is pure asyncio, so the test is too.
"""

from __future__ import annotations

import asyncio

from app import chat


async def test_drain_returns_when_only_finished_tasks_remain(monkeypatch):
    async def quick() -> None:
        return None

    task = chat._spawn(quick())
    # One yield runs the task to completion. Its done-callbacks are queued for
    # the NEXT iteration, so the task is finished and still in the set: the
    # exact state the wedge was measured in.
    await asyncio.sleep(0)
    assert task.done()
    assert task in chat._BACKGROUND

    # A spinning drain never yields, so no asyncio timeout can stop it. Count
    # the rounds instead and fail loudly well before "forever".
    real_gather = asyncio.gather
    rounds = 0

    def counting_gather(*aws, **kwargs):
        nonlocal rounds
        rounds += 1
        if rounds > 100:
            raise AssertionError(f"drain_background spun {rounds} rounds over finished tasks")
        return real_gather(*aws, **kwargs)

    monkeypatch.setattr(asyncio, "gather", counting_gather)

    await chat.drain_background()

    assert not chat._BACKGROUND
