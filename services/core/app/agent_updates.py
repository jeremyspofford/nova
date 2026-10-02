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
connection at that epoch, and a re-pair ends it in the very transaction that
moves the row on (end_on_repair) — so the new key's first connection can never
decide an update that was sent to the old one.

Two ways to send (P11): the daemon.update capability (S42b agents), or — for
an S42a Linux agent under the README's systemd unit, which answers `unknown
capability "daemon.update"` — its own shell.exec, every argv composed HERE and
the build run only after core compared its sha256. Anything else is a stated
cannot naming the one step the owner takes (P12). Whether Nova can update an
agent, and how, is decided in one place (eligibility), which the send, the job
and the devices_agents_behind check all read (F14).

The timer job `agent_updates` (timers.JOBS) runs reconcile() every 15
minutes: one idle machine at a time, the hub's own agent first, never a
version that already failed anywhere (P10).
"""

from __future__ import annotations

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass
from datetime import datetime

import asyncpg

from app import agent_card, agent_dist, device_facts, devices, devices_ws, network

logger = logging.getLogger("core")

CONFIRM_WITHIN_S = 600
IDLE_S = 300
WAIT_S = 120
COMMAND_TIMEOUT_S = 120
UNKNOWN_CAPABILITY = 'unknown capability "daemon.update"'
FAILED = ("rolled_back", "not_confirmed", "refused")
# A stored reason is shown on ONE line (machine_status's agent line, the
# tile): never longer than this, never a line break (_one_line).
REASON_MAX = 300
REPAIRED_REASON = (
    "the machine was re-paired before the agent this was sent to reconnected on the new "
    "build — that agent's key can no longer connect, so nothing can confirm it"
)

# Opened only while the row is still at the epoch the caller read it at. FOR
# SHARE serializes this with a re-pair's rebind (devices._REBIND_SQL locks the
# row FOR UPDATE): a rebind that committed first leaves nothing to open, and
# one that commits after finds this attempt and ends it (end_on_repair).
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
_FAILED_SQL = (
    "SELECT d.name, u.outcome, u.reason FROM agent_updates u JOIN devices d ON d.id = u.device_id "
    "WHERE u.version = $1 AND u.outcome = ANY($2::text[]) ORDER BY u.sent_at DESC LIMIT 1"
)
_HOME = re.compile(r"(?:^|;\s*)home=([^;]+)")
# What ends or breaks a line wherever a reason is shown: the C0 and C1
# controls (NUL among them — postgres cannot store it), DEL, and the line and
# paragraph separators str.splitlines() also splits on.
_BREAKS = re.compile(r"[\x00-\x1f\x7f-\x9f  ]+")


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

    `token`: "service" (Nova can), or "no_facts" / "by_hand" — a stated
    cannot, and the check's `why`. `said` and `step`: for a cannot, what is
    true of the agent (a clause after "<name>'s agent") and the one step the
    owner takes (P12). `bootstrap` (P11): if the agent answers `unknown
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

    def cannot(self, name: str) -> str:
        return f"{name}'s agent {self.said} — {self.step}"


def eligibility(row) -> Eligibility:
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
    goos = (facts.get("os") or {}).get("goos")
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
    rows = await pool.fetch(
        "UPDATE agent_updates SET outcome = 'not_confirmed', outcome_at = now(), reason = $1 "
        "WHERE outcome = 'sent' AND sent_at < now() - make_interval(secs => $2) RETURNING id",
        f"no reconnect reporting the new build within {CONFIRM_WITHIN_S // 60} minutes",
        CONFIRM_WITHIN_S,
    )
    return len(rows)


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
    so there is nothing to record — a cannot, like every other."""
    await pool.execute("DELETE FROM agent_updates WHERE id = $1 AND outcome = 'sent'", attempt_id)


async def end_on_repair(conn, device_id) -> int:
    """A re-pair moved `device_id` to a new key and audit epoch (devices.enroll
    calls this inside the transaction that does it). An update still `sent`
    went to the agent that held the OLD key, which can no longer
    authenticate: no reconnect can confirm it, and the new key's first
    connection must never be read as that agent's. Decided here, as what is
    true, in the same commit that moves the row on."""
    rows = await conn.fetch(
        "UPDATE agent_updates SET outcome = 'not_confirmed', outcome_at = now(), reason = $2 "
        "WHERE device_id = $1 AND outcome = 'sent' RETURNING id",
        device_id,
        REPAIRED_REASON,
    )
    return len(rows)


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
    if device_facts.agent_version(facts) == open_["version"]:
        outcome, reason = "confirmed", None
    else:
        update = (facts.get("agent") or {}).get("update") or {}
        if (
            update.get("version") != open_["version"]
            or update.get("outcome") != "rolled_back"
            or not _recorded_after(update.get("at"), open_["sent_at"])
        ):
            return None
        outcome = "rolled_back"
        reason = update.get("reason") or "its supervisor put the previous build back"
    return outcome if await _close(pool, open_["id"], outcome, reason, epoch=epoch) else None


async def update_now(
    pool,
    *,
    name: str,
    requested_by: str,
    wait_s: float = WAIT_S,
    facts_sink: list[dict] | None = None,
) -> UpdateOutcome:
    """Send the hub's build to `name` now and wait up to wait_s for its
    reconnect to decide the attempt. A command already running there ends
    "cancelled" when the agent restarts (P25); in_flight says how many (F15:
    a count — the hub keeps futures, not capability names).

    `facts_sink`, when a tool threads one through, receives the
    {device, connected} fact this call determined."""
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
    able = eligibility(row)
    if not able.can:
        return _cannot(name, f"cannot: {able.cannot(name)}", needs_card=True, **kw)
    os_ = facts.get("os") or {}
    entry = build.file_for(os_.get("goos"), os_.get("arch"))
    if entry is None:
        return _cannot(
            name, f"cannot: the hub has no build for {os_.get('goos')}/{os_.get('arch')}", **kw
        )
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
        return await _await(pool, attempt_id, name, kw, wait_s, in_flight)
    if result.get("ok"):
        return await _await(pool, attempt_id, name, kw, wait_s, in_flight)
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
    return await _await(pool, attempt_id, name, kw, wait_s, in_flight)


async def _await(
    pool, attempt_id, name: str, kw: dict, wait_s: float, in_flight: int
) -> UpdateOutcome:
    """The attempt as it is recorded, once it is decided or wait_s has
    passed — what the caller is told is what the ledger holds."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + wait_s
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
        await asyncio.sleep(min(0.5, max(0.0, deadline - loop.time())))


