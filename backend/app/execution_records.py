"""Execution records — one read-only derived view over the five execution
lifecycles, without touching any of them (TA-9 / D-019, Slice 3).

INTERNAL, TEST/ADMIN-ONLY. This module owns no table, has no write path, and
must never be imported by routes, tools, prompts, agents, UI, or any runtime
decision path — pinned mechanically by tests/test_execution_records.py, the
same posture as the governance ledger. The precedent is activity_log.py: a
read model derived at query time, never a second source of truth.

NO INFERENCE, by contract: principal, credential assurance, release context,
and cross-record links are NULL with provenance 'absent' unless a source
column stores them authoritatively. In particular: an automation firing is
NEVER correlated to the turn it caused (turn_traces carries only the
automation NAME — name+time is not a join), and an eval run is never
correlated to its eval-source turns. `trace_id` exists only for kind='turn',
where the record IS the trace (identity, not inference).

Status normalization (owner-approved, Slice 3): `status_raw` is always the
source's verbatim value; `status_class` maps only what is unambiguous and
sends everything else to 'other'. Turn status comes from turn_traces.status
(a real outcome column, stamped at flush) — turn_traces.source is an ORIGIN
label and is carried separately as `turn_source`, never used for status.
Execution status never encodes model/task quality: eval 'measured' maps to
succeeded only in the narrow sense that a measurement completed.

The FUTURE JOBS MAPPING (documented only, per D-019 — nothing here builds
it): a later 'job' unit = action_runs (the durable rows) + tasks.py (the
pending-question surface) + task_steps.py (the resumable-step contract),
presented through this record shape; automation_runs remain firings;
coding_sessions and eval_runs keep their own lifecycles behind the shared
interface. No physical merge is implied by that mapping.

Retention/classification: this view stores nothing and inherits each
source's policy — the windows are heterogeneous (traces prune ~14 days,
automation_runs are capped per automation, the rest are currently unpruned),
so a merged listing is not time-uniform. Rows are operational metadata,
local-only (D-013/D-014); large/free-text source columns are omitted and
named in provenance['omitted'] — read them on the source row.
"""

from __future__ import annotations

from typing import Optional

from app import db

LIMIT_MAX = 200

STATUS_CLASSES = ("running", "waiting", "succeeded", "failed", "cancelled",
                  "other")

#: kind -> {raw -> class}; anything unmapped falls to 'other' except the
#: coding non-terminal rule below.
STATUS_MAP = {
    "turn": {"ok": "succeeded", "error": "failed", "cancelled": "cancelled"},
    "action_run": {"queued": "waiting", "blocked": "waiting",
                   "running": "running", "succeeded": "succeeded",
                   "failed": "failed"},
    "automation_run": {"ok": "succeeded", "error": "failed",
                       "failed": "failed"},
    "coding_session": {"done": "succeeded", "failed": "failed",
                       "killed": "cancelled", "stalled": "other"},
    "eval_run": {"running": "running", "measured": "succeeded"},
}

_ERROR_CAP = 500

_ABSENT = ("principal", "credential_assurance", "release_id")


def _classify(kind: str, raw: Optional[str]) -> str:
    if raw is None:
        return "other"
    if kind == "coding_session" and raw not in STATUS_MAP[kind]:
        # Non-terminal states are running; the terminal set is the coder's
        # own, imported so a new terminal state cannot silently read as
        # running here (derived, never hand-copied).
        from app import coder
        return "running" if raw not in coder.TERMINAL else "other"
    return STATUS_MAP[kind].get(raw, "other")


