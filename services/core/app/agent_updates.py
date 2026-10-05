"""Keeping Nova's agents on the hub's build (S42b decision 2).

The desired state is the hub's build (agent_dist). An agent is behind when the
version it reports is not that build's — a hash has no order, so behind never
means "older" — and that is derived on every read (device_facts.build_state).

What is stored is each ATTEMPT (agent_updates): who asked, what was sent, what
came back. An attempt stays `sent` until the device's next authenticated
connection decides it (observe_connect): `confirmed` when it reports the
version it was sent, `rolled_back` when its supervisor put the old build back
and says so. Ten minutes with neither is `not_confirmed`; an agent that
answered no is `refused`. No sentence confirms an update — only a reconnect
(P8). One `sent` row at a time, for everyone: the database's own index (P9).

An attempt belongs to the agent it was sent to: the key, and so the audit
epoch, the device row held when it was opened. It is opened only while the row
is still at that epoch, sent only over that epoch's socket, decided only by a
connection at that epoch, and a re-pair or a revoke ends it in the very
transaction that moves the row on (end_open_attempt) — so the new key's first
connection can never decide an update that was sent to the old one, and a
revoked machine never holds P9's one slot.

Two ways to send (P11): the daemon.update capability (S42b agents), or — for
an S42a Linux agent under the README's systemd unit, which answers `unknown
capability "daemon.update"` — its own shell.exec, every argv composed HERE and
the build run only after core compared its sha256. Anything else is a stated
cannot naming the one step the owner takes (P12). Whether Nova can update an
agent, and how, is decided in one place (eligibility), which the send, the job
and the devices_agents_behind check all read (F14).

The timer job `agent_updates` (timers.JOBS) runs reconcile() every 15
minutes: one idle machine at a time, the hub's own agent first, never a
version that FAILED anywhere — rolled back or never confirmed, the build may
not run — and never to a machine already tried with it (P10, as the
controller ruled it: a refusal is the machine's, and halts nothing else).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

import asyncpg

from app import agent_card, agent_dist, device_facts, devices, devices_ws, network

logger = logging.getLogger("core")

CONFIRM_WITHIN_S = 600
IDLE_S = 300
WAIT_S = 120
COMMAND_TIMEOUT_S = 120
# While update_now waits for the reconnect (Task 22 fix round 1): how often
# the "waiting" line is said again. Each saying is where a Stop can land — the
# progress callback chat binds raises TurnStopped (chat._report_progress) — so
# the wait is never a stretch nobody can interrupt.
PROGRESS_EVERY_S = 5.0
UNKNOWN_CAPABILITY = 'unknown capability "daemon.update"'
# P10, as ruled: the outcomes that mean the BUILD may not run. Only these halt
# the job for every machine. `refused` means the MACHINE could not take it (an
# agent that predates daemon.update and cannot be bootstrapped, a missing
# curl, any stated cannot): the job skips that machine and goes on.
BUILD_FAILED = ("rolled_back", "not_confirmed")
# A stored reason is shown on ONE line (machine_status's agent line, the
# tile): never longer than this, never a line break (_one_line).
REASON_MAX = 300
REPAIRED_REASON = (
    "the machine was re-paired before the agent this was sent to reconnected on the new "
    "build — that agent's key can no longer connect, so nothing can confirm it"
)
REVOKED_REASON = (
    "the machine was revoked before the agent this was sent to reconnected on the new "
    "build — a revoked agent cannot connect, so nothing can confirm it"
)
# The reasons end_open_attempt records, and the only ones it may. An attempt
# ended for one of them was ended by the AGENT's fate (a new key, a revoke),
# not by the build: it never halts the build (fix round 1, I1), never counts
# as a machine already tried with it, and is never called a failed build.
# Keyed on these constants — the words core itself wrote — never on phrasing.
ENDED_REASONS = (REPAIRED_REASON, REVOKED_REASON)
# A confirmation expire_stale made from the stored facts, after the reconnect
# itself left the attempt open (fix round 1, M6) — said, so it is not read as
# a reconnect that decided it at the time.
CONFIRMED_LATE = "confirmed when it expired: its agent's last connection had reported this build"
# Monotonic seconds for the bootstrap's one deadline (fix round 1, I3) — a
# name tests can stand a fake clock in for.
_clock = time.monotonic

# Opened only while the row is still at the epoch the caller read it at. FOR
# SHARE serializes this with a re-pair's rebind (devices._REBIND_SQL locks the
# row FOR UPDATE): a rebind that committed first leaves nothing to open, and
# one that commits after finds this attempt and ends it (end_open_attempt).
_OPEN_SQL = """
INSERT INTO agent_updates (device_id, from_version, version, sha256, path, requested_by)
SELECT d.id, $2, $3, $4, 'capability', $5
  FROM devices d
 WHERE d.id = $1 AND d.audit_epoch = $6 AND d.revoked_at IS NULL
   FOR SHARE
