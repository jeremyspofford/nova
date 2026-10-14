"""The event outcomes family (S37c T4): what she found when an event started a
turn of hers, as a notice (docs/plans/rebuild/s37c/spec.md §2.4, §4).

events.py files the notice the moment the event turn settles (and delivers it
at once when an event in it is urgent); this check derives the SAME finding,
with the same key and facts, from the event rows every hour, so the beat folds
onto that notice instead of raising a second one, files it if the moment was
lost, and does not reconcile it away before the digest has told him. The
machine_wakes pattern (app/checks/wakes.py).

ONE NOTICE PER TURN: the key is the event turn's id and the facts are the
sender, the ids of the events it read (in order), the turn and the outcome —
values that never move once the rows settle. An event no turn ever opened for
(no chat model, no owner, the turn could not be opened) gets one of its own,
keyed by its id. The title is written by CODE: the sender, how many events,
and her one-line conclusion — the first line of her STORED reply — or that it
failed and the row's reason. Never the payload: that is data for her, not
words for his screen.

A turn that ended without HER answer (fix/ci-event-gaps T2) — a stop, a
failure, a note the backend wrote — carries a `no_answer` span (chat.
_file_no_answer) naming the reason in the backend's own words. That span, a
code fact, is the title's source then, for done and failed alike: the stored
reply is the backend's (it may open with "What this turn's tools returned…")
and its first line is never quoted as her conclusion. Read here only, so the
immediate _tell and the hourly run derive the same title.

Non-urgent: urgency is declared only by the stack family (tests/test_checks.py
pins it). An urgent event's notice is pushed by events.py itself, through
delivery.deliver with urgent set.
"""

from __future__ import annotations

import json
import uuid

from app.checks import Check, Finding

OUTCOMES = "event_outcomes"
# How long an outcome stays a live notice. Past it, reconcile clears the
# notice — it stays in the Inbox as cleared — and the digest stops owing it.
WINDOW_DAYS = 7
# Her conclusion is one line; a line longer than this is cut, and says so.
CONCLUSION_CHARS = 240

_SETTLED = ("done", "failed")

_SQL = """
SELECT id, sender, received_at, state, reason, turn_id, urgent
  FROM events
 WHERE state = ANY($1::text[])
   AND ({where})
 ORDER BY received_at, id
"""

# A group is in the window by its NEWEST event, so every row a turn read stays
# in its group however long the burst took to arrive — a group cut at the
# boundary would be different facts and raise a second notice.
_IN_WINDOW = (
    "COALESCE((SELECT max(g.received_at) FROM events g WHERE g.turn_id = events.turn_id),"
    " received_at) > now() - make_interval(days => $2)"
)


def conclusion(reply: str | None) -> str | None:
    """The first non-blank line of her reply, without a heading or quote mark,
    cut at CONCLUSION_CHARS; None when she stored nothing."""
    for line in (reply or "").splitlines():
        line = line.strip().lstrip("#>").strip()
        if line:
            if len(line) > CONCLUSION_CHARS:
                line = line[: CONCLUSION_CHARS - 1].rstrip() + "…"
            return line
    return None


def _clipped(words: str) -> str:
    """Stop words as one line, cut at CONCLUSION_CHARS like a conclusion."""
    line = " ".join(words.split())
    if len(line) > CONCLUSION_CHARS:
        line = line[: CONCLUSION_CHARS - 1].rstrip() + "…"
    return line


def finding_for(rows: list, reply: str | None, no_answer: str | None = None) -> Finding:
    """The notice one settled group of events deserves: the rows a turn read
    (or the one row no turn opened for), oldest first, her stored reply, and
    the turn's `no_answer` words when it ended without her answer."""
    first = rows[0]
    sender = first["sender"]
    turn_id = first["turn_id"]
    failed = [row for row in rows if row["state"] == "failed"]
    outcome = "failed" if failed else "done"
    what = f"An event from {sender}" if len(rows) == 1 else f"{len(rows)} events from {sender}"
    if no_answer:
        stop = _clipped(no_answer)
        title = (
            f"{what} failed: {stop}" if failed else f"{what}: she stopped before answering — {stop}"
        )
    elif failed:
        title = f"{what} failed: {failed[0]['reason'] or 'no reason was stated'}"
    else:
        line = conclusion(reply)
        title = f"{what}: {line}" if line else f"{what}: she looked into it but stored no reply"
    key = f"event_turn:{turn_id}" if turn_id is not None else f"event:{first['id']}"
    facts = {
        "sender": sender,
        "events": [str(row["id"]) for row in rows],
        "turn": str(turn_id) if turn_id is not None else None,
        "outcome": outcome,
    }
    return Finding(key=key, title=title, facts=facts)


async def _reply(pool, turn_id: uuid.UUID | None) -> str | None:
    if turn_id is None:
        return None
    return await pool.fetchval(
        "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant' "
        "ORDER BY created_at DESC LIMIT 1",
        turn_id,
    )


async def _no_answer(pool, turn_id: uuid.UUID | None) -> str | None:
    """The words of the turn's `no_answer` span (chat._file_no_answer), or
    None when it has none — she answered, or no turn ran."""
    if turn_id is None:
        return None
    meta = await pool.fetchval(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'no_answer' "
        "ORDER BY started_at DESC LIMIT 1",
        turn_id,
    )
    if isinstance(meta, str):
        meta = json.loads(meta)
    words = meta.get("words") if isinstance(meta, dict) else None
    return words if isinstance(words, str) and words.strip() else None


async def outcomes(pool, *, ids: list[uuid.UUID] | None = None) -> list[tuple[Finding, bool]]:
    """(finding, urgent) per settled group: the rows `ids` names, or every row
    received within WINDOW_DAYS. `urgent` is True when any event in the group
    is — the caller pushes on it; the finding itself is never urgent."""
    if ids is None:
        rows = await pool.fetch(
            _SQL.format(where=_IN_WINDOW),
            list(_SETTLED),
            WINDOW_DAYS,
        )
    else:
        rows = await pool.fetch(_SQL.format(where="id = ANY($2::uuid[])"), list(_SETTLED), ids)
    groups: dict[object, list] = {}
    for row in rows:
        groups.setdefault(row["turn_id"] or ("event", row["id"]), []).append(row)
    out: list[tuple[Finding, bool]] = []
    for group in groups.values():
        turn_id = group[0]["turn_id"]
        reply = await _reply(pool, turn_id)
        stop = await _no_answer(pool, turn_id)
        out.append((finding_for(group, reply, stop), any(row["urgent"] for row in group)))
    return out


async def settled(app, pool) -> list[Finding]:
    return [finding for finding, _urgent in await outcomes(pool)]


CHECKS: tuple[Check, ...] = (
    Check(
        name=OUTCOMES,
        describe=(
            "What Nova found when another program's event started a turn of hers: the "
            "sender, the event, her one-line conclusion, or that it failed and why."
        ),
        urgent=False,
        run=settled,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
