"""The wake ledger (S46a; migration 045): the one writer of wake_attempts.

Each row is one attempt to wake a machine, written as the evidence arrives
and never ahead of it:

  * **record_sent** — opened when the relay reports SENT, never before; it
    carries what was sent where (adapter, MAC, the relay's interface, the
    directed broadcast, the packet count). One open attempt per machine is
    the database's own answer (a unique partial index), so a second send
    while one is in flight is refused with when the open one went out.
  * **record_not_sent** — nothing left the relay: decided at once as
    relay_cannot or not_asleep, with the words saying why.
  * **mark_answered / mark_serving** — the machine's agent reconnected / its
    model answered. Counted only on an open row, only after the send and
    inside the deadline, and the first one wins.
  * **settle** — the outcome DERIVED from the columns: serving -> ready;
    deadline passed with an answer -> answered, with neither -> no_answer;
    inside the deadline with no serving -> no outcome yet. Nobody passes an
    outcome in, and migration 045's CHECKs refuse one the row does not show.

A decided row is never rewritten: the deadline is the measurement ("no answer
within D s"), so a reconnect after it is not this attempt's answer.

The MAC is on the private row (plain, as devices.facts already holds it) and
in no read here: what the reply and span code reads cannot leak it.
"""

from __future__ import annotations

import ipaddress
from datetime import UTC, datetime

import asyncpg

TRIGGERS = ("tool", "route", "test")
OUTCOMES = (
    "ready",
    "answered",
    "no_answer",
    "relay_cannot",
    "not_asleep",
    "stopped",
    "interrupted",
)
# Decided at once: nothing was sent, so nothing can answer.
NOT_SENT = ("relay_cannot", "not_asleep")
DEADLINE_MIN_S = 30
DEADLINE_MAX_S = 600
DEFAULT_DEADLINE_S = 120

# Every column but mac: the reads never carry it.
_COLUMNS = (
    "id, device_id, relay_device_id, adapter, relay_iface, broadcast, packets, "
    "trigger, created_at, sent_at, deadline_s, answered_at, serving_at, "
    "outcome, decided_at, reason, turn_id, test_id"
)


class AttemptOpen(Exception):
    """The machine already has a wake attempt in flight."""


def _check_trigger(trigger: str) -> None:
    if trigger not in TRIGGERS:
        raise ValueError(f"trigger must be one of {', '.join(TRIGGERS)}, not {trigger!r}")


def _check_deadline(deadline_s: int) -> None:
    if (
        isinstance(deadline_s, bool)
        or not isinstance(deadline_s, int)
        or not DEADLINE_MIN_S <= deadline_s <= DEADLINE_MAX_S
    ):
        raise ValueError(
            f"deadline_s must be a whole number of seconds from {DEADLINE_MIN_S} "
            f"to {DEADLINE_MAX_S}, not {deadline_s!r}"
        )


def _row(record: asyncpg.Record | None) -> dict | None:
    return dict(record) if record is not None else None


