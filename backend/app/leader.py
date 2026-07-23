"""Leader election via a postgres advisory lock (remote-shared-state phase 1).

With several backends on one shared DB, the fleet's singleton work —
automations scheduling, retention prunes, alert evaluation — must run
exactly once. The election is a session-scoped advisory lock on a dedicated
connection: the holder is the leader, and postgres releases the lock the
moment that session dies, so a crashed leader is replaced within one retry
interval with no heartbeat table and no split-brain window.

Fail-safe direction: any doubt (connection lost, query failed) demotes this
instance immediately. Thirty leaderless seconds are recoverable; two
concurrent leaders double-run automations.

Callers never import this directly for gating — they go through
`instances.is_leader()`, which delegates here (the seam established by the
observability lane so nothing else changes when leadership becomes real).
"""

import asyncio
import logging

import asyncpg

from app.config import settings

log = logging.getLogger(__name__)

# 'NOVA' — advisory-lock ids are global per-DB: this one belongs to leader
# election, never reuse it for another lock.
LOCK_ID = 0x4E4F5641
RETRY_S = 30

_is_leader = False
_conn: asyncpg.Connection | None = None
_task: asyncio.Task | None = None
_on_promoted: list = []


def is_leader() -> bool:
    return _is_leader


def on_promoted(cb) -> None:
    """Register an async callback fired once per promotion."""
    _on_promoted.append(cb)


async def _demote(reason: str) -> None:
    global _is_leader, _conn
    if _is_leader:
        log.warning("leader: demoted (%s)", reason)
    _is_leader = False
    if _conn is not None:
        try:
            await _conn.close()
        except Exception:
            pass
        _conn = None


async def _try_acquire() -> None:
    global _is_leader, _conn
    if _conn is None:
        # dedicated session — the lock's lifetime IS this connection's
        # lifetime, so it must never come from the shared pool
        _conn = await asyncpg.connect(settings.database_url, timeout=10)
    if _is_leader:
        # liveness probe: a dead session already lost the lock in PG's
        # eyes, so we must notice and stop acting like the leader
        await _conn.fetchval("SELECT 1")
        return
    got = await _conn.fetchval("SELECT pg_try_advisory_lock($1)", LOCK_ID)
    if got:
        _is_leader = True
        log.info("leader: acquired — this instance runs the fleet singletons")
        for cb in _on_promoted:
            try:
                await cb()
            except Exception:
                log.exception("leader: on_promoted callback failed")


async def _loop() -> None:
    while True:
        try:
            await _try_acquire()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            await _demote(f"election error: {e}")
        await asyncio.sleep(RETRY_S)


async def start() -> None:
    """Begin (and keep retrying) the election. First attempt is awaited so a
    single-instance deployment is leader before the first scheduler tick."""
    global _task
    try:
        await _try_acquire()
    except Exception as e:
        log.warning("leader: initial election failed (%s); retrying in background", e)
        await _demote(str(e))
    _task = asyncio.create_task(_loop())


async def stop() -> None:
    global _task
    if _task:
        _task.cancel()
        try:
            await _task
        except asyncio.CancelledError:
            pass
        _task = None
    await _demote("shutdown")
