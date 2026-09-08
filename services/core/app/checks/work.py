"""The work you gave her: timers that stopped, delegations that failed, agents
that have spent their allowance.

None of it is urgent — Jeremy's list has one entry and this is not it. A timer
that paused itself waits for the digest; so does a failed delegation and so
does an agent over its cap. `Check.urgent` is False on every check here and
app/checks/__init__.py overwrites each finding with that declaration, so no
wording in this module can promote one.

Two habits run through the facts below, both to stop the v3 noise failure:

  * a live measurement (this month's spend, a running total) stays in the
    TITLE and out of `facts`, because `facts` is what the fingerprint hashes
    and a figure that moves every hour would re-raise the same news hourly;
  * what identifies the SUBJECT and what makes the condition true go in
    `facts` — a timer's id and the instant it was paused, an agent's name and
    its cap and the calendar month — so the finding speaks again exactly when
    the world changes and not before.

Nothing here reads the notices table to decide whether to speak. Telling him
once is the fold's job (one live row per fingerprint, repeats counted); a
second suppression list in the checks would be an unaccountable one.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app import agents, settings_store, timers
from app.checks import CannotCheck, Check, Finding
from app.tools.base import ERROR_PREFIX

# One short of the ceiling that pauses a timer, DERIVED from the ceiling
# itself: the point of this check is to say something while the timer is still
# running, and a hardcoded 4 would silently stop meaning that the day someone
# changes timers.FAILURES_BEFORE_PAUSE.
WARN_AT_FAILURES = timers.FAILURES_BEFORE_PAUSE - 1

# How far back a failed delegation is still news. A day, so an hourly beat
# folds the same failure onto one notice and the digest reports it once.
DELEGATION_WINDOW = timedelta(days=1)
DELEGATION_WINDOW_HOURS = DELEGATION_WINDOW.total_seconds() / 3600

ERROR_HEAD_CHARS = 200


async def paused_timers(app, pool) -> list[Finding]:
    """Every timer that is paused, with the reason the row carries.

    A pause always says why (the timers_pause_states_why CHECK), so the reason
    is a row fact, not an inference. `title` is deliberately absent from the
    facts: renaming a timer is not news about its pause, and a fingerprint
    over the title would re-raise the notice when the owner tidied a label.
    """
    rows = await pool.fetch(
        "SELECT id, kind, title, paused_at, paused_reason, consecutive_failures FROM timers "
        "WHERE paused_at IS NOT NULL ORDER BY paused_at, id"
    )
    return [
        Finding(
            key=f"timer_paused:{row['id']}",
            title=(
                f"the {row['kind']} {row['title']!r} is paused since "
                f"{row['paused_at'].isoformat(timespec='seconds')} — {row['paused_reason']}"
            ),
            facts={
                "timer_id": str(row["id"]),
                "kind": row["kind"],
                "reason": row["paused_reason"],
                "paused_at": row["paused_at"].isoformat(),
                "consecutive_failures": row["consecutive_failures"],
            },
        )
        for row in rows
    ]


async def failing_timers(app, pool) -> list[Finding]:
    """A timer one failure short of pausing itself.

    The point is to say it BEFORE the ceiling: at WARN_AT_FAILURES the next
    failure pauses the row, and a paused row is the other check's subject.
    Already-paused rows are excluded here so one timer is never two notices.
    """
    rows = await pool.fetch(
        "SELECT id, kind, title, consecutive_failures FROM timers "
        "WHERE paused_at IS NULL AND consecutive_failures >= $1 "
        "ORDER BY consecutive_failures DESC, id",
        WARN_AT_FAILURES,
    )
    return [
        Finding(
            key=f"timer_failing:{row['id']}",
            title=(
                f"the {row['kind']} {row['title']!r} has failed "
                f"{row['consecutive_failures']} times in a row — it pauses itself at "
                f"{timers.FAILURES_BEFORE_PAUSE}"
            ),
            facts={
                "timer_id": str(row["id"]),
                "kind": row["kind"],
                "consecutive_failures": row["consecutive_failures"],
                "pause_ceiling": timers.FAILURES_BEFORE_PAUSE,
            },
        )
        for row in rows
    ]


def _agent_of(meta: dict) -> str:
    """Which agent the failed delegation was for, read off the span.

    First the run facts the delegate tool wrote into `meta.facts` (they name
    the agent even when the run was refused before it started), then the
    recorded arguments. A span that names neither says so in words rather
    than inventing a name.
    """
    for entry in meta.get("facts") or []:
        if isinstance(entry, dict) and str(entry.get("agent") or "").strip():
            return str(entry["agent"]).strip()
    args = meta.get("args_redacted")
    if isinstance(args, dict) and str(args.get("agent") or "").strip():
        return str(args["agent"]).strip()
    return "(the trace does not name the agent)"


def _error_head(meta: dict) -> str:
    """The failure's first line, without the tool-result prefix. Mirrors
    agents._error_head so a notice and a delegation chip read the same."""
    text = str(meta.get("error") or meta.get("result_head") or "").strip()
    if text.startswith(ERROR_PREFIX):
        text = text[len(ERROR_PREFIX) :]
    text = text.splitlines()[0] if text else "(no reason recorded)"
    if len(text) > ERROR_HEAD_CHARS:
        text = text[: ERROR_HEAD_CHARS - 1].rstrip() + "…"
    return text


async def failed_delegations(app, pool) -> list[Finding]:
    """Delegations that closed error in the last day.

    Read from the trace, which is the fact — `meta.ok` is written by the one
    dispatch path every tool call goes through, so a delegation cannot be
    recorded as fine because its reply said so. One notice per SPAN: two
    failures of the same agent are two separate things that happened.
    """
    rows = await pool.fetch(
        "SELECT id, turn_id, started_at, meta FROM turn_spans "
        "WHERE kind = 'tool' AND name = $1 AND meta->>'ok' = 'false' "
        "AND started_at >= now() - $2::interval ORDER BY started_at, id",
        agents.DELEGATE_TOOL,
        DELEGATION_WINDOW,
    )
    findings = []
    for row in rows:
        meta = row["meta"] if isinstance(row["meta"], dict) else {}
        name = _agent_of(meta)
        head = _error_head(meta)
        findings.append(
            Finding(
                key=f"delegation_failed:{row['id']}",
                title=(
                    f"the delegation to {name} on "
                    f"{row['started_at'].isoformat(timespec='seconds')} failed — {head}"
                ),
                facts={
                    "span_id": str(row["id"]),
                    "turn_id": str(row["turn_id"]),
                    "agent": name,
                    "at": row["started_at"].isoformat(),
                    "error": head,
                },
            )
        )
    return findings


async def _ledger_month(pool) -> tuple[str, str]:
    """The calendar month the ledger's `month` window is counting, and its
    zone — or CannotCheck, in words, if either cannot be established.

    Read from the SAME setting spend_api.report sends to the gateway, so this
    label names the period the figures actually came from. Both values go in
    the facts, and the facts are what the fingerprint hashes, which is why the
    old fallback was a bug and not a kindness: it swallowed a failed settings
    read and an unloadable zone into the literal word "UTC", so the notice
    carried a label nothing had verified and the hash was computed over it. A
    month named wrong does not just read wrong — it folds October's cap breach
    onto September's row (told once, ever) or splits one breach into two rows
    an hour apart. Stating "I could not name the period these figures cover"
    costs one beat's finding; the swallow cost it silently and permanently.
    """
    try:
        stored = await settings_store.read_value(pool, "nova.timezone")
    except Exception as exc:  # noqa: BLE001 — stated in words, never folded into a label
        raise CannotCheck(
            f"the household timezone could not be read, so the month these figures cover "
            f"cannot be named — {type(exc).__name__}: {exc}".strip()
        ) from exc
    # An UNSET setting is not a failure: "UTC" is the def's own default and is
    # exactly what spend_api.report sends the gateway, so the label still
    # names the period the figures were grouped by.
    zone = str(stored or "UTC")
    try:
        now = datetime.now(ZoneInfo(zone))
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise CannotCheck(
            f"nova.timezone is set to {zone!r}, which does not load, so the month these "
            f"figures cover cannot be named — {type(exc).__name__}"
        ) from exc
    return now.strftime("%Y-%m"), zone


async def agents_over_cap(app, pool) -> list[Finding]:
    """An agent whose month's spend has reached or passed its monthly cap.

    The money is agents.list_with_state's — ONE ledger report shared by every
    agent, the same report the Agents page and cap_problem read, so a notice
    and a page can never disagree. An unreadable ledger is CheckRun(ran=False)
    with the gateway's own reason: a 0 for unknown would read as "spent
    nothing this month", which is the false all-clear this slice exists to
    stop.
    """
    rows = await agents.list_with_state(pool, app)
    for row in rows:
        if row.get("spend_note"):
            raise CannotCheck(str(row["spend_note"]))
    month, zone = await _ledger_month(pool)
    findings = []
    for row in rows:
        cap, spent = row.get("monthly_cap_usd"), row.get("spent_month_usd")
        if cap is None or not isinstance(spent, int | float):
            continue
        if spent < cap:
            continue
        # "reached" at equality and "over" only past it — the same distinction
        # agents.cap_problem persists, so the sentence never records a figure
        # the ledger did not show.
        word = "is over" if spent > cap else "has reached"
        findings.append(
            Finding(
                key=f"agent_over_cap:{row['name']}",
                title=(
                    f"agent {row['name']} {word} its monthly cap — "
                    f"{agents.money(spent)} of {agents.money(cap)} in {month}"
                ),
                facts={
                    # The live figure is in the title, not here: it moves with
                    # every call and would re-raise this notice hourly.
                    "agent": row["name"],
                    "role": row["role"],
                    "cap_usd": float(cap),
                    "month": month,
                    "month_zone": zone,
                },
            )
        )
    return findings


CHECKS: tuple[Check, ...] = (
    Check(
        name="work_paused_timers",
        describe="Timers that are paused, with the reason on the row.",
        urgent=False,
        run=paused_timers,
    ),
    Check(
        name="work_failing_timers",
        describe=f"Timers at {WARN_AT_FAILURES}+ consecutive failures, one short of pausing.",
        urgent=False,
        run=failing_timers,
    ),
    Check(
        name="work_failed_delegations",
        describe=f"Delegations that closed error in the last {DELEGATION_WINDOW_HOURS:g} hours.",
        urgent=False,
        run=failed_delegations,
    ),
    Check(
        name="work_agents_over_cap",
        describe="Agents whose month's spend has reached their monthly cap.",
        urgent=False,
        run=agents_over_cap,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