def _utc(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


async def record_sent(
    pool,
    *,
    device_id,
    relay_device_id,
    adapter: str,
    mac: str,
    relay_iface: str,
    broadcast: str,
    packets: int,
    trigger: str,
    sent_at: datetime,
    deadline_s: int = DEFAULT_DEADLINE_S,
    turn_id=None,
    test_id=None,
):
    """Open the row for a send the relay reported. Returns its id."""
    _check_trigger(trigger)
    _check_deadline(deadline_s)
    if isinstance(packets, bool) or not isinstance(packets, int) or packets < 1:
        raise ValueError(f"packets must be at least 1, not {packets!r}")
    try:
        return await pool.fetchval(
            "INSERT INTO wake_attempts (device_id, relay_device_id, adapter, mac, "
            "relay_iface, broadcast, packets, trigger, sent_at, deadline_s, turn_id, test_id) "
            "VALUES ($1, $2, $3, $4::macaddr, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id",
            device_id,
            relay_device_id,
            adapter,
            mac,
            relay_iface,
            ipaddress.ip_address(broadcast),
            packets,
            trigger,
            sent_at,
            deadline_s,
            turn_id,
            test_id,
        )
    except asyncpg.UniqueViolationError:
        opened = await open_for(pool, device_id)
        when = _utc(opened["sent_at"]) if opened else "a moment ago"
        raise AttemptOpen(f"a wake attempt for this machine is already open, sent at {when}")


async def record_not_sent(
    pool,
    *,
    device_id,
    outcome: str,
    reason: str,
    trigger: str,
    relay_device_id=None,
    adapter: str | None = None,
    mac: str | None = None,
    turn_id=None,
    test_id=None,
):
    """Record an attempt that sent nothing, decided at once. Returns its id."""
    if outcome not in NOT_SENT:
        raise ValueError(
            f"an attempt that sent nothing is {' or '.join(NOT_SENT)}, never {outcome!r}"
        )
    if not isinstance(reason, str) or not reason.strip():
        raise ValueError("an attempt that sent nothing needs the reason, in words")
    _check_trigger(trigger)
    return await pool.fetchval(
        "INSERT INTO wake_attempts (device_id, relay_device_id, adapter, mac, trigger, "
        "outcome, decided_at, reason, turn_id, test_id) "
        "VALUES ($1, $2, $3, $4::macaddr, $5, $6, now(), $7, $8, $9) RETURNING id",
        device_id,
        relay_device_id,
        adapter,
        mac,
        trigger,
        outcome,
        reason,
        turn_id,
        test_id,
    )


async def _mark(pool, column: str, attempt_id, at: datetime) -> bool:
    # column is one of two literals below, never caller text.
    updated = await pool.fetchval(
        f"UPDATE wake_attempts SET {column} = $2 "
        f"WHERE id = $1 AND outcome IS NULL AND {column} IS NULL "
        "AND sent_at IS NOT NULL AND $2 >= sent_at "
        "AND $2 <= sent_at + deadline_s * interval '1 second' RETURNING id",
        attempt_id,
        at,
    )
    return updated is not None


async def mark_answered(pool, attempt_id, at: datetime) -> bool:
    """The machine's agent reconnected at `at`. True only if it counted."""
    return await _mark(pool, "answered_at", attempt_id, at)


async def mark_serving(pool, attempt_id, at: datetime) -> bool:
    """The machine's model answered at `at`. True only if it counted."""
    return await _mark(pool, "serving_at", attempt_id, at)


async def settle(pool, attempt_id, *, now: datetime | None = None) -> str | None:
    """Decide the row from its own columns, if they decide it yet.

    Returns the outcome (the stored one when already decided), or None while
    the deadline runs with no model answering."""
    now = now or datetime.now(UTC)
    decided = await pool.fetchval(
        "UPDATE wake_attempts SET outcome = d.outcome, decided_at = $2 "
        "FROM (SELECT id, CASE "
        "  WHEN serving_at IS NOT NULL THEN 'ready' "
        "  WHEN $2 >= sent_at + deadline_s * interval '1 second' THEN "
        "    CASE WHEN answered_at IS NOT NULL THEN 'answered' ELSE 'no_answer' END "
        "  END AS outcome "
        "  FROM wake_attempts WHERE id = $1 AND outcome IS NULL AND sent_at IS NOT NULL "
        "  FOR UPDATE) d "
        "WHERE wake_attempts.id = d.id AND d.outcome IS NOT NULL "
        "RETURNING wake_attempts.outcome",
        attempt_id,
        now,
    )
    if decided is not None:
        return decided
    return await pool.fetchval("SELECT outcome FROM wake_attempts WHERE id = $1", attempt_id)


async def get(pool, attempt_id) -> dict | None:
    return _row(
        await pool.fetchrow(f"SELECT {_COLUMNS} FROM wake_attempts WHERE id = $1", attempt_id)
    )


async def open_for(pool, device_id) -> dict | None:
    """The machine's attempt in flight, if any."""
    return _row(
        await pool.fetchrow(
            f"SELECT {_COLUMNS} FROM wake_attempts WHERE device_id = $1 AND outcome IS NULL",
            device_id,
        )
    )


async def latest_for(pool, device_id) -> dict | None:
    """The machine's most recent attempt, open or decided."""
    return _row(
        await pool.fetchrow(
            f"SELECT {_COLUMNS} FROM wake_attempts WHERE device_id = $1 "
            "ORDER BY COALESCE(sent_at, created_at) DESC, created_at DESC LIMIT 1",
            device_id,
        )
    )


async def debounce_reason(pool, device_id, name: str, *, now: datetime) -> str | None:
    """Why a background wake (S46a T10) must not send to this machine now,
    derived from its rows; None when nothing stands in the way.

    An attempt still open (after settling one whose deadline has passed), one
    sent within its deadline whatever its outcome, or a relay that could not
    send within the default deadline — that last so a turn that routes while
    the hub's agent is offline does not write a row every round."""
    opened = await open_for(pool, device_id)
    if opened is not None and opened.get("sent_at") is not None:
        await settle(pool, opened["id"], now=now)
        opened = await open_for(pool, device_id)
    if opened is not None:
        return (
            f"a wake for {name} is already open, sent at {_utc(opened['sent_at'])}; "
            "nothing more was sent"
        )
    recent = await pool.fetchrow(
        "SELECT sent_at, deadline_s, outcome FROM wake_attempts WHERE device_id = $1 "
        "AND sent_at IS NOT NULL AND $2 < sent_at + deadline_s * interval '1 second' "
        "ORDER BY sent_at DESC LIMIT 1",
        device_id,
        now,
    )
    if recent is not None:
        return (
            f"a wake for {name} was sent at {_utc(recent['sent_at'])} and is within its "
            f"{recent['deadline_s']} s deadline ({recent['outcome']}); nothing more was sent"
        )
    refused = await pool.fetchrow(
        "SELECT created_at, reason FROM wake_attempts WHERE device_id = $1 "
        "AND outcome = 'relay_cannot' AND $2 < created_at + $3 * interval '1 second' "
        "ORDER BY created_at DESC LIMIT 1",
        device_id,
        now,
        DEFAULT_DEADLINE_S,
    )
    if refused is not None:
        return (
            f"the relay could not send {name}'s last wake at {_utc(refused['created_at'])} "
            f"({refused['reason']}); not tried again within {DEFAULT_DEADLINE_S} s"
        )
    return None


async def latest_by_device(pool, *, now: datetime | None = None) -> dict:
    """Each machine's most recent attempt, keyed by device id, in the shape
    machine_status states it (S46a T6): outcome, when, the deadline, and how
    long after the send its agent / its model answered — never the MAC. An
    open attempt whose deadline has passed is settled first (by settle, the
    ledger's one rule), so a status read never shows a decided attempt as in
    flight."""
    now = now or datetime.now(UTC)
    stale = await pool.fetch(
        "SELECT id FROM wake_attempts WHERE outcome IS NULL AND sent_at IS NOT NULL "
        "AND $1 >= sent_at + deadline_s * interval '1 second'",
        now,
    )
    for row in stale:
        await settle(pool, row["id"], now=now)
    rows = await pool.fetch(
        f"SELECT DISTINCT ON (device_id) {_COLUMNS} FROM wake_attempts "
        "ORDER BY device_id, COALESCE(sent_at, created_at) DESC, created_at DESC"
    )
    return {row["device_id"]: summary(dict(row)) for row in rows}


def _after(at: datetime | None, sent_at: datetime | None) -> int | None:
    if at is None or sent_at is None:
        return None
    return int((at - sent_at).total_seconds())


def summary(row: dict) -> dict:
    """One attempt as machine_status states it: no MAC, no address."""
    sent_at = row.get("sent_at")
    return {
        "outcome": row.get("outcome"),
        "trigger": row.get("trigger"),
        "at": row["created_at"].isoformat() if row.get("created_at") else None,
        "sent_at": sent_at.isoformat() if sent_at else None,
        "deadline_s": row.get("deadline_s") if sent_at else None,
        "answered_after_s": _after(row.get("answered_at"), sent_at),
        "serving_after_s": _after(row.get("serving_at"), sent_at),
        "reason": row.get("reason"),
    }
