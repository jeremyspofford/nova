"""Nova moving her own hub to a newer commit (about-and-updates.md, part 2).

The update restarts the core that asked for it and takes minutes, so it can
never be one tool call that waits for its own answer. It is three steps, each
with its own fact:

  1. **start** (nova_update, or the About page's button): GitHub must say
     there is something to pull, the hub's own agent must be connected, and
     the checkout must be known. A row is opened `sent` FIRST — the database
     holds one open update at a time — and then one command goes to the hub's
     agent: run `./install update --attempt <id>` detached, so neither this
     turn ending nor core restarting cuts it short. What comes back says it
     STARTED, never that it worked.
  2. **./install update** on the hub backs up, fast-forwards, reinstalls, and
     rolls back if the reinstall fails (deploy/install.sh cmd_update).
  3. **finish** (`python -m app.updates_cli finish`, run by the installer in
     the core it just brought up): the installer states what happened, and
     `confirmed` additionally needs THIS core's own NOVA_COMMIT to be the
     target. "Installed" from an installer whose core is running something
     else is recorded as failed, with both commits named.

A row nobody decides within CONFIRM_WITHIN reads as not_confirmed — the
agent's job died, the host rebooted, the installer could not reach core — and
stops holding the one open slot. No sentence anywhere confirms an update.

No approval step (owner ruling 2026-09-03): the refusals here are facts about
whether it CAN run — nothing to pull, no agent, no checkout, one already
running — never a judgement that it may not.
"""

from __future__ import annotations

import logging
import os
import re
import shlex
import uuid
from datetime import UTC, datetime, timedelta

import asyncpg

from app import about, devices, devices_ws

logger = logging.getLogger("core")