RETURNING id
"""
# Decided only while the row is still at the epoch the deciding socket (or
# the command whose answer this is) belongs to, and only once.
_CLOSE_SQL = """
UPDATE agent_updates u SET outcome = $2, outcome_at = now(), reason = $3
 WHERE u.id = $1 AND u.outcome = 'sent'
   AND EXISTS (SELECT 1 FROM devices d WHERE d.id = u.device_id AND d.audit_epoch = $4)
"""
_IN_FLIGHT_SQL = (
    "SELECT d.name, u.version, u.sent_at FROM agent_updates u JOIN devices d ON d.id = u.device_id "
    "WHERE u.outcome = 'sent'"
)
# A build failure that halts the job: BUILD_FAILED, never an attempt the
# agent's own fate ended ($3, ENDED_REASONS).
_FAILED_SQL = (
    "SELECT d.name, u.outcome, u.reason FROM agent_updates u JOIN devices d ON d.id = u.device_id "
    "WHERE u.version = $1 AND u.outcome = ANY($2::text[]) "
    "AND NOT (COALESCE(u.reason, '') = ANY($3::text[])) ORDER BY u.sent_at DESC LIMIT 1"
)
# Every machine already tried with a build, and how its last try was decided —
# an attempt its old agent's fate ended ($2) tried no agent the row has now.
_TRIED_SQL = (
    "SELECT DISTINCT ON (device_id) device_id, outcome FROM agent_updates "
    "WHERE version = $1 AND outcome <> 'sent' AND NOT (COALESCE(reason, '') = ANY($2::text[])) "
    "ORDER BY device_id, sent_at DESC"
)
_HOME = re.compile(r"(?:^|;\s*)home=([^;]+)")
# What ends or breaks a line wherever a reason is shown: the C0 and C1
# controls (NUL among them — postgres cannot store it), DEL, and the line and
# paragraph separators str.splitlines() also splits on.
_BREAKS = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]+")


@dataclass(frozen=True)
class UpdateOutcome:
    machine: str
    outcome: str
    version: str | None
    from_version: str | None
    reason: str | None = None
    attempt_id: uuid.UUID | None = None
    at: datetime | None = None
    needs_card: bool = False
    in_flight: int = 0


@dataclass(frozen=True)
class Eligibility:
    """Whether Nova can send an agent the hub's build, and how — decided
    here once (F14); update_now, the reconciler and the devices_agents_behind
    check all read it. Derived from what the agent last reported.

    `token`: "service" (Nova can), or "no_facts" / "by_hand" / "no_build"
    — a stated cannot, and the check's `why`. `said` and `step`: for a
    cannot, what is true of the agent (a clause after "<name>'s agent") and
    the one step the owner takes (P12) — none for "no_build": the hub's
    build covers six platforms, and no step adds a seventh. Whether the hub
    has a build for the agent's platform is decided here too (fix round 1,
    M1), so the job passes such a machine by instead of choosing it on
    every pass. `bootstrap` (P11): if the agent answers `unknown
    capability "daemon.update"`, its own shell.exec can still update it —
    only under a Linux systemd user unit, the one manager `install
    --restart-later` restarts from outside the old agent's process tree.
    Under a Run key or a LaunchAgent it fails after the new build is placed
    and registered (Task 12), so the bootstrap is never sent there."""

    token: str
    said: str | None = None
    step: str | None = None
    bootstrap: bool = False

    @property
    def can(self) -> bool:
        return self.token == "service"

    @property
    def needs_card(self) -> bool:
        """The owner's one step is the machine's setup card (P12)."""
        return self.token in ("no_facts", "by_hand")

    def cannot(self, name: str) -> str:
        said = f"{name}'s agent {self.said}"
        return f"{said} — {self.step}" if self.step else said


def eligibility(row, build: agent_dist.Build) -> Eligibility:
    name, facts = row["name"], row["facts"]
    agent = facts.get("agent") if isinstance(facts, dict) else None
    mode = agent.get("mode") if isinstance(agent, dict) else None
    if mode is None:
        # No facts at all, or none from the auth frame (a facts frame merges
        # into an empty row): nothing says how it runs — never "by hand".
        return Eligibility(
            "no_facts",
            said="has not reported how it runs, so Nova cannot restart it",
            step=f"run the command on {name}'s setup card there",
        )
    if mode not in device_facts.SERVICE_MODES:
        return Eligibility(
            "by_hand",
            said="was started by hand, not by its service, so Nova cannot restart it",
            step=f"close the window it runs in, then run the command on {name}'s setup card there",
        )
    os_ = facts.get("os") or {}
    goos, arch = os_.get("goos"), os_.get("arch")
    if build.file_for(goos, arch) is None:
        return Eligibility(
            "no_build", said=f"runs on {goos}/{arch}, which the hub has no build for"
        )
    return Eligibility("service", bootstrap=goos == "linux" and mode == "systemd-user")


class _BootstrapRefused(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _cannot(
    name: str, reason: str, *, version=None, from_version=None, needs_card=False
) -> UpdateOutcome:
    return UpdateOutcome(
        machine=name,
        outcome="cannot",
        version=version,
        from_version=from_version,
        reason=_one_line(reason),
        needs_card=needs_card,
    )


def _one_line(text: str) -> str:
    """A reason as it is stored and shown: one line — every control
    character and line separator becomes a space — valid UTF-8 (an unpaired
    surrogate an agent's JSON can carry becomes "?"), and at most REASON_MAX
    characters. Never refuses: it is a reason, not an input."""
    clean = _BREAKS.sub(" ", text.encode("utf-8", "replace").decode("utf-8"))
    clean = " ".join(clean.split())
    return clean if len(clean) <= REASON_MAX else clean[: REASON_MAX - 1] + "…"


def _connected(row, facts_sink: list[dict] | None) -> bool:
    """Whether the machine's agent holds a live socket now — the ONE place
    this module reads it (test_state_guard names this function). Recorded
    onto facts_sink, when a tool threads one through update_now, in the
    {device, connected} shape tools/devices._require_connected writes."""
    connected = devices_ws.hub.is_connected(row["id"])
    if facts_sink is not None:
        facts_sink.append({"device": row["name"], "connected": connected})
    return connected


async def expire_stale(pool) -> int:
    """Decide every attempt still `sent` after CONFIRM_WITHIN_S. What the
    agent's last connection STORED is read first (fix round 1, M6): a
    decision a swallowed observe_connect error missed is made here —
    confirmed late, or rolled back — and only an attempt nothing confirms is
    not_confirmed. A missed confirmation never becomes a failed build that
    halts it for every machine. The row's facts are the attempt's agent's:
    an attempt is opened at the row's epoch, and the re-pair or revoke that
    would move the row on ends it (end_open_attempt)."""
    stale = await pool.fetch(
        "SELECT u.id, u.version, u.sent_at, d.facts FROM agent_updates u "
        "JOIN devices d ON d.id = u.device_id "
        "WHERE u.outcome = 'sent' AND u.sent_at < now() - make_interval(secs => $1)",
        CONFIRM_WITHIN_S,
    )
    decided = 0
    for attempt in stale:
        found = _decision(attempt["facts"], attempt["version"], attempt["sent_at"])
        if found is None:
            outcome = "not_confirmed"
            reason = f"no reconnect reporting the new build within {CONFIRM_WITHIN_S // 60} minutes"
        else:
            outcome, reason = found
            reason = reason if outcome == "rolled_back" else CONFIRMED_LATE
        status = await pool.execute(
            "UPDATE agent_updates SET outcome = $2, outcome_at = now(), reason = $3 "
            "WHERE id = $1 AND outcome = 'sent'",
            attempt["id"],
            outcome,
            _one_line(reason),
        )
        decided += status == "UPDATE 1"
    return decided


async def _close(pool, attempt_id, outcome: str, reason: str | None, *, epoch: int) -> bool:
    """Decide an open attempt — once, and only while its device is still at
    `epoch`. The reason is stored one line (_one_line): an agent's words go
    into a line Task 22 renders, and a newline there would end it."""
    status = await pool.execute(
        _CLOSE_SQL, attempt_id, outcome, None if reason is None else _one_line(reason), epoch
    )
    return status == "UPDATE 1"


async def _withdraw(pool, attempt_id) -> None:
    """An attempt whose command never reached the device: nothing was sent,
    so there is nothing to record — a cannot, like every other. Deleted by
    its id whatever its outcome (fix round 1, I2): a re-pair or revoke that
    committed between the open and the send has already ended it, and
    "…before the agent this was sent to reconnected" would be a record of a
    send that never left core. It is this call's own row."""
    await pool.execute("DELETE FROM agent_updates WHERE id = $1", attempt_id)


async def end_open_attempt(conn, device_id, *, reason: str) -> int:
    """The agent an update still `sent` went to can never connect again —
    a re-pair gave the machine a new key (devices.enroll, REPAIRED_REASON),
    or a revoke ended it (devices.revoke, REVOKED_REASON). No reconnect can
    confirm the attempt, the new key's first connection must never be read
    as that agent's, and a revoked machine must not hold P9's one slot for
    ten minutes. Decided here, as what is true, inside the transaction that
    makes it so."""
    if reason not in ENDED_REASONS:
        # The halt and the job's skip key on these exact words: any other
        # reason recorded here would read as a failed build.
        raise ValueError(f"end_open_attempt records only ENDED_REASONS, not {reason!r}")
    rows = await conn.fetch(
        "UPDATE agent_updates SET outcome = 'not_confirmed', outcome_at = now(), reason = $2 "
        "WHERE device_id = $1 AND outcome = 'sent' RETURNING id",
        device_id,
        reason,
    )
    return len(rows)


def failed_build(outcome: str | None, reason: str | None) -> bool:
    """Whether an attempt's outcome says the BUILD may not run — not an
    attempt the agent's own fate ended (ENDED_REASONS). One reading, for the
    check; the job's halt reads the same constants in _FAILED_SQL."""
    return outcome in BUILD_FAILED and reason not in ENDED_REASONS


def _recorded_after(at: object, sent_at: datetime) -> bool:
    """Whether a supervisor record dated `at` (RFC 3339, to the second) was
    written at or after `sent_at`."""
    if not isinstance(at, str) or not at:
        return False
    try:
        when = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except ValueError:
        return False
    return when.tzinfo is not None and when >= sent_at.replace(microsecond=0)


def _decision(facts: dict | None, version: str, sent_at: datetime) -> tuple[str, str | None] | None:
    """What an agent's stored facts say about an attempt at `version` sent at
    `sent_at`, read one way for observe_connect and expire_stale: confirmed
    when it reports that version; rolled back when its supervisor's record
    names that version and was written at or after the send (an agent keeps
    reporting its LAST record — see observe_connect); else nothing."""
    if facts is None:
        return None
    if device_facts.agent_version(facts) == version:
        return "confirmed", None
    agent = facts.get("agent") if isinstance(facts, dict) else None
    update = (agent.get("update") if isinstance(agent, dict) else None) or {}
    if (
        update.get("version") == version
        and update.get("outcome") == "rolled_back"
        and _recorded_after(update.get("at"), sent_at)
    ):
        return "rolled_back", update.get("reason") or "its supervisor put the previous build back"
    return None


async def observe_connect(pool, device_id, facts: dict | None, *, epoch: int) -> str | None:
    """Decide the device's open attempt from what it said at its reconnect
    (P8); return the outcome recorded, or None.

    `facts` is what this connection STORED (devices_ws._record_auth_facts —
    None decides nothing), and `epoch` the socket's own: the decision lands
    only while the row is still there, so a socket a re-pair has moved past
    decides nothing. Confirmed: it reports the version it was sent. Rolled
    back: its supervisor's record names that version and was written after
    the attempt was sent. An agent keeps reporting its LAST record, so a
    rollback from an earlier attempt at the same build (P10's "update it
    now" retry) must not decide this one; a record dated before the send,
    or undated, is left for expire_stale, which says only what is true."""
    if facts is None:
        return None
    open_ = await pool.fetchrow(
        "SELECT id, version, sent_at FROM agent_updates WHERE device_id = $1 AND outcome = 'sent'",
        device_id,
    )
    if open_ is None:
        return None
    found = _decision(facts, open_["version"], open_["sent_at"])
    if found is None:
        return None
    outcome, reason = found
    return outcome if await _close(pool, open_["id"], outcome, reason, epoch=epoch) else None


async def update_now(
    pool,
    *,
    name: str,
    requested_by: str,
    wait_s: float = WAIT_S,
    facts_sink: list[dict] | None = None,
    progress: Callable[[str], None] | None = None,
) -> UpdateOutcome:
    """Send the hub's build to `name` now and wait up to wait_s for its
    reconnect to decide the attempt. A command already running there ends
    "cancelled" when the agent restarts (P25); in_flight says how many (F15:
    a count — the hub keeps futures, not capability names).

    `facts_sink`, when a tool threads one through, receives the
    {device, connected} fact this call determined. `progress`, when a tool
    threads one through (Task 22 fix round 1), hears the wait said once the
    send is answered and again every PROGRESS_EVERY_S (_await); whatever it
    raises — a Stop — ends the call with the attempt still `sent`, for the
    reconnect or expire_stale to decide."""
    await expire_stale(pool)
    row = await devices.get_live_by_name(pool, name)
    if row is None:
        return _cannot(name, f"cannot: no paired machine named {name!r}")
    try:
        build = await agent_dist.read()
    except agent_dist.DistUnavailable as exc:
        return _cannot(name, f"cannot: the hub has no agent build to send — {exc}")
    facts = row["facts"]
    current = device_facts.agent_version(facts)
    if current == build.version:
        return UpdateOutcome(
            machine=name, outcome="current", version=build.version, from_version=current
        )
    kw = {"version": build.version, "from_version": current}
    if not _connected(row, facts_sink):
        seen = row["last_seen"].isoformat() if row["last_seen"] else "never"
        return _cannot(name, f"cannot: {name} is not connected (last seen {seen})", **kw)
    able = eligibility(row, build)
    if not able.can:
        return _cannot(name, f"cannot: {able.cannot(name)}", needs_card=able.needs_card, **kw)
    os_ = facts.get("os") or {}
    entry = build.file_for(os_.get("goos"), os_.get("arch"))  # eligibility found it
    epoch = row["audit_epoch"]
    in_flight = devices_ws.hub.in_flight(row["id"])
    try:
        attempt_id = await pool.fetchval(
            _OPEN_SQL, row["id"], current, build.version, entry["sha256"], requested_by, epoch
        )
    except asyncpg.UniqueViolationError:
        busy = await pool.fetchrow(_IN_FLIGHT_SQL)
        if busy is None:
            return _cannot(
                name, "cannot now: another update was in flight a moment ago — ask again", **kw
            )
        return _cannot(
            name,
            f"cannot now: an update to {busy['name']} is still in flight (sent "
            f"{busy['sent_at'].isoformat()}) — one machine at a time",
            **kw,
        )
    if attempt_id is None:
        return _cannot(
            name,
            f"cannot: {name} was re-paired or revoked while the update was being prepared — "
            "nothing was sent",
            **kw,
        )
    try:
        result = await devices_ws.hub.command(
            pool,
            device_id=row["id"],
            name=name,
            capability="daemon.update",
            args={
                "version": build.version,
                "sha256": entry["sha256"],
                "path": f"/api/v1/agent/dist/{entry['name']}",
            },
            timeout=COMMAND_TIMEOUT_S,
            facts_sink=facts_sink,
            epoch=epoch,
        )
    except devices_ws.NotSent as exc:
        await _withdraw(pool, attempt_id)
        return _cannot(name, f"cannot: {exc.reason} — nothing was sent", **kw)
    except devices.DeviceRefused as exc:
        # Sent, and no answer: it may have staged and left before its reply
        # got out. Only its reconnect can say, so the attempt stays open.
        logger.info("update of %s: no answer (%s); waiting for its reconnect", name, exc.reason)
        return await _await(pool, attempt_id, name, kw, wait_s, in_flight, progress)
    if result.get("ok"):
        return await _await(pool, attempt_id, name, kw, wait_s, in_flight, progress)
    error = _one_line(str(result.get("error") or "") or "it answered no and gave no reason")
    if UNKNOWN_CAPABILITY not in error:
        await _close(pool, attempt_id, "refused", error, epoch=epoch)
        return await _await(pool, attempt_id, name, kw, 0, 0)
    if not able.bootstrap:
        reason = (
            f"cannot: {name}'s agent predates Nova-managed updates, and Nova updates such an "
            f"agent through its own hands only under a Linux systemd user unit (this one runs "
            f"as {(facts.get('agent') or {}).get('mode')} on {os_.get('goos')}) — run the "
            f"command on {name}'s setup card there"
        )
        await _close(pool, attempt_id, "refused", reason, epoch=epoch)
        return UpdateOutcome(
            machine=name,
            outcome="cannot",
            reason=_one_line(reason),
            attempt_id=attempt_id,
            needs_card=True,
            **kw,
        )
    await pool.execute(
        "UPDATE agent_updates SET path = 'bootstrap' WHERE id = $1 AND outcome = 'sent'",
        attempt_id,
    )
    try:
        await _bootstrap(pool, row, build, entry, epoch=epoch)
    except _BootstrapRefused as exc:
        await _close(pool, attempt_id, "refused", exc.reason, epoch=epoch)
        return await _await(pool, attempt_id, name, kw, 0, 0)
    return await _await(pool, attempt_id, name, kw, wait_s, in_flight, progress)


def _span(seconds: float) -> str:
    """A wait in words: "2 min", "90 s"."""
    if seconds >= 60 and seconds % 60 == 0:
        return f"{seconds / 60:g} min"
    return f"{seconds:g} s"


async def _await(
    pool,
    attempt_id,
    name: str,
    kw: dict,
    wait_s: float,
    in_flight: int,
    progress: Callable[[str], None] | None = None,
) -> UpdateOutcome:
    """The attempt as it is recorded, once it is decided or wait_s has
    passed — what the caller is told is what the ledger holds.

    While it waits, the wait is said (Task 22 fix round 1): at once — the
    send was answered, or went out unanswered — and again every
    PROGRESS_EVERY_S, each saying a point a Stop can land. Nothing is said
    for an attempt already decided or a call that does not wait (wait_s 0:
    the tile, the job), and nothing a Stop raises touches the ledger."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_s
    said_at: float | None = None
    while True:
        row = await pool.fetchrow(
            "SELECT outcome, outcome_at, reason FROM agent_updates WHERE id = $1", attempt_id
        )
        if row is None:
            raise RuntimeError(f"the update attempt {attempt_id} is gone from agent_updates")
        if row["outcome"] != "sent" or loop.time() >= deadline:
            return UpdateOutcome(
                machine=name,
                outcome=row["outcome"],
                reason=row["reason"],
                attempt_id=attempt_id,
                at=row["outcome_at"],
                in_flight=in_flight,
                **kw,
            )
        if progress is not None and (said_at is None or loop.time() - said_at >= PROGRESS_EVERY_S):
            said_at = loop.time()
            progress(
                f"sent the hub's build {kw['version']} to {name}; waiting up to "
                f"{_span(wait_s)} for its agent to reconnect on it"
            )
        await asyncio.sleep(min(0.5, max(0.0, deadline - loop.time())))


def _total() -> str:
    """The bootstrap's whole bound, in words: "120 s"."""
    return f"{COMMAND_TIMEOUT_S:g} s"


async def _step(
    pool,
    row,
    capability: str,
    args: dict,
    step: str,
    *,
    epoch: int,
    deadline: float,
    sent_is_enough: bool = False,
) -> dict | None:
    """One command of the bootstrap, to the agent at `epoch` and no other: a
    later step runs a file an earlier one checked ON THAT AGENT. Bounded by
    what remains of the bootstrap's ONE deadline (fix round 1, I3) — never
    sent once it has passed — so the whole bootstrap waits on an agent no
    longer than one command would. None when `sent_is_enough` and it went
    unanswered — the install step, whose own restart can cut its reply off:
    only the reconnect can say."""
    remaining = deadline - _clock()
    if remaining <= 0:
        raise _BootstrapRefused(
            f"the update's {_total()} ran out before its {step} step was sent — nothing past it "
            "was run"
        )
    try:
        return await devices_ws.hub.command(
            pool,
            device_id=row["id"],
            name=row["name"],
            capability=capability,
            args=args,
            timeout=remaining,
            epoch=epoch,
        )
    except devices_ws.NotSent as exc:
        raise _BootstrapRefused(
            f"the {step} step was not sent ({exc.reason}) — nothing past it was run"
        ) from exc
    except devices.DeviceRefused as exc:
        if sent_is_enough:
            logger.info("update of %s: the %s step went unanswered (%s)", row["name"], step, exc)
            return None
        if isinstance(exc.__cause__, TimeoutError):
            raise _BootstrapRefused(
                f"the {step} step did not finish on {row['name']} within the update's "
                f"{_total()} — nothing past it was run"
            ) from exc
        raise _BootstrapRefused(
            f"{row['name']} did not answer the {step} step ({exc.reason}) — nothing past it was run"
        ) from exc


async def _exec(
    pool,
    row,
    argv: list[str],
    step: str,
    *,
    epoch: int,
    deadline: float,
    sent_is_enough: bool = False,
) -> str:
    result = await _step(
        pool,
        row,
        "shell.exec",
        {"argv": argv},
        step,
        epoch=epoch,
        deadline=deadline,
        sent_is_enough=sent_is_enough,
    )
    if result is None:
        return ""
    if not result.get("ok") or result.get("exit_code") != 0:
        said = str(result.get("error") or result.get("output") or "").strip()[-200:]
        raise _BootstrapRefused(
            f"the {step} step failed on {row['name']} (exit {result.get('exit_code')}): "
            f"{said or 'it said nothing'}"
        )
    return str(result.get("output") or "")


def _origin_for(row) -> str:
    if row["last_transport"] == "host":
        return agent_card.LOOPBACK
    got = network.address()
    if got.origin is None:
        raise _BootstrapRefused(
            f"Nova has no address {row['name']} can download its build from — {got.reason}; "
            "nothing was run"
        )
    return got.origin


async def _bootstrap(pool, row, build, entry: dict, *, epoch: int) -> None:
    """P11: an S42a Linux agent under the README's systemd unit, updated
    through its own shell.exec — every argv composed here, never by the
    model, and the new build run only after core compared its sha256. The
    new binary's `install --restart-later` restarts the unit from outside
    the old agent's own process tree (systemd-run), so this command's reply
    gets out; it trusts the pairing it runs under and dials no hub (F2)."""
    name = row["name"]
    origin = _origin_for(row)
    deadline = _clock() + COMMAND_TIMEOUT_S
    info = await _step(pool, row, "system.info", {}, "system.info", epoch=epoch, deadline=deadline)
    if not info.get("ok"):
        # The agent's own words (fix round 1, M7), never a guess about home.
        said = str(info.get("error") or info.get("output") or "").strip()[-200:]
        raise _BootstrapRefused(
            f"the system.info step failed on {name}: {said or 'it said nothing'} — nothing was run"
        )
    match = _HOME.search(str(info.get("output") or ""))
    home = match.group(1).strip() if match else ""
    if not home.startswith("/"):
        raise _BootstrapRefused(
            f"{name} did not name an absolute home folder, so there is nowhere to put the "
            "download — nothing was run"
        )
    target = f"{home}/.cache/nova-update/{build.version}/novad"
    url = f"{origin}/api/v1/agent/dist/{entry['name']}"
    await _exec(
        pool,
        row,
        ["curl", "-fsSL", "--create-dirs", "-o", target, url],
        "download",
        epoch=epoch,
        deadline=deadline,
    )
    out = await _exec(pool, row, ["sha256sum", target], "checksum", epoch=epoch, deadline=deadline)
    got = (out.split() or [""])[0]
    if got != entry["sha256"]:
        shown = f"{got[:12]}…" if got else "not printed"
        raise _BootstrapRefused(
            f"the download's sha256 on {name} is {shown}, not the hub's "
            f"{entry['sha256'][:12]}… — nothing was run"
        )
    await _exec(pool, row, ["chmod", "0755", target], "chmod", epoch=epoch, deadline=deadline)
    await _exec(
        pool,
        row,
        [target, "install", "--restart-later"],
        "install",
        epoch=epoch,
        deadline=deadline,
        sent_is_enough=True,
    )


# The words the job says for a machine it passes by.
_PASSED_BY = {
    "no_facts": "it has not reported how it runs",
    "by_hand": "started by hand",
    "no_build": "the hub has no build for its platform",
}


def _why_not(row, build: agent_dist.Build) -> str | None:
    """Why the job passes this machine by (P10), or None when it may send."""
    if not _connected(row, None):
        return "offline"
    able = eligibility(row, build)
    if not able.can:
        return _PASSED_BY[able.token]
    if not devices_ws.hub.idle(row["id"], IDLE_S):
        return "busy: a command is in flight there, or one was sent in the last 5 minutes"
    return None


def _sent_words(out: UpdateOutcome, version: str, name: str, *, hub: bool) -> str:
    """What one pass did, as true as the outcome is (fix round 1, M2). Only
    the update command went out when a machine cannot take the build, so it
    is never "sent … ; cannot — cannot: …"."""
    first = " — the hub's own agent first" if hub else ""
    said = (out.reason or "no reason was given").removeprefix("cannot: ")
    if out.outcome == "sent":
        return (
            f"sent the hub's build {version} to {name}{first}; not confirmed until it "
            "reconnects on it"
        )
    if out.attempt_id is None:
        return f"did not send the hub's build {version} to {name}{first}: {said}"
    if out.outcome in ("cannot", "refused"):
        who = f"{name}, the hub's own agent," if hub else name
        return f"{who} cannot take the hub's build {version}: {said}"
    tail = out.outcome + (f" — {out.reason}" if out.reason else "")
    return f"sent the hub's build {version} to {name}{first}; {tail}"


async def reconcile(pool) -> str:
    """The job's one pass (P10): at most ONE update sent, and the words the
    firing records. A build that FAILED anywhere (BUILD_FAILED) halts it; a
    machine already tried with this build — refused, or anything else — is
    passed by, and the others still get it. machine_update can still send
    to any of them."""
    await expire_stale(pool)
    busy = await pool.fetchrow(_IN_FLIGHT_SQL)
    if busy:
        return (
            f"waiting on {busy['name']}: {busy['version']} sent at "
            f"{busy['sent_at'].isoformat()}, not confirmed yet"
        )
    try:
        build = await agent_dist.read()
    except agent_dist.DistUnavailable as exc:
        return f"nothing sent: the hub has no agent build to send — {exc}"
    failed = await pool.fetchrow(
        _FAILED_SQL, build.version, list(BUILD_FAILED), list(ENDED_REASONS)
    )
    if failed:
        return (
            f"halted: the hub's build {build.version} {failed['outcome']} on {failed['name']} "
            f"({failed['reason']}) — it is not sent to another machine on its own; "
            "machine_update can still send it"
        )
    rows = await pool.fetch("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY name")
    if not rows:
        return "nothing sent: no machine is paired"
    behind = [r for r in rows if device_facts.agent_version(r["facts"]) != build.version]
    if not behind:
        return f"every agent runs the hub's build {build.version}"
    tried = {
        t["device_id"]: t["outcome"]
        for t in await pool.fetch(_TRIED_SQL, build.version, list(ENDED_REASONS))
    }
    # The others wait for a hub agent that may still take this build — not
    # for one already tried with it: a refusal halts nothing for the others.
    hub_first = [r for r in behind if r["last_transport"] == "host" and r["id"] not in tried]
    skipped = []
    for r in hub_first or behind:
        if r["id"] in tried:
            skipped.append(f"{r['name']} (this build was already tried there: {tried[r['id']]})")
            continue
        why = _why_not(r, build)
        if why:
            skipped.append(f"{r['name']} ({why})")
            continue
        out = await update_now(pool, name=r["name"], requested_by="reconciler", wait_s=0)
        return _sent_words(out, build.version, r["name"], hub=bool(hub_first))
    wait = "; the others wait for the hub's own agent" if hub_first else ""
    return "nothing sent: " + "; ".join(skipped) + wait
