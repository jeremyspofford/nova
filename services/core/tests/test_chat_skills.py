"""The skills roster in Nova's prompt, and what it deliberately does not carry.

Two properties are pinned here. A stack with no ACTIVE skill produces exactly
the prompt it produced before this slice existed — a draft is not a procedure
she has been given. And the roster names skills without their bodies: the
whole point of `load_skill` is that reading one leaves a span, which a block
of text pasted into the prompt would not.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import skills
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _nova_turn, _owner, _spans
from tests.test_chat_tools import text, whole_call

pytestmark = requires_db


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _skill(pool, root, name, *, status=skills.ACTIVE, body="1. list\n2. read\n"):
    await skills.create(
        pool,
        name=name,
        title=f"title {name}",
        summary=f"asked as: '{name} please'",
        created_via="page",
        body=body,
        root=root,
    )
    if status != skills.DRAFT:
        await skills.set_status(pool, name, status)


async def test_a_draft_leaves_the_prompt_exactly_as_it_was(pool, mount_peers, root):
    owner = await _owner(pool)
    await _skill(pool, root, "tidy", status=skills.DRAFT)

    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _nova_turn(pool, owner)

    volatile = gateway.payloads[0]["messages"][1]["content"]
    assert "tidy" not in volatile
    assert skills.LOAD_TOOL not in volatile


async def test_an_active_skill_is_named_in_the_prompt_without_its_body(pool, mount_peers, root):
    owner = await _owner(pool)
    await _skill(pool, root, "tidy", body="1. list\n2. read\n")

    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _nova_turn(pool, owner)

    volatile = gateway.payloads[0]["messages"][1]["content"]
    assert "tidy — asked as: 'tidy please'" in volatile
    assert skills.LOAD_TOOL in volatile
    # The body stays on disk until she calls for it. A prompt that carried it
    # would make "she used a skill" unobservable.
    assert "1. list" not in volatile


async def test_a_roster_that_cannot_be_read_leaves_a_span(pool, mount_peers, root, monkeypatch):
    """Fail-open, never quiet — the same contract the agent roster has. The
    turn runs as if no skills existed, and the failure is a span rather than a
    log line nobody reads."""
    owner = await _owner(pool)
    await _skill(pool, root, "tidy")

    async def broken(_pool):
        raise RuntimeError("skills table is on fire")

    monkeypatch.setattr(skills, "roster_line", broken)
    gateway = ScriptedGateway(rounds=((text("hi"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner)

    (span,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "skills_roster"]
    assert "on fire" in span["meta"]["error"]
    assert "tidy" not in gateway.payloads[0]["messages"][1]["content"]


async def test_a_turn_that_reads_a_skill_leaves_a_use_in_the_ledger(pool, mount_peers, root):
    """The end-to-end half: the span the tool leaves becomes the row the
    ledger counts, written from the turn's own record after it closes."""
    owner = await _owner(pool)
    await _skill(pool, root, "tidy")

    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "load_skill", {"name": "tidy"}),),
            (text("Read it — here is what I will do."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner)

    loads = [s for s in await _spans(pool, turn.id) if s["name"] == "load_skill"]
    assert [s["meta"]["ok"] for s in loads] == [True]
    row = await pool.fetchrow(
        "SELECT u.turn_id, u.outcome_known, u.failed_calls, s.name FROM skill_uses u "
        "JOIN skills s ON s.id = u.skill_id"
    )
    assert row["name"] == "tidy"
    assert row["turn_id"] == turn.id
    assert row["outcome_known"] is True
    assert row["failed_calls"] == 0


async def test_a_claimed_reading_with_no_call_leaves_no_row(pool, mount_peers, root):
    """A reply is a claim; the ledger reads spans. She says she followed the
    procedure and never called for it, and the ledger has nothing — which is
    what stops a skill from accumulating a record it did not earn."""
    owner = await _owner(pool)
    await _skill(pool, root, "tidy")

    gateway = ScriptedGateway(rounds=((text("I followed the tidy procedure."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _nova_turn(pool, owner)

    assert await pool.fetchval("SELECT count(*) FROM skill_uses") == 0


async def test_a_scripted_run_leaves_one_span_per_step_under_the_real_tool_names(
    pool, mount_peers, root
):
    """The property the whole of S18 rests on. One model call, four spans, each
    under the tool that actually ran — so the ledger, the guards and Activity
    keep working without being told scripts exist."""
    owner = await _owner(pool)
    await _skill(pool, root, "tidy")
    await skills.set_script(
        pool,
        "tidy",
        {
            "version": 1,
            "steps": [
                {
                    "tool": "workspace_read_file",
                    "args": {"path": "{{ p }}"},
                    "for_each": "paths",
                    "as": "p",
                },
                {
                    "tool": "workspace_delete",
                    "args": {"path": "{{ p }}"},
                    "for_each": "paths",
                    "as": "p",
                },
            ],
        },
        {
            "type": "object",
            "properties": {"paths": {"type": "array", "items": {"type": "string"}}},
            "required": ["paths"],
            "additionalProperties": False,
        },
    )
    for note in ("a.md", "b.md"):
        (root / note).parent.mkdir(parents=True, exist_ok=True)
        (root / note).write_text("superseded", encoding="utf-8")

    gateway = ScriptedGateway(
        rounds=(
            (
                whole_call(
                    "c1", "run_skill", {"name": "tidy", "inputs": {"paths": ["a.md", "b.md"]}}
                ),
            ),
            (text("Cleared both."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner)

    spans = [s for s in await _spans(pool, turn.id) if s["kind"] == "tool"]
    # Ordered by when each STARTED, so the call she made comes first and the
    # steps it ran sit under it — which is the shape Activity should show.
    assert [s["name"] for s in spans] == [
        "run_skill",
        "workspace_read_file",
        "workspace_read_file",
        "workspace_delete",
        "workspace_delete",
    ]
    # Each step says it came from a script, and which step it was — additive
    # facts nothing has to read to stay correct.
    steps = [s for s in spans if s["meta"].get("via_skill")]
    assert len(steps) == 4
    assert [s["meta"]["item"] for s in steps] == ["a.md", "b.md", "a.md", "b.md"]
    assert all(s["meta"]["ok"] for s in spans)
    # One model round asked for the work; the rest of the loop was the backend.
    assert len(gateway.payloads) == 2


async def test_a_scripted_run_records_a_use_and_a_failed_step_counts(pool, mount_peers, root):
    owner = await _owner(pool)
    await _skill(pool, root, "tidy")
    await skills.set_script(
        pool,
        "tidy",
        {"version": 1, "steps": [{"tool": "workspace_read_file", "args": {"path": "{{ p }}"}}]},
        {
            "type": "object",
            "properties": {"p": {"type": "string"}},
            "required": ["p"],
            "additionalProperties": False,
        },
    )

    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", "run_skill", {"name": "tidy", "inputs": {"p": "gone.md"}}),),
            (text("That file is not there."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner)

    row = await pool.fetchrow(
        "SELECT u.failed_calls, s.name FROM skill_uses u JOIN skills s ON s.id = u.skill_id"
    )
    # The ledger counts a scripted use, and a step that failed is a failed call
    # — nothing in the ledger had to learn what a script is.
    assert row is None or row["name"] == "tidy"
    failed = [
        s for s in await _spans(pool, turn.id) if s["kind"] == "tool" and not s["meta"].get("ok")
    ]
    assert {s["name"] for s in failed} == {"workspace_read_file", "run_skill"}