CHECKOUT_ENV = "NOVA_CHECKOUT"
CONFIRM_WITHIN = timedelta(minutes=45)
SEND_TIMEOUT_S = 30.0
OUTCOMES = ("sent", "confirmed", "failed", "refused", "up_to_date", "not_confirmed")
# What the installer may report (cmd_update). `installed` becomes confirmed or
# failed here, by this core's own commit — never stored as said.
REPORTED = ("installed", "failed", "refused", "up_to_date")
REASON_MAX = 600
_COMMIT = re.compile(r"[0-9a-f]{40}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class CannotUpdate(Exception):
    """The update cannot run, and why — stated to her and on the page."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _one_line(text: str | None) -> str | None:
    if not text:
        return None
    return _CONTROL.sub(" ", text).strip()[:REASON_MAX] or None


def checkout() -> str | None:
    """Where the checkout ./install runs from lives on the hub host (written by
    record_build). An absolute path with no control characters, or None."""
    value = os.environ.get(CHECKOUT_ENV, "").strip()
    if not value.startswith("/") or _CONTROL.search(value) or ".." in value.split("/"):
        return None
    return value.rstrip("/") or None


def _row(row: asyncpg.Record | None, now: datetime | None = None) -> dict | None:
    if row is None:
        return None
    now = now or datetime.now(UTC)
    outcome = row["outcome"]
    reason = row["reason"]
    # Derived on read as well as written by expire_stale: a page must not show
    # "running" for an attempt nothing can decide any more.
    if outcome == "sent" and now - row["started_at"] > CONFIRM_WITHIN:
        # The stored reason of a `sent` row is the agent's "started: …" line,
        # which says nothing about why it was never decided.
        outcome = "not_confirmed"
        reason = _stale_reason(row)
    return {
        "id": str(row["id"]),
        "from_commit": row["from_commit"],
        "to_commit": row["to_commit"],
        "requested_by": row["requested_by"],
        "device": row["device"],
        "log_path": row["log_path"],
        "outcome": outcome,
        "reason": reason,
        "started_at": row["started_at"].isoformat(),
        "decided_at": row["decided_at"].isoformat() if row["decided_at"] else None,
    }


def _stale_reason(row) -> str:
    where = f" — its log on {row['device']}: {row['log_path']}" if row["log_path"] else ""
    return (
        f"nothing reported back within {int(CONFIRM_WITHIN.total_seconds() // 60)} minutes: the "
        f"installer's job stopped, the host restarted, or it could not reach core{where}"
    )


async def expire_stale(pool) -> None:
    """Close every `sent` row older than CONFIRM_WITHIN as not_confirmed."""
    rows = await pool.fetch(
        "SELECT * FROM nova_updates WHERE outcome = 'sent' AND started_at < now() - $1::interval",
        CONFIRM_WITHIN,
    )
    for row in rows:
        await pool.execute(
            "UPDATE nova_updates SET outcome = 'not_confirmed', reason = $2, decided_at = now() "
            "WHERE id = $1 AND outcome = 'sent'",
            row["id"],
            _stale_reason(row),
        )


async def latest(pool) -> dict | None:
    return _row(await pool.fetchrow("SELECT * FROM nova_updates ORDER BY started_at DESC LIMIT 1"))


async def _hub_agent(pool, facts_sink: list[dict] | None = None) -> asyncpg.Record:
    """The hub's own agent, connected, or CannotUpdate. Each connectivity read
    is recorded on facts_sink, the shape tools/devices._require_connected
    writes, so her "the hub's agent is not connected" is a checked fact."""
    rows = await pool.fetch(
        "SELECT id, name FROM devices WHERE revoked_at IS NULL AND last_transport = 'host' "
        "ORDER BY last_seen DESC NULLS LAST"
    )
    if not rows:
        raise CannotUpdate(
            "no agent is paired on the hub itself, so nothing on the hub can run the update — "
            "run `git pull && ./install` on the hub (./install pairs its agent)"
        )
    for row in rows:
        connected = devices_ws.hub.is_connected(row["id"])
        if facts_sink is not None:
            facts_sink.append({"device": row["name"], "connected": connected})
        if connected:
            return row
    raise CannotUpdate(
        f"the hub's own agent ({rows[0]['name']}) is not connected, so nothing on the hub can run "
        "the update — run `git pull && ./install` on the hub"
    )


def launch_script(checkout_dir: str, attempt: str) -> tuple[str, str, str]:
    """(script, log path, unit) — the one shell command the hub's agent runs.

    Every value is composed HERE and quoted; nothing she said reaches it. The
    run is detached from the agent: a systemd transient unit where there is
    one (it survives the agent's own restart, which ./install can cause), else
    setsid/nohup. It prints `started: …` and nothing claims more than that."""
    q = shlex.quote
    log = f"{checkout_dir}/deploy/.update-{attempt[:8]}.log"
    unit = f"nova-update-{attempt[:8]}"
    inner = f"exec ./install update --attempt {attempt} >>{q(log)} 2>&1 </dev/null"
    run = f"--quiet --collect --unit={unit} --working-directory={q(checkout_dir)} sh -c {q(inner)}"
    no_dir = q(f"cannot: no checkout at {checkout_dir}")
    no_install = q(f"cannot: {checkout_dir}/install is missing")
    script = "\n".join(
        [
            f"cd {q(checkout_dir)} || {{ echo {no_dir}; exit 3; }}",
            f"[ -x ./install ] || {{ echo {no_install}; exit 3; }}",
            "if command -v systemd-run >/dev/null 2>&1 && "
            f"systemd-run --user {run} 2>/dev/null; then",
            f"  echo 'started: systemd-run --user unit {unit}'",
            'elif command -v systemd-run >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && '
            f"systemd-run {run} 2>/dev/null; then",
            f"  echo 'started: systemd-run unit {unit}'",
            "elif command -v setsid >/dev/null 2>&1; then",
            f"  nohup setsid sh -c {q(inner)} >/dev/null 2>&1 &",
            '  echo "started: detached with setsid, pid $!"',
            "else",
            f"  nohup sh -c {q(inner)} >/dev/null 2>&1 &",
            '  echo "started: detached with nohup, pid $!"',
            "fi",
        ]
    )
    return script, log, unit


async def start(app, pool, *, requested_by: str, facts_sink: list[dict] | None = None) -> dict:
    """Start an update of the hub to the newest commit on its branch, or raise
    CannotUpdate with the reason. Returns the opened row once the hub's agent
    said it started the installer — never more than that."""
    await expire_stale(pool)
    build = about.build_info()
    updates = await about.check_updates(app, build, refresh=True)
    state = updates["state"]
    if state == "up_to_date":
        raise CannotUpdate(
            f"nothing to install: {build['short']} is the newest on {build['branch']}"
        )
    if state == "local_ahead":
        raise CannotUpdate(
            f"nothing to install: this hub runs {updates['ahead_by']} commit(s) that "
            f"{build['branch']} does not have, and nothing new"
        )
    if state == "diverged":
        raise CannotUpdate(
            f"the hub's checkout and {build['branch']} have diverged ({updates['ahead_by']} "
            "commit(s) here that the branch lacks) — an update only fast-forwards, so this "
            "needs a person to merge on the hub"
        )
    if state != "available":
        raise CannotUpdate(f"whether there is an update could not be checked: {updates['reason']}")
    if build["dirty"]:
        raise CannotUpdate(
            "the hub was brought up with uncommitted changes, and ./install update refuses a "
            "dirty checkout rather than overwrite them"
        )
    target = updates["latest"]["sha"] if updates["latest"] else None
    checkout_dir = checkout()
    if checkout_dir is None:
        raise CannotUpdate(
            f"this core does not know where the checkout is on the hub ({CHECKOUT_ENV} is unset — "
            "re-running ./install once writes it)"
        )
    agent = await _hub_agent(pool, facts_sink)
    attempt = uuid.uuid4()
    script, log, _unit = launch_script(checkout_dir, str(attempt))
    try:
        await pool.execute(
            "INSERT INTO nova_updates (id, from_commit, to_commit, requested_by, device, "
            "log_path, outcome) VALUES ($1, $2, $3, $4, $5, $6, 'sent')",
            attempt,
            build["commit"],
            target,
            requested_by,
            agent["name"],
            log,
        )
    except asyncpg.UniqueViolationError:
        running = await latest(pool)
        since = running["started_at"] if running else "earlier"
        raise CannotUpdate(
            f"an update is already running (started {since}); it is decided when the installer "
            "reports back"
        ) from None

    async def refuse(reason: str) -> None:
        await pool.execute(
            "UPDATE nova_updates SET outcome = 'refused', reason = $2, decided_at = now() "
            "WHERE id = $1",
            attempt,
            reason,
        )
        raise CannotUpdate(reason)

    try:
        result = await devices_ws.hub.command(
            pool,
            device_id=agent["id"],
            name=agent["name"],
            capability="shell.exec",
            args={"argv": ["sh", "-c", script]},
            timeout=SEND_TIMEOUT_S,
            facts_sink=facts_sink,
        )
    except devices_ws.NotSent as exc:
        await refuse(f"the command did not reach {agent['name']}: {exc.reason}")
    except devices.DeviceRefused as exc:
        await refuse(f"{agent['name']} did not run the command: {exc.reason}")
    output = str(result.get("output") or "").strip()
    if not result.get("ok") or result.get("exit_code") != 0 or not output.startswith("started:"):
        said = _one_line(output or str(result.get("error") or "")) or "it said nothing"
        code = result.get("exit_code")
        await refuse(f"{agent['name']} could not start the installer (exit {code}): {said}")
    await pool.execute(
        "UPDATE nova_updates SET reason = $2 WHERE id = $1", attempt, _one_line(output)
    )
    row = await latest(pool)
    assert row is not None
    return row


async def finish(
    pool,
    *,
    attempt: str | None,
    outcome: str,
    from_commit: str,
    to_commit: str | None,
    reason: str | None,
    running_commit: str | None,
) -> dict:
    """Record what the installer reports; `installed` is confirmed only when
    `running_commit` (this core's own NOVA_COMMIT) is the target. Without an
    attempt (an ./install update run by hand) a row is written for it."""
    if outcome not in REPORTED:
        raise CannotUpdate(f"{outcome!r} is not an outcome the installer reports")
    if not _COMMIT.fullmatch(from_commit or ""):
        raise CannotUpdate("--from is not a 40-character commit")
    if to_commit is not None and not _COMMIT.fullmatch(to_commit):
        raise CannotUpdate("--to is not a 40-character commit")
    reason = _one_line(reason)
    stored = outcome
    if outcome == "installed":
        if to_commit is not None and running_commit == to_commit:
            stored = "confirmed"
        else:
            stored = "failed"
            reason = (
                f"the installer said it installed {(to_commit or '?')[:7]}, but this core runs "
                f"{(running_commit or 'an unstamped build')[:7]}"
            )
    if attempt:
        try:
            attempt_id = uuid.UUID(attempt)
        except ValueError:
            raise CannotUpdate("--attempt is not an attempt id") from None
        row = await pool.fetchrow(
            "UPDATE nova_updates SET outcome = $2, reason = $3, "
            "to_commit = COALESCE($4, to_commit), decided_at = now() "
            "WHERE id = $1 AND outcome IN ('sent', 'not_confirmed') RETURNING *",
            attempt_id,
            stored,
            reason,
            to_commit,
        )
        if row is None:
            raise CannotUpdate(f"no undecided update {attempt} to record this against")
    else:
        row = await pool.fetchrow(
            "INSERT INTO nova_updates (from_commit, to_commit, requested_by, outcome, reason, "
            "decided_at) VALUES ($1, $2, 'by hand on the hub', $3, $4, now()) RETURNING *",
            from_commit,
            to_commit,
            stored,
            reason,
        )
    decided = _row(row)
    assert decided is not None
    logger.info("update %s: %s (%s)", decided["id"], decided["outcome"], decided["reason"])
    return decided


def words(row: dict | None) -> str:
    """The latest update attempt in one line, for her and the page."""
    if row is None:
        return "no update has been run from Nova"
    span = f"{(row['from_commit'] or '?')[:7]} → {(row['to_commit'] or '?')[:7]}"
    head = f"{span}, asked by {row['requested_by']}, started {row['started_at']}"
    said = {
        "sent": "started, not yet reported back",
        "confirmed": "confirmed: the installer reported it installed and this core runs it",
        "failed": "failed",
        "refused": "did not start",
        "up_to_date": "nothing to install",
        "not_confirmed": "not confirmed",
    }[row["outcome"]]
    reason = f" — {row['reason']}" if row["reason"] and row["outcome"] != "confirmed" else ""
    log = (
        f" (log on {row['device']}: {row['log_path']})"
        if row["log_path"] and row["outcome"] in ("sent", "failed", "not_confirmed")
        else ""
    )
    return f"{head}: {said}{reason}{log}"
