"""Automations store — CRUD shared by the API endpoints, the
manage_automations tool, and the scheduler."""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from app import db

log = logging.getLogger(__name__)

_FIELDS = ("id", "name", "description", "instruction", "agent_name",
           "interval_minutes", "timeout_seconds", "enabled", "is_system",
           "consecutive_failures", "last_run_at", "next_run_at", "last_status",
           "last_summary", "created_at")

_UPDATABLE = {"description", "instruction", "agent_name", "interval_minutes",
              "timeout_seconds", "enabled"}


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    for k in ("last_run_at", "next_run_at", "created_at"):
        d[k] = str(d[k]) if d[k] else None
    return d


async def list_automations() -> list[dict]:
    async with db.acquire() as conn:
        return [_row(r) for r in await conn.fetch(
            "SELECT * FROM automations ORDER BY name")]


async def get_by_name(name: str) -> Optional[dict]:
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM automations WHERE name = $1", name)
        return _row(r) if r else None


async def create(name: str, instruction: str, agent_name: str,
                 interval_minutes: int, description: str = "",
                 timeout_seconds: Optional[int] = None) -> dict:
    if interval_minutes < 5:
        raise ValueError("interval_minutes must be at least 5")
    if timeout_seconds is not None and timeout_seconds < 30:
        raise ValueError("timeout_seconds must be at least 30 (or omitted "
                         "for the global default)")
    async with db.acquire() as conn:
        agent = await conn.fetchrow(
            "SELECT 1 FROM agents WHERE name = $1 AND enabled", agent_name)
        if not agent:
            raise ValueError(f"agent '{agent_name}' not found or disabled")
        r = await conn.fetchrow(
            """INSERT INTO automations (name, description, instruction, agent_name,
                                        interval_minutes, timeout_seconds, next_run_at)
               VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(mins => $5))
               RETURNING *""",
            name, description, instruction, agent_name, interval_minutes,
            timeout_seconds)
    log.info("Automation created: %s (every %dm, agent=%s)",
             name, interval_minutes, agent_name)
    return _row(r)


async def update(automation_id: str, **updates) -> bool:
    updates = {k: v for k, v in updates.items() if k in _UPDATABLE}
    if not updates:
        return False
    clauses, params = [], [uuid.UUID(automation_id)]
    for i, (k, v) in enumerate(updates.items(), start=2):
        clauses.append(f"{k} = ${i}")
        params.append(v)
    # re-enable clears the failure streak so it gets a fresh chance
    extra = ", consecutive_failures = 0" if updates.get("enabled") is True else ""
    async with db.acquire() as conn:
        result = await conn.execute(
            f"UPDATE automations SET {', '.join(clauses)}{extra}, updated_at = now() "
            f"WHERE id = $1", *params)
    return result.endswith("1")


async def delete(automation_id: str) -> str:
    """Delete a non-system automation. Returns 'deleted' | 'not_found' | 'is_system'."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT is_system, name FROM automations WHERE id = $1",
            uuid.UUID(automation_id))
        if not row:
            return "not_found"
        if row["is_system"]:
            return "is_system"
        await conn.execute("DELETE FROM automations WHERE id = $1",
                           uuid.UUID(automation_id))
    log.info("Automation deleted: %s", row["name"])
    return "deleted"


async def due() -> list[dict]:
    async with db.acquire() as conn:
        return [_row(r) for r in await conn.fetch(
            "SELECT * FROM automations WHERE enabled AND next_run_at <= now() "
            "ORDER BY next_run_at")]


_RUNS_KEPT = 50  # per-automation history retention


async def record_run(automation_id: str, status: str, summary: str,
                     interval_minutes: int, failed: bool,
                     started_at: Optional[datetime] = None):
    now = datetime.now(timezone.utc)
    next_run = now + timedelta(minutes=interval_minutes)
    started = started_at or now
    aid = uuid.UUID(automation_id)
    async with db.acquire() as conn:
        await conn.execute(
            """INSERT INTO automation_runs (automation_id, status, summary,
                                            started_at, duration_seconds)
               VALUES ($1, $2, $3, $4, $5)""",
            aid, status, summary[:1000], started,
            max((now - started).total_seconds(), 0.0))
        await conn.execute(
            """DELETE FROM automation_runs
               WHERE automation_id = $1 AND id NOT IN (
                   SELECT id FROM automation_runs WHERE automation_id = $1
                   ORDER BY started_at DESC LIMIT $2)""", aid, _RUNS_KEPT)
        if failed:
            row = await conn.fetchrow(
                """UPDATE automations
                   SET last_run_at = now(), next_run_at = $2, last_status = $3,
                       last_summary = $4, consecutive_failures = consecutive_failures + 1,
                       updated_at = now()
                   WHERE id = $1
                   RETURNING name, consecutive_failures""",
                uuid.UUID(automation_id), next_run, status, summary[:1000])
            if row and row["consecutive_failures"] >= 5:
                await conn.execute(
                    "UPDATE automations SET enabled = false WHERE id = $1",
                    uuid.UUID(automation_id))
                log.warning("Automation '%s' auto-disabled after %d consecutive failures",
                            row["name"], row["consecutive_failures"])
                return "auto_disabled"
        else:
            await conn.execute(
                """UPDATE automations
                   SET last_run_at = now(), next_run_at = $2, last_status = $3,
                       last_summary = $4, consecutive_failures = 0, updated_at = now()
                   WHERE id = $1""",
                uuid.UUID(automation_id), next_run, status, summary[:1000])
    return None


async def list_runs(automation_id: str, limit: int = 20) -> list[dict]:
    """Recent run history, newest first."""
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, status, summary, started_at, duration_seconds
               FROM automation_runs WHERE automation_id = $1
               ORDER BY started_at DESC LIMIT $2""",
            uuid.UUID(automation_id), min(max(limit, 1), _RUNS_KEPT))
    return [{"id": str(r["id"]), "status": r["status"], "summary": r["summary"],
             "started_at": r["started_at"].isoformat(),
             "duration_seconds": round(r["duration_seconds"], 1)} for r in rows]
