"""The wakes family (S46a T12): a background wake that landed, as a notice.

A turn whose route found a machine's link unreachable wakes that machine in
the background (S46a T10) — nobody is waiting on the answer, so the answer is
news: "<machine> answered after N s", or "a wake was sent at T; no answer in
N s". wake.py files the notice the moment the wake's wait ends, whether or
not the watch beat is on; this check derives the SAME finding, with the same
facts, from the wake_attempts rows every hour, so the beat folds onto that
notice instead of raising a second one (and files it if the moment was lost
to a restart). Non-urgent: nothing here wakes anyone.

ONE NOTICE PER ATTEMPT. The key is the attempt's id and the facts are the
row's columns that never move once the wait ended (when it was sent, its
deadline, how long after the send its agent / its model answered) — never
`outcome`, which an answered row with no model to probe only takes at its
deadline, so a fact read at the moment and one read an hour later would
otherwise differ and raise the same news twice.

Only trigger='route' rows: a wake she was asked for (machine_wake) is
answered in her reply, in the turn that asked.
"""

from __future__ import annotations

from datetime import UTC, datetime

from app.checks import Check, Finding

LANDED = "machine_wakes"
WINDOW_DAYS = 1


def _utc(at: datetime) -> str:
    return at.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S UTC")


def _after(at: datetime | None, sent_at: datetime) -> int | None:
    return None if at is None else int((at - sent_at).total_seconds())


def finding_for(machine: str, row: dict, walls: str | None = None) -> Finding | None:
    """The notice a background wake's row deserves once its wait ended, or
    None while it has neither answered nor been decided no_answer (or was
    never sent). `walls` is the sentence about the gateway's walls the wake
    lifted, when it lifted any — title only, never a fact."""
    sent_at = row.get("sent_at")
    if sent_at is None:
        return None
    answered = _after(row.get("answered_at"), sent_at)
    serving = _after(row.get("serving_at"), sent_at)
    if answered is None and row.get("outcome") != "no_answer":
        return None
    facts = {
        "machine": machine,
        "attempt": str(row["id"]),
        "sent_at": sent_at.astimezone(UTC).isoformat(),
        "deadline_s": row.get("deadline_s"),
        "answered_after_s": answered,
        "serving_after_s": serving,
    }
    if answered is None:
        title = (
            f"{machine}: a wake was sent at {_utc(sent_at)}; no answer in "
            f"{row.get('deadline_s')} s."
        )
    else:
        title = f"{machine} answered after {answered} s"
        if serving is not None:
            title += f"; its model served after {serving} s"
        title += "."
        if walls:
            title += f" {walls}"
    return Finding(key=f"wake_landed:{row['id']}", title=title, facts=facts)


_SQL = """
SELECT w.id, w.sent_at, w.deadline_s, w.answered_at, w.serving_at, w.outcome, d.name
  FROM wake_attempts w JOIN devices d ON d.id = w.device_id
 WHERE w.trigger = 'route' AND w.sent_at IS NOT NULL
   AND w.sent_at > now() - make_interval(days => $1)
   AND (w.answered_at IS NOT NULL OR w.outcome = 'no_answer')
 ORDER BY w.sent_at, w.id
"""


async def landed(app, pool) -> list[Finding]:
    found = (finding_for(row["name"], dict(row)) for row in await pool.fetch(_SQL, WINDOW_DAYS))
    return [finding for finding in found if finding is not None]


CHECKS: tuple[Check, ...] = (
    Check(
        name=LANDED,
        describe=(
            "Wakes Nova sent in the background when a machine's model did not answer a "
            "turn: whether the machine answered, and after how long."
        ),
        urgent=False,
        run=landed,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
