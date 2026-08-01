"""Automations store — CRUD shared by the API endpoints, the
manage_automations tool, and the scheduler.

Config changes are recorded in `capability_events`, and the emits live HERE
rather than in the two callers, because this is where the operator's browser
and the model's tool call already converge — an emit per caller is a list
someone maintains, and the caller anyone forgets is the one that mattered.

Stated boundary: a migration that edits a row with raw SQL (026 rewrites
tech-news-digest's instruction) is invisible to this. Instrumenting SQL would
mean a hand-written INSERT in every future migration, and the migration file
in git is already the record. That is a choice, not an oversight.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from app import db, settings_store
from app.llm import router as llm_router

log = logging.getLogger(__name__)

_SUMMARY_SYSTEM = (
    "In one plain sentence of at most 15 words, say what this scheduled "
    "automation does — for a human scanning a list. Output only the sentence, "
    "no preamble or quotes.")


async def _auto_description(instruction: str) -> str:
    """Best-effort one-line note when none was supplied, so the card is never
    blank. Never blocks create: any failure falls back to a trim of the
    instruction. (docs decision 2026-07-21: show the logic + auto-summary.)"""
    flat = " ".join((instruction or "").split())
    fallback = (flat[:117] + "…") if len(flat) > 120 else flat
    try:
        # Its OWN role. This used to read `compaction.model` — a feature with
        # no binding of its own quietly borrowing another's, which is what
        # happens when there is no home for "which model does what". It also
        # meant the only way to give automations a model was to change the
        # summariser's, and the only way to read which model wrote these
        # descriptions was to know about this line.
        model = llm_router.effective_model(settings_store.get("automations.model") or "")
        if not model:
            return fallback
        text = ""
        async for event in llm_router.stream_chat(
                [{"role": "system", "content": _SUMMARY_SYSTEM},
                 {"role": "user", "content": instruction}], model):
            if event.get("type") == "text":
                text += event["text"]
            elif event.get("type") == "error":
                return fallback
        first = text.strip().strip('"').splitlines()[0] if text.strip() else ""
        return first[:160] or fallback
    except Exception:
        log.warning("auto-description failed; using a trim of the instruction",
                    exc_info=True)
        return fallback

_FIELDS = ("id", "name", "description", "instruction", "agent_name",
           "interval_minutes", "timeout_seconds", "enabled", "is_system",
           "consecutive_failures", "last_run_at", "next_run_at", "last_status",
           "last_summary", "created_at")

# Public because the HTTP route filters an incoming body against it before
# calling update(). A second copy in the router would be the scopes.py lesson
# again — that list was duplicated by hand and the duplicate drifted within
# an hour — and here the drift would be silent: a field the router let
# through and this set did not would simply not be written.
UPDATABLE = {"description", "instruction", "agent_name", "interval_minutes",
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
                 timeout_seconds: Optional[int] = None,
                 actor: Optional[str] = None) -> dict:
    if interval_minutes < 5:
        raise ValueError("interval_minutes must be at least 5")
    if timeout_seconds is not None and timeout_seconds < 30:
        raise ValueError("timeout_seconds must be at least 30 (or omitted "
                         "for the global default)")
    if not (description or "").strip():
        description = await _auto_description(instruction)   # never leave it blank
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
    from app import capability_events as ce
    ce.record(ce.AUTOMATION, name, "created", actor=actor or "operator",
              detail={"agent": agent_name, "every": f"{interval_minutes}m"})
    return _row(r)


async def update(automation_id: str, *, operator: bool = False,
                 actor: Optional[str] = None, **updates) -> bool:
    """`operator=True` is the human at the Settings UI, reached only through
    the authenticated HTTP route. Everything else is a model, and says so."""
    updates = {k: v for k, v in updates.items() if k in UPDATABLE}
    if not updates:
        return False
    # The same checks create() makes. They were missing here, and the failure
    # is silent and delayed rather than loud: an automation repointed at an
    # agent that does not exist keeps its row, runs on schedule, fails, and is
    # auto-disabled five runs later — so the operator learns a week after the
    # typo, from an automation that simply stopped. Found by pointing
    # review-memory-usage at "operator" while testing this file's own events.
    if "interval_minutes" in updates and updates["interval_minutes"] < 5:
        raise ValueError("interval_minutes must be at least 5")
    if updates.get("timeout_seconds") is not None and updates["timeout_seconds"] < 30:
        raise ValueError("timeout_seconds must be at least 30 (or omitted "
                         "for the global default)")
    if "agent_name" in updates:
        async with db.acquire() as conn:
            if not await conn.fetchrow(
                    "SELECT 1 FROM agents WHERE name = $1 AND enabled",
                    updates["agent_name"]):
                raise ValueError(
                    f"agent '{updates['agent_name']}' not found or disabled")
    clauses, params = [], [uuid.UUID(automation_id)]
    for i, (k, v) in enumerate(updates.items(), start=2):
        clauses.append(f"{k} = ${i}")
        params.append(v)
    # re-enable clears the failure streak so it gets a fresh chance
    extra = ", consecutive_failures = 0" if updates.get("enabled") is True else ""
    async with db.acquire() as conn:
        # read BEFORE the write: an enable is only a change against what was
        # there before, and afterwards the previous value is gone. This is
        # also the only way to tell a real flip from a UI save that posted
        # the toggle unchanged.
        prev = await conn.fetchrow(
            "SELECT name, description, instruction, agent_name, interval_minutes, "
            "timeout_seconds, enabled FROM automations WHERE id = $1",
            uuid.UUID(automation_id))
        result = await conn.execute(
            f"UPDATE automations SET {', '.join(clauses)}{extra}, updated_at = now() "
            f"WHERE id = $1", *params)
    ok = result.endswith("1")
    if ok and prev:
        _record_update(dict(prev), updates, operator, actor)
    return ok


def _record_update(prev: dict, updates: dict, operator: bool,
                   actor: Optional[str]) -> None:
    """Turn an UPDATE into the smallest true statement about it."""
    from app import capability_events as ce
    who = actor or ("operator" if operator else "an agent")
    changed = {k for k, v in updates.items() if v != prev.get(k)}
    detail = {}
    # Which agent runs it is a capability fact, not a cosmetic one: it decides
    # which tools the unattended turn holds.
    if "agent_name" in changed:
        detail["agent"] = updates["agent_name"]
    if "interval_minutes" in changed:
        detail["every"] = f"{updates['interval_minutes']}m"
    # The names only, never the values. instruction IS prompt text, and this
    # block is read back into a prompt (capability_events docstring).
    rest = sorted(changed - {"agent_name", "interval_minutes", "enabled"})
    if rest:
        detail["changed"] = ", ".join(rest)
    # enabled is its own verb, because "who turned this on" is the question
    # being asked and "updated" would bury it
    if "enabled" in changed:
        ce.record(ce.AUTOMATION, prev["name"],
                  "enabled" if updates["enabled"] else "disabled",
                  actor=who, detail=detail)
        return
    # A change record that records no change is noise in the one place noise
    # is most expensive. Every UI save posts the whole form, so without this
    # an operator opening a card and closing it mints an event.
    if detail:
        ce.record(ce.AUTOMATION, prev["name"], "updated", actor=who, detail=detail)


async def delete(automation_id: str, *, actor: Optional[str] = None) -> str:
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
    from app import capability_events as ce
    ce.record(ce.AUTOMATION, row["name"], "deleted", actor=actor or "operator")
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
    # Set when the streak trips the kill switch below, so the event is emitted
    # after the connection block like every other one in this file.
    self_disabled: Optional[tuple[str, int]] = None
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
                self_disabled = (row["name"], row["consecutive_failures"])
        else:
            await conn.execute(
                """UPDATE automations
                   SET last_run_at = now(), next_run_at = $2, last_status = $3,
                       last_summary = $4, consecutive_failures = 0, updated_at = now()
                   WHERE id = $1""",
                uuid.UUID(automation_id), next_run, status, summary[:1000])
    if self_disabled:
        name, failures = self_disabled
        log.warning("Automation '%s' auto-disabled after %d consecutive failures",
                    name, failures)
        # The one event here with no human behind it, so the actor says so.
        # Everything else in record_run is bookkeeping — last_run_at moving is
        # the automation working — but `enabled` going false is a capability
        # she lost without anybody choosing it, and "why did this stop running"
        # is unanswerable if the only record is a log line and a journal entry
        # she never reads back.
        from app import capability_events as ce
        ce.record(ce.AUTOMATION, name, "disabled", actor="the scheduler",
                  detail={"reason": f"{failures} consecutive failures"})
        return "auto_disabled"
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