async def _step(
    pool, row, capability: str, args: dict, step: str, *, epoch: int, sent_is_enough: bool = False
) -> dict | None:
    """One command of the bootstrap, to the agent at `epoch` and no other: a
    later step runs a file an earlier one checked ON THAT AGENT. None when
    `sent_is_enough` and it went unanswered — the install step, whose own
    restart can cut its reply off: only the reconnect can say."""
    try:
        return await devices_ws.hub.command(
            pool,
            device_id=row["id"],
            name=row["name"],
            capability=capability,
            args=args,
            timeout=COMMAND_TIMEOUT_S,
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
        raise _BootstrapRefused(
            f"{row['name']} did not answer the {step} step ({exc.reason}) — nothing past it was run"
        ) from exc


async def _exec(
    pool, row, argv: list[str], step: str, *, epoch: int, sent_is_enough: bool = False
) -> str:
    result = await _step(
        pool, row, "shell.exec", {"argv": argv}, step, epoch=epoch, sent_is_enough=sent_is_enough
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
    info = await _step(pool, row, "system.info", {}, "system.info", epoch=epoch)
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
        pool, row, ["curl", "-fsSL", "--create-dirs", "-o", target, url], "download", epoch=epoch
    )
    out = await _exec(pool, row, ["sha256sum", target], "checksum", epoch=epoch)
    got = (out.split() or [""])[0]
    if got != entry["sha256"]:
        shown = f"{got[:12]}…" if got else "not printed"
        raise _BootstrapRefused(
            f"the download's sha256 on {name} is {shown}, not the hub's "
            f"{entry['sha256'][:12]}… — nothing was run"
        )
    await _exec(pool, row, ["chmod", "0755", target], "chmod", epoch=epoch)
    await _exec(
        pool,
        row,
        [target, "install", "--restart-later"],
        "install",
        epoch=epoch,
        sent_is_enough=True,
    )


# The words the job says for a machine it passes by.
_PASSED_BY = {"no_facts": "it has not reported how it runs", "by_hand": "started by hand"}


def _why_not(row) -> str | None:
    """Why the job passes this machine by (P10), or None when it may send."""
    if not _connected(row, None):
        return "offline"
    able = eligibility(row)
    if not able.can:
        return _PASSED_BY[able.token]
    if not devices_ws.hub.idle(row["id"], IDLE_S):
        return "busy: a command is in flight there, or one was sent in the last 5 minutes"
    return None


async def reconcile(pool) -> str:
    """The job's one pass (P10): at most ONE update sent, and the words the
    firing records."""
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
    failed = await pool.fetchrow(_FAILED_SQL, build.version, list(FAILED))
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
    hub_first = [r for r in behind if r["last_transport"] == "host"]
    first = " — the hub's own agent first" if hub_first else ""
    skipped = []
    for r in hub_first or behind:
        why = _why_not(r)
        if why:
            skipped.append(f"{r['name']} ({why})")
            continue
        out = await update_now(pool, name=r["name"], requested_by="reconciler", wait_s=0)
        if out.outcome == "sent":
            tail = "not confirmed until it reconnects on it"
        else:
            tail = out.outcome + (f" — {out.reason}" if out.reason else "")
        verb = "sent" if out.attempt_id is not None else "did not send"
        return f"{verb} the hub's build {build.version} to {r['name']}{first}; {tail}"
    wait = "; the others wait for the hub's own agent" if hub_first else ""
    return "nothing sent: " + "; ".join(skipped) + wait
