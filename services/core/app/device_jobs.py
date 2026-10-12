"""Jobs on her machines as rows (S30c T9): migration 048's device_jobs.

One writer. `insert` writes the row device_job_start makes BEFORE job.start
goes on the wire (state `starting`, the turn that started it, env NAMES only);
`apply_frame` stores the terminal record the agent sends in its `job` frame
(apps/novad/internal/client/jobscan.go jobFrame; the shape is pinned by the
agent's testdata/job_golden.json, which tests/test_device_jobs.py reads).

A frame lands only on the sending device's own row and only while that
device is still at the audit epoch its socket authenticated at — the same
rule every socket write holds to (devices_ws, the note above
_record_auth_facts). apply_frame says what happened, and devices_ws acks on
that word: "stored" and "unknown" are acked (an id core has no row for will
never have one — re-sending it forever helps nobody), "moved" and
"malformed" are not (nothing was stored, so nothing says it was).
"""

from __future__ import annotations

import json
import logging
import re
import secrets
import uuid
from collections.abc import Iterable, Mapping
from datetime import datetime

import asyncpg

logger = logging.getLogger("core")

TERMINAL_STATES = ("done", "failed_to_start", "stopped", "lost")
RAN_IN = ("host", "box")

_ID = re.compile(r"^[0-9a-f]{12}$")
_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

STORED = "stored"
UNKNOWN = "unknown"
MOVED = "moved"
MALFORMED = "malformed"


class _Malformed(ValueError):
    pass


def valid_id(job_id: object) -> bool:
    return isinstance(job_id, str) and _ID.fullmatch(job_id) is not None


def new_job_id() -> str:
    """12 lowercase hex — the agent's jobs.ValidID."""
    return secrets.token_hex(6)


def _env_names(env: Mapping[str, str] | Iterable[str] | None) -> list[str]:
    """The NAMES of `env` (a {name: value} mapping or names). Values are
    checked for type and dropped here — they never travel further — and
    no error text quotes one."""
    if env is None:
        return []
    if isinstance(env, Mapping):
        for name, value in env.items():
            if not isinstance(value, str):
                raise ValueError(f"env {name!r}: its value is not a string")
        names = list(env)
    elif isinstance(env, str | bytes):
        raise ValueError("env is a mapping of names to values, or a list of names")
    else:
        names = list(env)
    for i, name in enumerate(names):
        if not isinstance(name, str) or _ENV_NAME.fullmatch(name) is None:
            raise ValueError(f"env name #{i + 1} is not a name (^[A-Za-z_][A-Za-z0-9_]*$)")
    return sorted(names)


async def insert(
    pool,
    *,
    device_id: uuid.UUID | str,
    turn_id: uuid.UUID | str | None,
    argv: list[str],
    cwd: str | None,
    env: Mapping[str, str] | Iterable[str] | None,
    ran_in: str,
    box: str | None,
) -> str:
    """Write a `starting` row for a job about to be sent and return its new
    id. Raises ValueError (nothing written) for an argv that is not a
    non-empty list of strings, an env name that is not a name, or a ran_in
    other than host|box."""
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise ValueError("argv is a non-empty list of strings")
    if ran_in not in RAN_IN:
        raise ValueError(f"ran_in is one of {', '.join(RAN_IN)}")
    names = _env_names(env)
    job_id = new_job_id()
    await pool.execute(
        "INSERT INTO device_jobs (id, device_id, turn_id, argv, cwd, env_keys, ran_in, box) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        job_id,
        _as_uuid(device_id),
        _as_uuid(turn_id) if turn_id is not None else None,
        argv,
        cwd,
        names,
        ran_in,
        box,
    )
    return job_id


async def get(pool, job_id: object) -> dict | None:
    """The row for `job_id`, or None (an unknown or malformed id)."""
    if not valid_id(job_id):
        return None
    row = await pool.fetchrow("SELECT * FROM device_jobs WHERE id = $1", job_id)
    return dict(row) if row is not None else None


def _as_uuid(value: uuid.UUID | str) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


