"""Delegated agent work in an executions rewind (chat-rewind epic, T9).

A delegate_to_agent call runs the agent's whole turn inside Nova's turn, but
that child turn is opened in the AGENT's log conversation (turns has no
parent-turn column), so rewinds.rewind's claim -- turn_actions of THIS
conversation from the target on -- never sees what the agent did. These pin:

  * the delegate call's turn_actions row carries a durable link to the child
    turn (undo = {"agent_turn_id": <child turn id>}, the tracker's preferred
    mechanism: no migration, delegate_to_agent keeps revert None), recorded
    right after the child turn opens -- so a child that failed, or a funnel
    that raised, is still linked -- and a delegation refused before any
    child turn opened links nothing;
  * an executions rewind claims and reverts the linked child turn's actions
    by the hallway's own rules, newest-first IN THE DELEGATE CALL'S PLACE;
  * an unclosed child turn is named "not recorded"; the delegate row itself
    is never claimed undone;
  * chat mode, an earlier rewind's claim, and another conversation's
    delegation are never touched;
  * the marker and the stored rewinds row name the child's entries.
"""

from __future__ import annotations

import dataclasses
import json
import uuid

import pytest

from app import agents, chat, conversations, rewinds, tools, traces
from app.main import app
from app.tools import agents as agent_tools
from tests import test_chat_rewind
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway
from tests.test_chat_agents import _calls, _create, _nova_turn
from tests.test_chat_agents import _owner as _agent_owner
from tests.test_chat_rewind import (
    _action,
    _at,
    _conversation,
    _json,
    _msg,
    _owner,
    _turn,
)
from tests.test_chat_tools import text, whole_call

pytestmark = requires_db

DELEGATE = "delegate_to_agent"

# T4's fake changing tools, whose reverts record each call in order.
reverts = test_chat_rewind.reverts


@pytest.fixture
def root(monkeypatch, tmp_path):
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


@pytest.fixture(autouse=True)
def _clean_doing():
    traces.DOING.clear()
    yield
    traces.DOING.clear()


def _link(undo) -> str | None:
    """The child turn id a delegate row's undo payload links, or None."""
    payload = _json(undo)
    if isinstance(payload, dict):
        value = payload.get("agent_turn_id")
        return None if value is None else str(value)
    return None


async def _delegate_rows(pool, turn_id) -> list:
    return await pool.fetch(
        "SELECT id, ok, undo, seq FROM turn_actions WHERE turn_id = $1 AND tool = $2 ORDER BY seq",
        turn_id,
        DELEGATE,
    )


async def _children(pool) -> list:
    return await pool.fetch(
        "SELECT id, status, conversation_id FROM turns WHERE kind = 'agent' ORDER BY started_at"
    )


async def _target(pool, owner, content: str) -> tuple[uuid.UUID, uuid.UUID]:
    """The owner's message in his active conversation, stamped before the
    turn _nova_turn then opens (as _open_turn inserts it)."""
    conversation = await conversations.active_conversation(pool, owner)
    cid = conversation["id"]
    mid = await pool.fetchval(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2) "
        "RETURNING id",
        cid,
        content,
    )
    return cid, mid


# -- criterion 1: the delegate row links its child turn --------------------------


