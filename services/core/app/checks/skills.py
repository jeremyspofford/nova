"""The procedure she has walked more than once, and nobody has written down.

This is the "learning" half of S17, and it is deliberately the dullest code in
the slice: it reads tool spans, collapses each turn into the shape of what was
done, and reports a shape that happened twice. No model is asked anything.

WHY A SHAPE AND NOT THE EXACT SEQUENCE. Clearing four superseded notes is
list, read, read, read, delete, delete, delete; the next time it is three
notes. It is the same procedure, and grouping on the exact call list would
never see it twice. So a run of the same call collapses to one step, and what
is compared is the order of distinct calls.

WHY THE FINDING CARRIES THE STEPS AND NOT THE TURNS. `facts` is what the
fingerprint hashes (app/checks/__init__.py), so putting the turn ids in it
would make the same repetition new news every time it happened again — the v3
noise failure in a new costume. The steps ARE the condition. The turns behind
them are read fresh by `turns_matching` when a draft is actually composed, so
the draft is made from everything that has happened by then rather than from
what was true the hour the beat ran.

AND IT WRITES NOTHING. A check is code that reads rows and returns findings;
that contract is why a finding is safe to wake someone with. The draft is
composed by app/skills.py when the owner asks for it from the Inbox.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from app import skills as skills_store
from app.checks import Check, Finding

# How far back a repetition still counts as this household's current habit.
WINDOW_DAYS = 14

# Shorter than this is not a procedure. Two calls is "she looked something up
# and answered"; three is the smallest thing worth writing down.
MIN_STEPS = 3

# How many turns must have walked it. Two — the owner's own words for this
# slice were "teach a task twice".
MIN_TURNS = 2


def shape(names: Sequence[str]) -> list[str]:
    """The procedure inside a call list: consecutive repeats collapsed."""
    out: list[str] = []
    for name in names:
        if not out or out[-1] != name:
            out.append(name)
    return out


async def _sequences(pool) -> dict[tuple[str, ...], list[uuid.UUID]]:
    """Every owner chat turn in the window, as the shape it walked.

    Turns that READ a skill are dropped whole: they are evidence that the
    procedure is already written down, not evidence of a gap. Agent, eval and
    beat turns are out by kind — an eval replaying a fixture would otherwise
    manufacture a repetition out of the same case run twice.
    """
    rows = await pool.fetch(
        "SELECT s.turn_id, s.name FROM turn_spans s "
        "JOIN turns t ON t.id = s.turn_id "
        "JOIN people p ON p.id = t.person_id "
        "WHERE s.kind = 'tool' AND s.name IS NOT NULL AND t.kind = 'chat' "
        "AND p.role = 'owner' AND t.started_at > now() - make_interval(days => $1) "
        "ORDER BY s.turn_id, s.started_at, s.id",
        WINDOW_DAYS,
    )
    per_turn: dict[uuid.UUID, list[str]] = {}
    for row in rows:
        per_turn.setdefault(row["turn_id"], []).append(row["name"])

    grouped: dict[tuple[str, ...], list[uuid.UUID]] = {}
    for turn_id, names in per_turn.items():
        if skills_store.LOAD_TOOL in names:
            continue
        key = tuple(shape(names))
        if len(key) < MIN_STEPS:
            continue
        grouped.setdefault(key, []).append(turn_id)
    return grouped


async def turns_matching(pool, steps: Sequence[str]) -> list[uuid.UUID]:
    """The turns whose shape is exactly these steps, oldest first — read when
    a draft is composed, never stored on the finding."""
    grouped = await _sequences(pool)
    found = grouped.get(tuple(steps), [])
    ordered = await pool.fetch(
        "SELECT id FROM turns WHERE id = ANY($1::uuid[]) ORDER BY started_at, id",
        list(found),
    )
    return [row["id"] for row in ordered]


async def repeated_procedure(app, pool) -> list[Finding]:
    grouped = await _sequences(pool)
    if not grouped:
        return []
    covered = {tuple(shape(skill.step_names)) for skill in await skills_store.list_all(pool)}
    findings: list[Finding] = []
    for steps, turn_ids in sorted(grouped.items()):
        if len(turn_ids) < MIN_TURNS or steps in covered:
            continue
        findings.append(
            Finding(
                key="repeated_procedure:" + ">".join(steps),
                title=(
                    f"{', '.join(steps)} — walked in {len(turn_ids)} turns in the last "
                    f"{WINDOW_DAYS} days, with nothing written down for it"
                ),
                facts={"steps": list(steps)},
            )
        )
    return findings


CHECKS: tuple[Check, ...] = (
    Check(
        name="skills_repeated_procedure",
        describe=(
            f"Tool sequences of {MIN_STEPS}+ steps walked in {MIN_TURNS}+ chat turns in the "
            f"last {WINDOW_DAYS} days that no skill covers."
        ),
        urgent=False,
        run=repeated_procedure,
    ),
)

NAMES: tuple[str, ...] = tuple(check.name for check in CHECKS)