def _time(frame: dict, key: str) -> datetime | None:
    value = frame.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise _Malformed(f"{key} is not a time")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        raise _Malformed(f"{key} {value[:40]!r} is not an RFC 3339 time") from None
    if parsed.tzinfo is None:
        raise _Malformed(f"{key} {value[:40]!r} carries no zone")
    return parsed


def _int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _parse(frame: dict) -> dict:
    state = frame.get("state")
    if state not in TERMINAL_STATES:
        raise _Malformed(f"state {str(state)[:40]!r} is not a terminal state")
    exit_code = frame.get("exit_code")
    if exit_code is not None and not _int(exit_code):
        raise _Malformed("exit_code is not an integer or null")
    log_bytes = frame.get("log_bytes")
    if not _int(log_bytes) or log_bytes < 0:
        raise _Malformed("log_bytes is not a non-negative integer")
    reason = frame.get("reason")
    if reason is None:
        reason = ""
    if not isinstance(reason, str):
        raise _Malformed("reason is not text")
    return {
        "state": state,
        "exit_code": exit_code,
        "started_at": _time(frame, "started_at"),
        "ended_at": _time(frame, "ended_at"),
        "log_bytes": log_bytes,
        # postgres text refuses NUL; the rest of the reason is still worth keeping
        "reason": reason.replace("\x00", "�"),
    }


async def apply_frame(pool, device_id: uuid.UUID | str, frame: dict, *, epoch: int) -> str:
    """Store a terminal `job` frame on the sending device's own row, only
    while the device row is still at `epoch`. Returns "stored", "unknown"
    (no such job on this device), "moved" (the row moved past `epoch`) or
    "malformed" (logged; nothing stored)."""
    did = _as_uuid(device_id)
    job_id = frame.get("job_id")
    if not valid_id(job_id):
        logger.warning(
            "device %s: job frame not stored — job_id %s is not 12 lowercase hex",
            did,
            json.dumps(job_id)[:40],
        )
        return MALFORMED
    try:
        values = _parse(frame)
    except _Malformed as exc:
        logger.warning("device %s: job %s frame not stored — %s", did, job_id, exc)
        return MALFORMED
    try:
        async with pool.acquire() as conn, conn.transaction():
            at = await conn.fetchval("SELECT audit_epoch FROM devices WHERE id = $1 FOR SHARE", did)
            if at is None or at != epoch:
                logger.warning(
                    "device %s: job %s frame not stored — the device row is no longer at "
                    "this socket's epoch %s",
                    did,
                    job_id,
                    epoch,
                )
                return MOVED
            status = await conn.execute(
                "UPDATE device_jobs SET state = $3, exit_code = $4, started_at = $5, "
                "ended_at = $6, log_bytes = $7, reason = $8, updated_at = now() "
                "WHERE id = $1 AND device_id = $2",
                job_id,
                did,
                values["state"],
                values["exit_code"],
                values["started_at"],
                values["ended_at"],
                values["log_bytes"],
                values["reason"],
            )
    except (asyncpg.DataError, UnicodeEncodeError) as exc:
        logger.warning(
            "device %s: job %s frame not stored — postgres refused it: %s", did, job_id, exc
        )
        return MALFORMED
    if status == "UPDATE 0":
        logger.info(
            "device %s sent the end of job %s, which core has no row for on this device — "
            "nothing stored, acked so it is not re-sent",
            did,
            job_id,
        )
        return UNKNOWN
    return STORED


# The states an agent's job.start answers with for a job it launched
# (caps/job.go launchJob: the wrapper's first record).
STARTED_STATES = ("running", "waiting_lock")


def _text(reason: str) -> str:
    # postgres text refuses NUL; the rest of the reason is still worth keeping
    return reason.replace("\x00", "\ufffd")