async def test_a_delegation_links_its_delegate_action_to_the_child_turn(pool, mount_peers, root):
    owner = await _agent_owner(pool)
    await _create(pool, mount_peers, tools=("workspace_write_file",))
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("n1", DELEGATE, {"agent": "coder", "task": "write a haiku"}),),
            (whole_call("c1", "workspace_write_file", {"path": "haiku.md", "content": "a\n"}),),
            (text("Wrote haiku.md."),),
            (text("coder wrote it."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _nova_turn(pool, owner, "ask coder to write a haiku")
    await chat.drain_background()

    (child,) = await _children(pool)
    assert child["status"] == "ok"
    (row,) = await _delegate_rows(pool, turn.id)
    assert row["ok"] is True
    # Read after close_turn wrote the ledger: the link is durable.
    assert _link(row["undo"]) == str(child["id"])


async def test_a_child_that_failed_is_still_linked(pool, mount_peers, root):
    owner = await _agent_owner(pool)
    await _create(pool, mount_peers)
    refusal = Refusal(503, {"error": {"message": "no backend can serve agent_coder"}})
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("n1", DELEGATE, {"agent": "coder", "task": "do it"}),),
            refusal,
            (text("coder hit an error."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _nova_turn(pool, owner, "ask coder to do it")
    await chat.drain_background()

    (child,) = await _children(pool)
    assert child["status"] == "error"
    (row,) = await _delegate_rows(pool, turn.id)
    assert row["ok"] is False
    assert _link(row["undo"]) == str(child["id"])


async def test_the_link_is_recorded_before_the_child_runs(pool, mount_peers, root, monkeypatch):
    """The child may write files and then fail, or the funnel may raise: the
    link must already be on the sink when _run_turn is entered."""
    owner = await _agent_owner(pool)
    await _create(pool, mount_peers)
    mount_peers(memory=FakeMemory())
    ctx = tools.context_for(app, owner, facts_sink=[], undo_sink=[])
    seen_at_entry: list = []

    async def _exploding_run_turn(*args, **kwargs):
        seen_at_entry.append(list(ctx.undo_sink))
        raise RuntimeError("the funnel fell over")

    monkeypatch.setattr(chat, "_run_turn", _exploding_run_turn)

    _, ok = await tools.dispatch(DELEGATE, {"agent": "coder", "task": "do it"}, ctx)

    assert ok is False
    (child,) = await _children(pool)
    assert len(seen_at_entry) == 1
    assert [_link(e) for e in seen_at_entry[0]] == [str(child["id"])]
    assert [_link(e) for e in ctx.undo_sink] == [str(child["id"])]


async def test_a_delegation_refused_before_the_child_opens_links_nothing(pool, mount_peers, root):
    """Unknown agent and empty task in one round, then a real delegation: the
    refused rows carry no link, the real one does. An agent reaching for
    delegation (executor-level refusal) adds nothing to the sink."""
    owner = await _agent_owner(pool)
    coder = await _create(pool, mount_peers, tools=("workspace_write_file",))
    gateway = ScriptedGateway(
        rounds=(
            (
                _calls(
                    ("n0", DELEGATE, {"agent": "nobody", "task": "x"}),
                    ("n1", DELEGATE, {"agent": "coder", "task": "   "}),
                    ("n2", DELEGATE, {"agent": "coder", "task": "say done"}),
                ),
            ),
            (text("done"),),
            (text("coder said done."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _nova_turn(pool, owner, "ask coder")
    await chat.drain_background()

    (child,) = await _children(pool)
    rows = await _delegate_rows(pool, turn.id)
    assert [(r["ok"], _link(r["undo"])) for r in rows] == [
        (False, None),
        (False, None),
        (True, str(child["id"])),
    ]

    as_agent = dataclasses.replace(
        tools.context_for(app, owner, facts_sink=[], undo_sink=[]), person=coder.person()
    )
    result, ok = await tools.dispatch(DELEGATE, {"agent": "coder", "task": "x"}, as_agent)
    assert ok is False and agent_tools.AGENT_CANNOT_DELEGATE in result
    assert as_agent.undo_sink == []
    assert len(await _children(pool)) == 1


# -- criterion 2 end to end: a child's workspace write is put back ----------------


async def test_an_executions_rewind_puts_back_the_agents_workspace_write(pool, mount_peers, root):
    owner = await _agent_owner(pool)
    await _create(pool, mount_peers, tools=("workspace_write_file",))
    cid, target = await _target(pool, owner, "ask coder to write a haiku")
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("n1", DELEGATE, {"agent": "coder", "task": "write a haiku"}),),
            (whole_call("c1", "workspace_write_file", {"path": "haiku.md", "content": "a\n"}),),
            (text("Wrote haiku.md."),),
            (text("coder wrote it."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn, _ = await _nova_turn(pool, owner, "ask coder to write a haiku")
    await chat.drain_background()
    written = root / "agents" / "coder" / "haiku.md"
    assert written.read_text(encoding="utf-8") == "a\n"
    (child,) = await _children(pool)
    (child_action,) = await pool.fetch(
        "SELECT id, conversation_id FROM turn_actions WHERE turn_id = $1", child["id"]
    )
    assert child_action["conversation_id"] != cid  # the agent's log conversation

    result = await rewinds.rewind(pool, app, owner, cid, target, "executions")

    assert not written.exists(), "the agent's write was not put back"
    undone = {u["action_id"]: u for u in result["undone"]}
    assert str(child_action["id"]) in undone
    assert undone[str(child_action["id"])]["tool"] == "workspace_write_file"
    (delegate_row,) = await _delegate_rows(pool, turn.id)
    assert str(delegate_row["id"]) not in undone
    assert [n["tool"] for n in result["not_undone"]] == [DELEGATE]
    stored = await pool.fetchrow(
        "SELECT reverted_by, revert_ok FROM turn_actions WHERE id = $1", child_action["id"]
    )
    assert stored["reverted_by"] == result["rewind_id"] and stored["revert_ok"] is True


# -- synthetic world: the link as the delegate row's undo payload ----------------


async def _child_turn(pool, at: float, status: str | None = "ok") -> tuple[uuid.UUID, uuid.UUID]:
    """An agent turn in its own (log) conversation."""
    log = await pool.fetchval(
        "INSERT INTO conversations (person_id) SELECT id FROM people ORDER BY created_at LIMIT 1 "
        "RETURNING id"
    )
    tid = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, model, status, started_at) "
        "VALUES ('agent', $1, '', $2, $3) RETURNING id",
        log,
        status,
        _at(at),
    )
    return tid, log


@pytest.fixture
async def dworld(pool):
    """A hallway conversation: an early action, the target, then one turn
    whose actions are rw_a (seq 0), a delegation (seq 1) whose child turn
    did rw_a then rw_b, and rw_b (seq 2)."""
    person = await _owner(pool)
    cid = await _conversation(pool, person)
    w = {"person": person, "cid": cid}
    t0 = await _turn(pool, cid, 0.5)
    await _msg(pool, cid, "user", "early", 0)
    w["early"] = await _action(pool, t0, cid, 0, "rw_a", undo={"n": 0})

    w["target"] = await _msg(pool, cid, "user", "get coder on the plan", 10)
    w["t"] = await _turn(pool, cid, 10.5)
    w["child"], w["log"] = await _child_turn(pool, 10.6)
    w["p0"] = await _action(pool, w["t"], cid, 0, "rw_a", undo={"n": 1})
    w["deleg"] = await _action(
        pool, w["t"], cid, 1, DELEGATE, undo={"agent_turn_id": str(w["child"])}
    )
    w["p2"] = await _action(pool, w["t"], cid, 2, "rw_b", undo={"n": 3})
    w["c0"] = await _action(pool, w["child"], w["log"], 0, "rw_a", undo={"n": 20})
    w["c1"] = await _action(pool, w["child"], w["log"], 1, "rw_b", undo={"n": 21})
    await _msg(pool, cid, "assistant", "coder did it", 11, w["t"])
    return w


async def _rw(pool, w, mode="executions"):
    return await rewinds.rewind(pool, app, w["person"], w["cid"], w["target"], mode)


async def _row(pool, action_id):
    return await pool.fetchrow(
        "SELECT reverted_by, revert_ok, revert_result FROM turn_actions WHERE id = $1", action_id
    )


async def test_the_childs_actions_are_claimed_and_reverted(pool, dworld, reverts):
    result = await _rw(pool, dworld)
    for key in ("c0", "c1"):
        row = await _row(pool, dworld[key])
        assert row["reverted_by"] == result["rewind_id"], key
        assert row["revert_ok"] is True, key
    undone = {u["action_id"] for u in result["undone"]}
    assert {str(dworld["c0"]), str(dworld["c1"])} <= undone


async def test_the_childs_actions_revert_newest_first_in_the_delegate_calls_place(
    pool, dworld, reverts
):
    await _rw(pool, dworld)
    assert [(name, payload["n"]) for name, payload, _ in reverts] == [
        ("rw_b", 3),
        ("rw_b", 21),
        ("rw_a", 20),
        ("rw_a", 1),
    ]


async def test_the_childs_rows_follow_the_hallways_rules(pool, reverts):
    person = await _owner(pool)
    cid = await _conversation(pool, person)
    target = await _msg(pool, cid, "user", "go", 10)
    t = await _turn(pool, cid, 10.5)
    child, log = await _child_turn(pool, 10.6)
    await _action(pool, t, cid, 0, DELEGATE, undo={"agent_turn_id": str(child)})
    failed = await _action(pool, child, log, 0, "rw_a", ok=False, undo={"n": 1})
    bare = await _action(pool, child, log, 1, "rw_a")
    norevert = await _action(pool, child, log, 2, "rw_norevert", undo={"n": 3})
    raises = await _action(pool, child, log, 3, "rw_raises", undo={"n": 4})
    good = await _action(pool, child, log, 4, "rw_b", undo={"n": 5})

    result = await rewinds.rewind(pool, app, person, cid, target, "executions")

    assert [u["action_id"] for u in result["undone"]] == [str(good)]
    reasons = {n.get("action_id"): n["reason"] for n in result["not_undone"]}
    for aid in (failed, bare, norevert, raises):
        assert str(aid) in reasons, aid
        row = await _row(pool, aid)
        assert row["reverted_by"] == result["rewind_id"] and row["revert_ok"] is not True
    assert reasons[str(raises)] == "the thing is already gone"
    assert "cannot be undone" in reasons[str(norevert)]
    assert [name for name, _, _ in reverts] == ["rw_b", "rw_raises"]


async def test_an_unclosed_child_turn_is_named_not_recorded(pool, reverts):
    person = await _owner(pool)
    cid = await _conversation(pool, person)
    target = await _msg(pool, cid, "user", "go", 10)
    t = await _turn(pool, cid, 10.5)
    child, _ = await _child_turn(pool, 10.6, status=None)
    deleg = await _action(pool, t, cid, 0, DELEGATE, undo={"agent_turn_id": str(child)})

    result = await rewinds.rewind(pool, app, person, cid, target, "executions")

    assert result["undone"] == []
    named = [n for n in result["not_undone"] if n.get("turn_id") == str(child)]
    assert len(named) == 1 and "not recorded" in named[0]["reason"]
    assert [n["tool"] for n in result["not_undone"] if n.get("action_id") == str(deleg)] == [
        DELEGATE
    ]


async def test_chat_mode_touches_no_child_action(pool, dworld, reverts):
    await _rw(pool, dworld, mode="chat")
    for key in ("c0", "c1"):
        assert (await _row(pool, dworld[key]))["reverted_by"] is None
    assert reverts == []
    # The contrast: a later executions rewind in the same conversation does
    # claim a delegated child's action (so this is not passing only because
    # children are never reached).
    marker_target = await _msg(pool, dworld["cid"], "user", "again", 100)
    t = await _turn(pool, dworld["cid"], 100.5)
    child, log = await _child_turn(pool, 100.6)
    await _action(pool, t, dworld["cid"], 0, DELEGATE, undo={"agent_turn_id": str(child)})
    c = await _action(pool, child, log, 0, "rw_a", undo={"n": 7})
    result = await rewinds.rewind(
        pool, app, dworld["person"], dworld["cid"], marker_target, "executions"
    )
    assert (await _row(pool, c))["reverted_by"] == result["rewind_id"]


async def test_a_child_action_already_reverted_is_never_reverted_again(pool, dworld, reverts):
    earlier = await pool.fetchval(
        "INSERT INTO rewinds (conversation_id, person_id, target_message_id, mode) "
        "VALUES ($1, $2, $3, 'executions') RETURNING id",
        dworld["cid"],
        dworld["person"].id,
        dworld["target"],
    )
    await pool.execute(
        "UPDATE turn_actions SET reverted_by = $1, revert_ok = true WHERE id = $2",
        earlier,
        dworld["c1"],
    )

    result = await _rw(pool, dworld)

    assert (await _row(pool, dworld["c1"]))["reverted_by"] == earlier
    assert ("rw_b", 21) not in [(n, p["n"]) for n, p, _ in reverts]
    assert (await _row(pool, dworld["c0"]))["reverted_by"] == result["rewind_id"]
    assert ("rw_a", 20) in [(n, p["n"]) for n, p, _ in reverts]


async def test_another_conversations_delegated_child_is_never_touched(pool, dworld, reverts):
    other = await _conversation(pool, dworld["person"])
    await _msg(pool, other, "user", "elsewhere", 10)
    ot = await _turn(pool, other, 10.5)
    ochild, olog = await _child_turn(pool, 10.6)
    await _action(pool, ot, other, 0, DELEGATE, undo={"agent_turn_id": str(ochild)})
    oaction = await _action(pool, ochild, olog, 0, "rw_a", undo={"n": 99})

    result = await _rw(pool, dworld)

    assert (await _row(pool, oaction))["reverted_by"] is None
    assert 99 not in [p["n"] for _, p, _ in reverts]
    assert (await _row(pool, dworld["c0"]))["reverted_by"] == result["rewind_id"]


async def test_the_marker_and_the_stored_row_name_the_childs_entries(pool, dworld, reverts):
    result = await _rw(pool, dworld)
    marker = await pool.fetchval(
        "SELECT content FROM messages WHERE id = $1", result["marker_message_id"]
    )
    assert "put back rw_a 20" in marker and "put back rw_b 21" in marker
    stored = await pool.fetchrow(
        "SELECT undone, not_undone FROM rewinds WHERE id = $1", result["rewind_id"]
    )
    undone = _json(_json(stored["undone"]))
    assert {str(dworld["c0"]), str(dworld["c1"])} <= {u["action_id"] for u in undone}
    assert undone == json.loads(json.dumps(result["undone"]))
    lines = {u["action_id"]: u["line"] for u in undone}
    assert lines[str(dworld["c0"])] == "put back rw_a 20"


def test_delegate_to_agent_stays_not_revertible():
    assert tools.REGISTRY[DELEGATE].revert is None
    assert agents.DELEGATE_TOOL == DELEGATE


# -- T9 COVERAGE: a failed delegation still reaches its child; only a
#    delegate row links -------------------------------------------------------


async def test_a_failed_delegations_child_is_still_reverted(pool, reverts):
    """The child may write and then fail, so delegate raises and its row is
    ok=False -- the link it carries must still be followed (criterion 1 links
    on failure so that criterion 2 can reach it)."""
    person = await _owner(pool)
    cid = await _conversation(pool, person)
    target = await _msg(pool, cid, "user", "go", 10)
    t = await _turn(pool, cid, 10.5)
    child, log = await _child_turn(pool, 10.6, status="error")
    deleg = await _action(pool, t, cid, 0, DELEGATE, ok=False, undo={"agent_turn_id": str(child)})
    wrote = await _action(pool, child, log, 0, "rw_a", undo={"n": 1})

    result = await rewinds.rewind(pool, app, person, cid, target, "executions")

    assert [u["action_id"] for u in result["undone"]] == [str(wrote)]
    assert (await _row(pool, wrote))["reverted_by"] == result["rewind_id"]
    assert [("rw_a", 1)] == [(n, p["n"]) for n, p, _ in reverts]
    assert [n["tool"] for n in result["not_undone"] if n.get("action_id") == str(deleg)] == [
        DELEGATE
    ]


async def test_only_a_delegate_row_links_a_child(pool, reverts):
    """A non-delegate row whose undo payload happens to carry agent_turn_id
    is not a link: the turn it names is never claimed."""
    person = await _owner(pool)
    cid = await _conversation(pool, person)
    target = await _msg(pool, cid, "user", "go", 10)
    t = await _turn(pool, cid, 10.5)
    child, log = await _child_turn(pool, 10.6)
    await _action(pool, t, cid, 0, "rw_norevert", undo={"agent_turn_id": str(child)})
    stray = await _action(pool, child, log, 0, "rw_a", undo={"n": 1})

    result = await rewinds.rewind(pool, app, person, cid, target, "executions")

    assert (await _row(pool, stray))["reverted_by"] is None
    assert reverts == []
    assert str(stray) not in {u["action_id"] for u in result["undone"]}
