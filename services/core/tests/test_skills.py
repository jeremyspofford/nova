"""app/skills.py — the row around the file, and where a skill's words come from.

Every assertion works against rows and files this suite writes itself. The
shape under test is not "can we store a procedure": it is that a skill can
only ever say what the record says. Its steps are read from turn_spans, its
summary is quoted from the owner's own message rows, and a row whose file is
missing refuses by name instead of resolving to an empty procedure.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import pytest

from app import skills
from tests.conftest import requires_db

pytestmark = requires_db


async def _person(pool) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('someone', 'adult') RETURNING id"
    )


async def _conversation(pool, person) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )


async def _turn(pool, conversation, *, offset_secs: float = 0.0) -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model, started_at) "
        "VALUES ('chat', $1, 'qwen3:8b', now() + make_interval(secs => $2)) RETURNING id",
        conversation,
        offset_secs,
    )


async def _span(pool, turn_id, kind, name, *, offset_secs: float = 0.0, meta=None) -> None:
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name, started_at, duration_ms, meta) "
        "VALUES ($1, $2, $3, now() + make_interval(secs => $4), 5, $5)",
        turn_id,
        kind,
        name,
        offset_secs,
        meta or {},
    )


async def _message(pool, conversation, turn_id, role, content) -> None:
    await pool.execute(
        "INSERT INTO messages (conversation_id, turn_id, role, content) VALUES ($1, $2, $3, $4)",
        conversation,
        turn_id,
        role,
        content,
    )


# ── the file and the row ───────────────────────────────────────────────────


async def test_create_writes_the_file_and_reads_back(pool, tmp_path):
    made = await skills.create(
        pool,
        name="clear-the-workspace",
        title="Clear superseded workspace notes",
        summary="asked as: 'delete the kv duplicates'",
        created_via="page",
        body="Read each file first.\n",
        root=tmp_path,
    )
    assert made.status == skills.DRAFT

    read = await skills.get(pool, "clear-the-workspace")
    assert read is not None
    assert read.title == "Clear superseded workspace notes"
    assert skills.body_text("clear-the-workspace", tmp_path) == "Read each file first.\n"


async def test_a_name_that_cannot_become_a_path_is_refused(pool, tmp_path):
    with pytest.raises(ValueError) as exc:
        await skills.create(
            pool,
            name="../escape",
            title="t",
            summary="s",
            created_via="page",
            body="b",
            root=tmp_path,
        )
    assert "../escape" in str(exc.value)
    assert await skills.get(pool, "../escape") is None


async def test_a_missing_file_refuses_by_name_rather_than_reading_as_empty(pool, tmp_path):
    await skills.create(
        pool,
        name="gone",
        title="t",
        summary="s",
        created_via="page",
        body="something",
        root=tmp_path,
    )
    await skills.set_status(pool, "gone", skills.ACTIVE)
    skills.body_path("gone", tmp_path).unlink()

    with pytest.raises(skills.SkillUnavailable) as exc:
        await skills.load(pool, "gone", root=tmp_path)
    assert "gone" in str(exc.value)
    assert "file" in str(exc.value)


@pytest.mark.parametrize("status", [skills.DRAFT, skills.FLAGGED, skills.RETIRED])
async def test_load_refuses_anything_not_active_and_says_which(pool, tmp_path, status):
    await skills.create(
        pool, name="s", title="t", summary="u", created_via="page", body="body", root=tmp_path
    )
    # Flagging demands a reason, so the parametrised move supplies one; the
    # other two statuses carry none by construction.
    await skills.set_status(pool, "s", status, reason="the ledger said so")
    with pytest.raises(skills.SkillUnavailable) as exc:
        await skills.load(pool, "s", root=tmp_path)
    assert status in str(exc.value)


async def test_load_returns_the_body_when_active(pool, tmp_path):
    await skills.create(
        pool, name="s", title="t", summary="u", created_via="page", body="the steps", root=tmp_path
    )
    await skills.set_status(pool, "s", skills.ACTIVE)
    skill, body = await skills.load(pool, "s", root=tmp_path)
    assert skill.name == "s"
    assert body == "the steps"


async def test_flagging_records_its_reason_in_words(pool, tmp_path):
    await skills.create(
        pool, name="s", title="t", summary="u", created_via="page", body="b", root=tmp_path
    )
    await skills.set_status(pool, "s", skills.FLAGGED, reason="3 of the last 5 uses failed a call")
    read = await skills.get(pool, "s")
    assert read.status == skills.FLAGGED
    assert "3 of the last 5" in read.flagged_reason


# ── the roster ─────────────────────────────────────────────────────────────


async def test_roster_is_none_when_nothing_is_active(pool, tmp_path):
    await skills.create(
        pool, name="s", title="t", summary="u", created_via="page", body="b", root=tmp_path
    )
    # A draft exists, and the prompt must be byte-identical to a stack with no
    # skills at all: a draft is not a procedure she has been given.
    assert await skills.roster_line(pool) is None


async def test_roster_names_active_skills_with_their_summaries(pool, tmp_path):
    for name in ("alpha", "beta"):
        await skills.create(
            pool,
            name=name,
            title=f"title {name}",
            summary=f"asked as: '{name} thing'",
            created_via="page",
            body="b",
            root=tmp_path,
        )
    await skills.set_status(pool, "alpha", skills.ACTIVE)
    await skills.set_status(pool, "beta", skills.RETIRED)

    line = await skills.roster_line(pool)
    assert "alpha" in line
    assert "asked as: 'alpha thing'" in line
    assert "beta" not in line
    assert skills.LOAD_TOOL in line


# ── where the words come from ──────────────────────────────────────────────


async def test_steps_are_read_from_the_spans_in_order(pool):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    first = await _turn(pool, conversation, offset_secs=-60)
    await _span(pool, first, "llm_call", None, offset_secs=-60)
    await _span(pool, first, "tool", "workspace_list_files", offset_secs=-59)
    await _span(pool, first, "guard", "narration", offset_secs=-58)
    await _span(pool, first, "tool", "workspace_read_file", offset_secs=-57)

    assert await skills.steps_from_turns(pool, [first]) == [
        "workspace_list_files",
        "workspace_read_file",
    ]


async def test_a_draft_says_what_the_record_says_and_nothing_else(pool, tmp_path):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn = await _turn(pool, conversation, offset_secs=-60)
    await _message(pool, conversation, turn, "user", "clear out the superseded kv notes")
    await _message(pool, conversation, turn, "assistant", "I merged them and deleted three.")
    await _span(pool, turn, "tool", "workspace_list_files", offset_secs=-59)
    await _span(pool, turn, "tool", "workspace_read_file", offset_secs=-58)
    await _span(pool, turn, "tool", "workspace_delete", offset_secs=-57)

    draft = await skills.draft_from_turns(
        pool, name="clear-superseded", turn_ids=[turn], created_via="beat", root=tmp_path
    )

    assert draft.status == skills.DRAFT
    assert draft.created_via == "beat"
    assert draft.step_names == (
        "workspace_list_files",
        "workspace_read_file",
        "workspace_delete",
    )
    assert list(draft.source_turn_ids) == [turn]
    # The summary is HIS sentence, quoted — never her restatement of it, which
    # is a model's words about a model's words.
    assert "clear out the superseded kv notes" in draft.summary
    assert "I merged them" not in draft.summary

    body = skills.body_text("clear-superseded", tmp_path)
    for step in draft.step_names:
        assert step in body
    assert "clear out the superseded kv notes" in body


async def test_a_draft_with_no_tool_spans_is_refused(pool, tmp_path):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn = await _turn(pool, conversation)
    await _message(pool, conversation, turn, "user", "just chatting")

    with pytest.raises(ValueError) as exc:
        await skills.draft_from_turns(
            pool, name="nothing", turn_ids=[turn], created_via="beat", root=tmp_path
        )
    assert "no tool" in str(exc.value)
    assert await skills.get(pool, "nothing") is None


# ── the bridge to agents ───────────────────────────────────────────────────


async def test_only_a_skill_with_a_row_that_is_not_active_counts_as_withdrawn(pool, tmp_path):
    await skills.create(
        pool, name="live", title="t", summary="u", created_via="page", body="b", root=tmp_path
    )
    await skills.set_status(pool, "live", skills.ACTIVE)
    await skills.create(
        pool, name="pulled", title="t", summary="u", created_via="page", body="b", root=tmp_path
    )
    await skills.set_status(pool, "pulled", skills.RETIRED)

    # 'by-hand' has no row at all: a file an agent names is what agents have
    # always had, and S17 does not take it away.
    assert await skills.withdrawn_statuses(pool, ["live", "pulled", "by-hand"]) == {
        "pulled": skills.RETIRED
    }


# ── the ledger ─────────────────────────────────────────────────────────────


async def _use(pool, skill, turn_id, *, failed=0, fires=0, known=True) -> None:
    await pool.execute(
        "INSERT INTO skill_uses (skill_id, turn_id, failed_calls, guard_fires, outcome_known) "
        "VALUES ($1, $2, $3, $4, $5)",
        skill.id,
        turn_id,
        failed,
        fires,
        known,
    )


async def test_a_use_is_recorded_for_a_successful_load_and_only_that(pool, tmp_path):
    from app import traces

    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn_id = await _turn(pool, conversation)
    await skills.create(
        pool, name="tidy", title="t", summary="u", created_via="page", body="b", root=tmp_path
    )
    await skills.set_status(pool, "tidy", skills.ACTIVE)
    now = datetime.now(UTC)
    spans = [
        traces.Span(
            "tool", skills.LOAD_TOOL, now, 5, {"ok": True, "args_redacted": {"name": "tidy"}}
        ),
        # A load that was REFUSED handed her no procedure, so it is not a use
        # of one: counting it would let a skill be flagged for turns in which
        # it was never read.
        traces.Span(
            "tool", skills.LOAD_TOOL, now, 5, {"ok": False, "args_redacted": {"name": "gone"}}
        ),
        traces.Span("tool", "workspace_read_file", now, 5, {"ok": False}),
        traces.Span("guard", "narration", now, 1, {}),
    ]

    written = await skills.record_uses(pool, turn_id, spans, status="ok")

    assert written == ["tidy"]
    row = await pool.fetchrow("SELECT * FROM skill_uses")
    assert row["failed_calls"] == 1
    assert row["guard_fires"] == 1
    assert row["outcome_known"] is True


@pytest.mark.parametrize("status", ["error", "stopped"])
async def test_a_turn_that_did_not_finish_records_a_use_whose_outcome_is_unknown(
    pool, tmp_path, status
):
    from app import traces

    person = await _person(pool)
    conversation = await _conversation(pool, person)
    turn_id = await _turn(pool, conversation)
    await skills.create(
        pool, name="tidy", title="t", summary="u", created_via="page", body="b", root=tmp_path
    )
    await skills.set_status(pool, "tidy", skills.ACTIVE)
    spans = [
        traces.Span(
            "tool",
            skills.LOAD_TOOL,
            datetime.now(UTC),
            5,
            {"ok": True, "args_redacted": {"name": "tidy"}},
        )
    ]

    await skills.record_uses(pool, turn_id, spans, status=status)

    # The use is on record — it happened — but "it went badly" is a claim
    # about a turn nobody watched finish, and the flag query filters it out.
    assert await pool.fetchval("SELECT outcome_known FROM skill_uses") is False


async def test_three_rough_uses_in_five_flags_the_skill_with_its_reason(pool, tmp_path):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    await skills.create(
        pool, name="tidy", title="t", summary="u", created_via="page", body="b", root=tmp_path
    )
    skill = await skills.set_status(pool, "tidy", skills.ACTIVE)

    for failed in (1, 0, 1, 0):
        await _use(pool, skill, await _turn(pool, conversation), failed=failed)
    assert await skills.review_flagging(pool, skill.id) is None
    assert (await skills.get(pool, "tidy")).status == skills.ACTIVE

    await _use(pool, skill, await _turn(pool, conversation), fires=1)
    flagged = await skills.review_flagging(pool, skill.id)

    assert flagged.status == skills.FLAGGED
    assert "3 of the last 5" in flagged.flagged_reason


async def test_uses_nobody_watched_finish_cannot_flag_a_skill(pool, tmp_path):
    person = await _person(pool)
    conversation = await _conversation(pool, person)
    await skills.create(
        pool, name="tidy", title="t", summary="u", created_via="page", body="b", root=tmp_path
    )
    skill = await skills.set_status(pool, "tidy", skills.ACTIVE)
    for _ in range(5):
        await _use(pool, skill, await _turn(pool, conversation), failed=1, known=False)

    assert await skills.review_flagging(pool, skill.id) is None
    assert (await skills.get(pool, "tidy")).status == skills.ACTIVE