async def mark_started(pool, job_id: str, state: str) -> bool:
    """The agent answered job.start with the job launched (`state` running or
    waiting_lock): move the row there — only while it is still `starting`, so
    a terminal frame stored first (a quick job's end raced the answer) is
    never overwritten. True when the row moved."""
    if state not in STARTED_STATES:
        raise ValueError(f"state is one of {', '.join(STARTED_STATES)}")
    status = await pool.execute(
        "UPDATE device_jobs SET state = $2, updated_at = now() "
        "WHERE id = $1 AND state = 'starting'",
        job_id,
        state,
    )
    return status != "UPDATE 0"


async def mark_failed(pool, job_id: str, reason: str) -> bool:
    """The agent answered job.start with ok:false — nothing was started: the
    row is `failed_to_start` with `reason`, only while it is still
    `starting`. True when the row moved."""
    status = await pool.execute(
        "UPDATE device_jobs SET state = 'failed_to_start', reason = $2, ended_at = now(), "
        "updated_at = now() WHERE id = $1 AND state = 'starting'",
        job_id,
        _text(reason),
    )
    return status != "UPDATE 0"


async def note_unconfirmed(pool, job_id: str, reason: str) -> bool:
    """No answer came back for job.start: whether the job started is not
    known, so the row stays `starting` (never read as started or failed) and
    carries `reason`. True when the row was still starting."""
    status = await pool.execute(
        "UPDATE device_jobs SET reason = $2, updated_at = now() "
        "WHERE id = $1 AND state = 'starting'",
        job_id,
        _text(reason),
    )
    return status != "UPDATE 0"


LIVE_STATES = ("running", "waiting_lock")


def parse_status(record: dict) -> dict | None:
    """The values of a record the agent answered job.status / job.stop with
    (caps/job.go statusMeta), checked like a terminal frame. None for a job
    with no record yet (state ""): there is nothing to store. Raises
    ValueError (naming what is wrong, never quoting a value at length) for a
    state that is not a job state, a non-integer exit_code, a time without a
    zone, or log_bytes that is not a non-negative integer."""
    state = record.get("state")
    if state == "":
        return None
    try:
        if state in TERMINAL_STATES:
            return _parse(record)
        if state not in LIVE_STATES:
            raise _Malformed(f"state {str(state)[:40]!r} is not a job state")
        log_bytes = record.get("log_bytes")
        if not _int(log_bytes) or log_bytes < 0:
            raise _Malformed("log_bytes is not a non-negative integer")
        return {"state": state, "started_at": _time(record, "started_at"), "log_bytes": log_bytes}
    except _Malformed as exc:
        raise ValueError(str(exc)) from None


async def apply_status(pool, device_id: uuid.UUID | str, record: dict) -> bool:
    """Store what the agent answered NOW for one of its jobs on that device's
    own row (a row of another device with the same id is never touched). A
    terminal record writes the end (state, exit_code, times, log_bytes,
    reason) as apply_frame does — the agent's record is the truth; a live
    one (running|waiting_lock) moves state, started_at and log_bytes only
    while the row has not ended, so a stored end is never reopened. Raises
    ValueError for a record parse_status refuses (nothing stored). True when
    a row moved."""
    values = parse_status(record)
    if values is None:
        return False
    job_id = record.get("job")
    if not valid_id(job_id):
        raise ValueError("job is not 12 lowercase hex")
    did = _as_uuid(device_id)
    if values["state"] in TERMINAL_STATES:
        status = await pool.execute(
            "UPDATE device_jobs SET state = $3, exit_code = $4, started_at = $5, "
            "ended_at = $6, log_bytes = $7, reason = $8, updated_at = now() "
            "WHERE id = $1 AND device_id = $2",
            job_id,
            did,
            values["state"],
            values["exit_code"],
            values["started_at"],
            values["ended_at"],
            values["log_bytes"],
            values["reason"],
        )
    else:
        status = await pool.execute(
            "UPDATE device_jobs SET state = $3, started_at = COALESCE($4, started_at), "
            "log_bytes = $5, updated_at = now() "
            "WHERE id = $1 AND device_id = $2 AND state <> ALL($6::text[])",
            job_id,
            did,
            values["state"],
            values["started_at"],
            values["log_bytes"],
            list(TERMINAL_STATES),
        )
    return status != "UPDATE 0"
