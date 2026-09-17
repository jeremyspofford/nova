"""The beat's skills check: a procedure she has walked more than once.

It writes NOTHING. app/checks says a check is code that reads rows and returns
findings, and that contract is why a finding is safe to wake someone with —
so this one reports the repetition and the draft is composed later, from the
facts it recorded, when the owner asks for it.
"""

from __future__ import annotations

import uuid

from app import skills
from app.checks import skills as check
from tests.conftest import requires_db

pytestmark = requires_db


async def _owner(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )


async def _walk(pool, person, names, *, days_ago: float = 1.0, kind: str = "chat") -> uuid.UUID:
    """A turn that called those tools, in that order."""
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    turn = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model, person_id, started_at) "
        "VALUES ($1, $2, 'qwen3:8b', $3, now() - make_interval(days => $4)) RETURNING id",
        kind,
        conversation,
        person,
        days_ago,
    )
    for i, name in enumerate(names):
        await pool.execute(
            "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms) "
            "VALUES ($1, 'tool', $2, now() - make_interval(days => $3) + "
            "make_interval(secs => $4), 5)",
            turn,
            name,
            days_ago,
            float(i),
        )
    return turn


SEQUENCE = ["workspace_list_files", "workspace_read_file", "workspace_delete"]


async def test_a_sequence_walked_twice_is_reported_once(pool):
    person = await _owner(pool)
    await _walk(pool, person, SEQUENCE)
    await _walk(pool, person, SEQUENCE)

    findings = await check.repeated_procedure(None, pool)

    assert len(findings) == 1
    assert findings[0].facts == {"steps": SEQUENCE}
    assert "3 turns" not in findings[0].title
    assert "2 turns" in findings[0].title


async def test_a_sequence_walked_once_is_not_a_procedure(pool):
    person = await _owner(pool)
    await _walk(pool, person, SEQUENCE)
    assert await check.repeated_procedure(None, pool) == []


async def test_runs_of_the_same_call_collapse_so_a_repeat_is_recognisable(pool):
    """Deleting four files is read, read, read, delete, delete, delete. The
    next time it is three files. The PROCEDURE is the same and an exact-match
    grouping would never see it twice."""
    person = await _owner(pool)
    await _walk(
        pool, person, ["workspace_list_files", "workspace_read_file"] + ["workspace_delete"] * 3
    )
    await _walk(
        pool,
        person,
        ["workspace_list_files"] + ["workspace_read_file"] * 2 + ["workspace_delete"] * 2,
    )

    findings = await check.repeated_procedure(None, pool)
    assert [f.facts["steps"] for f in findings] == [SEQUENCE]


async def test_a_short_sequence_is_not_a_procedure(pool):
    person = await _owner(pool)
    for _ in range(2):
        await _walk(pool, person, ["get_time", "get_time"])
    assert await check.repeated_procedure(None, pool) == []


async def test_turns_outside_the_window_do_not_count(pool):
    person = await _owner(pool)
    await _walk(pool, person, SEQUENCE, days_ago=1)
    await _walk(pool, person, SEQUENCE, days_ago=check.WINDOW_DAYS + 1)
    assert await check.repeated_procedure(None, pool) == []


async def test_a_turn_that_already_read_a_skill_is_not_evidence_of_a_gap(pool):
    person = await _owner(pool)
    await _walk(pool, person, SEQUENCE)
    await _walk(pool, person, [skills.LOAD_TOOL, *SEQUENCE])
    assert await check.repeated_procedure(None, pool) == []


async def test_a_sequence_a_skill_already_covers_is_not_reported(pool, tmp_path):
    person = await _owner(pool)
    await _walk(pool, person, SEQUENCE)
    await _walk(pool, person, SEQUENCE)
    await skills.create(
        pool,
        name="tidy",
        title="t",
        summary="u",
        created_via="page",
        body="b",
        step_names=SEQUENCE,
        root=tmp_path,
    )
    assert await check.repeated_procedure(None, pool) == []


async def test_the_turns_behind_a_sequence_are_read_fresh_not_stored(pool):
    """The finding carries the STEPS and not the turn ids: a fingerprint over
    the ids would re-raise the same news every time it happened again. The
    draft resolves the turns itself, so it is composed from everything that
    has happened by then, not from what was true when the beat ran."""
    person = await _owner(pool)
    first = await _walk(pool, person, SEQUENCE)
    second = await _walk(pool, person, SEQUENCE)

    assert await check.turns_matching(pool, SEQUENCE) == [first, second]