def _base(kind: str, table: str, sid, raw, started, started_from: str,
          omitted: list[str]) -> dict:
    rec = {
        "kind": kind, "source_table": table, "source_id": str(sid),
        "status_raw": raw, "status_class": _classify(kind, raw),
        "turn_source": None, "started_at": started, "finished_at": None,
        "error": None, "conversation_id": None, "goal_id": None,
        "recommendation_id": None, "model": None, "actor_label": None,
        "duration_s": None, "automation_name": None, "trace_id": None,
        "principal": None, "credential_assurance": None, "release_id": None,
        "extra": {},
        "provenance": {"status_raw": "source", "started_at": started_from,
                       "turn_source": "absent", "trace_id": "absent",
                       "omitted": omitted,
                       **{f: "absent" for f in _ABSENT}},
    }
    return rec


def _stamp(rec: dict, field: str, value, how: str = "source") -> None:
    if value is not None:
        rec[field] = value
        rec["provenance"][field] = how


def _duration(rec: dict, started, finished) -> None:
    if started is not None and finished is not None:
        rec["duration_s"] = (finished - started).total_seconds()
        rec["provenance"]["duration_s"] = "derived"


def _map_turn(r) -> dict:
    rec = _base("turn", "turn_traces", r["id"], r["status"], r["started_at"],
                "source: started_at", omitted=[])
    rec["turn_source"] = r["source"]
    rec["provenance"]["turn_source"] = "source"
    # The record IS the trace — identity, the one non-NULL trace_id.
    rec["trace_id"] = str(r["id"])
    rec["provenance"]["trace_id"] = "source"
    _stamp(rec, "finished_at", r["finished_at"])
    _stamp(rec, "error", (r["error"] or None) and r["error"][:_ERROR_CAP])
    _stamp(rec, "conversation_id", str(r["conversation_id"]) if r["conversation_id"] else None)
    _stamp(rec, "model", r["model"])
    _duration(rec, r["started_at"], r["finished_at"])
    for k in ("instance_id", "automation"):
        if r[k] is not None:
            rec["extra"][k] = r[k]
    return rec


def _map_action_run(r) -> dict:
    started = r["started_at"] or r["created_at"]
    rec = _base("action_run", "action_runs", r["id"], r["status"], started,
                "source: started_at" if r["started_at"] else "source: created_at",
                omitted=["action", "steps", "result", "question", "answer"])
    _stamp(rec, "finished_at", r["finished_at"])
    _stamp(rec, "error", (r["error"] or None) and r["error"][:_ERROR_CAP])
    _stamp(rec, "conversation_id", str(r["conversation_id"]) if r["conversation_id"] else None)
    _stamp(rec, "goal_id", str(r["goal_id"]) if r["goal_id"] else None)
    _stamp(rec, "recommendation_id", str(r["recommendation_id"]))
    _stamp(rec, "actor_label", f"lane:{r['lane']}")
    _duration(rec, r["started_at"], r["finished_at"])
    rec["extra"] = {"action_type": r["action_type"],
                    "step_index": r["step_index"], "attempts": r["attempts"],
                    "orphans": r["orphans"]}
    return rec


def _map_automation_run(r) -> dict:
    rec = _base("automation_run", "automation_runs", r["id"], r["status"],
                r["started_at"], "source: started_at", omitted=["summary"])
    if r["duration_seconds"] is not None:
        rec["duration_s"] = float(r["duration_seconds"])
        rec["provenance"]["duration_s"] = "source"
    # The automation's name/agent come from a JOIN on automation_id — the
    # only derived link in this module; the firing is NOT correlated to any
    # turn (turn_traces holds only a name, and name+time is not a join).
    _stamp(rec, "automation_name", r["automation_name"], how="derived")
    _stamp(rec, "actor_label", r["agent_name"], how="derived")
    rec["extra"] = {"automation_id": str(r["automation_id"])}
    return rec


