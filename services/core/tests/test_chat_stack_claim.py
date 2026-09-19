"""S19's serving-state guard at the funnel (chat._run_turn): where it is ARMED
and where it is not.

It is armed in the kinds its precision was measured in: chat (S19's own) and
eval, which replays chat's path with nothing injected. It is NOT armed in a
scheduled turn or an agent's turn. The S40 T7 review (2026-09-19) measured
three true outage reports firing there, and the correction is REPLACE-class:
nobody reads those streams live, so the persisted row became the correction
and the real report was gone. These pin both halves through the real funnel,
where the row is written — the guard-level pins are in test_guards.
"""

from __future__ import annotations

from datetime import timedelta
from pathlib import Path

import pytest

from app import guards, scheduler
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _agent_turn, _nova_turn, _reply, _spans
from tests.test_chat_agents import _create as _create_agent
from tests.test_chat_agents import _owner as _agent_owner
from tests.test_chat_tools import text
from tests.test_guards import TRUE_OUTAGE_REPORTS
from tests.test_scheduler import _firings, _scheduled, _set_model
from tests.test_scheduler import _owner as _scheduled_owner

pytestmark = requires_db


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    """An agent's folder is created under the workspace (test_chat_agents'
    fixture)."""
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _guards(spans) -> list:
    return [s["name"] for s in spans if s["kind"] == "guard"]


async def test_a_chat_turn_that_calls_the_answering_model_down_is_corrected(pool, mount_peers):
    """The control: the funnel still runs the guard in chat, and the row is
    the correction (REPLACE-class), not the stale claim."""
    owner = await _agent_owner(pool)
    mount_peers(
        gateway=ScriptedGateway(rounds=((text("The model is unreachable right now."),),)),
        memory=FakeMemory(),
    )
    turn, _frames = await _nova_turn(pool, owner, "can you check the time?")
    assert "stack_claim" in _guards(await _spans(pool, turn.id))
    assert await _reply(pool, turn.id) == guards.STACK_CLAIM_CORRECTION


@pytest.mark.parametrize("reply", TRUE_OUTAGE_REPORTS)
async def test_a_scheduled_turns_true_outage_report_is_what_persists(pool, mount_peers, reply):
    person, conversation = await _scheduled_owner(pool)
    mount_peers(gateway=ScriptedGateway(rounds=((text(reply),),)), memory=FakeMemory())
    await _set_model(pool)
    row = await _scheduled(pool, person, conversation, instruction="check my machines")
    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))

    (firing,) = await _firings(pool, row["id"])
    assert firing["status"] == "ok"
    assert "stack_claim" not in _guards(await _spans(pool, firing["turn_id"]))
    persisted = await _reply(pool, firing["turn_id"])
    assert persisted is not None and persisted.startswith(reply)
    assert guards.STACK_CLAIM_CORRECTION not in persisted


@pytest.mark.parametrize("reply", TRUE_OUTAGE_REPORTS)
async def test_an_agent_turns_true_outage_report_is_what_persists(pool, mount_peers, root, reply):
    owner = await _agent_owner(pool)
    agent = await _create_agent(pool, mount_peers)
    mount_peers(gateway=ScriptedGateway(rounds=((text(reply),),)), memory=FakeMemory())
    turn, _frames = await _agent_turn(pool, agent, owner, "check whether the site is up")

    assert "stack_claim" not in _guards(await _spans(pool, turn.id))
    persisted = await _reply(pool, turn.id)
    assert persisted is not None and persisted.startswith(reply)
    assert guards.STACK_CLAIM_CORRECTION not in persisted