def _map_coding_session(r) -> dict:
    rec = _base("coding_session", "coding_sessions", r["id"], r["state"],
                r["created_at"], "source: created_at",
                omitted=["task", "patch", "denials", "commands", "diffstat",
                         "sandbox_detail", "review_detail", "eval_detail",
                         "eval_scores"])
    _stamp(rec, "error", (r["error"] or None) and r["error"][:_ERROR_CAP])
    _stamp(rec, "goal_id", str(r["goal_id"]) if r["goal_id"] else None)
    _stamp(rec, "model", r["model"])
    _stamp(rec, "actor_label", r["requested_by"])
    rec["extra"] = {k: (str(r[k]) if r[k] is not None else None) for k in
                    ("branch", "commit_sha", "mode", "sandbox_status",
                     "review_status", "eval_status", "continued_from",
                     "broker_session_id")}
    return rec


def _map_eval_run(r) -> dict:
    rec = _base("eval_run", "eval_runs", r["id"], r["status"], r["started_at"],
                "source: started_at", omitted=["detail", "announcement"])
    _stamp(rec, "finished_at", r["finished_at"])
    _stamp(rec, "error", (r["error"] or None) and r["error"][:_ERROR_CAP])
    _stamp(rec, "model", r["model"])
    if r["duration_s"] is not None:
        rec["duration_s"] = r["duration_s"]
        rec["provenance"]["duration_s"] = "source"
    else:
        _duration(rec, r["started_at"], r["finished_at"])
    rec["extra"] = {"suite": r["suite"], "suite_version": r["suite_version"],
                    "agent_name": r["agent_name"],
                    "tasks_total": r["tasks_total"],
                    "tasks_passed": r["tasks_passed"],
                    "tasks_gradeable": r["tasks_gradeable"],
                    "repeat_count": r["repeat_count"], "resumes": r["resumes"],
                    "claimed_by": r["claimed_by"]}
    return rec


_SOURCES = {
    "turn": ("SELECT * FROM turn_traces", "started_at", _map_turn),
    "action_run": ("SELECT * FROM action_runs", "coalesce(started_at, created_at)",
                   _map_action_run),
    "automation_run": (
        "SELECT ar.*, a.name AS automation_name, a.agent_name "
        "FROM automation_runs ar LEFT JOIN automations a ON a.id = ar.automation_id",
        "ar.started_at", _map_automation_run),
    "coding_session": ("SELECT * FROM coding_sessions", "created_at",
                       _map_coding_session),
    "eval_run": ("SELECT * FROM eval_runs", "started_at", _map_eval_run),
}

KINDS = tuple(_SOURCES)


async def list_records(*, kinds=None, status_class=None, since=None,
                       limit: int = 100, before=None) -> list[dict]:
    """Merged listing, newest first. Keyset pagination only:
    ``before = (started_at, source_table, source_id)`` from the last row of
    the previous page. ``status_class`` filters post-mapping (normalization
    is the adapter's, not SQL's)."""
    limit = max(1, min(int(limit), LIMIT_MAX))
    kinds = list(kinds or KINDS)
    for k in kinds:
        if k not in _SOURCES:
            raise ValueError(f"unknown execution kind {k!r}")
    if status_class is not None and status_class not in STATUS_CLASSES:
        raise ValueError(f"unknown status class {status_class!r}")
    out: list[dict] = []
    async with db.acquire() as conn:
        for kind in kinds:
            select, ts, mapper = _SOURCES[kind]
            where, args = [], []
            if since is not None:
                args.append(since)
                where.append(f"{ts} >= ${len(args)}")
            if before is not None:
                args.append(before[0])
                where.append(f"{ts} <= ${len(args)}")
            sql = select + (" WHERE " + " AND ".join(where) if where else "")
            args.append(limit + 1)
            sql += f" ORDER BY {ts} DESC LIMIT ${len(args)}"
            for row in await conn.fetch(sql, *args):
                out.append(mapper(row))
    if before is not None:
        b_key = (before[0], before[1], str(before[2]))
        out = [r for r in out
               if (r["started_at"], r["source_table"], r["source_id"]) < b_key]
    if status_class is not None:
        out = [r for r in out if r["status_class"] == status_class]
    out.sort(key=lambda r: (r["started_at"], r["source_table"],
                            r["source_id"]), reverse=True)
    return out[:limit]
