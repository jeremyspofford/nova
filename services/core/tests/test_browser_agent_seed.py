"""Her browsing agent is made once, through the agents writer, and only once an
owner exists (S38) — and a deleted one stays deleted."""

from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from app import agents, governance
from app.browser import agent as browser_agent
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _gateway() -> FakeGateway:
    return FakeGateway(
        admin_body={"role": "agent_browser", "chain": []},
        explain_body={
            "role": "agent_browser",
            "chain": [],
            "would_serve": {"role": "chat", "link": 1, "reason": None, "served_by": "hub:qwen3:8b"},
            "reason": None,
        },
    )


async def _owner(pool) -> None:
    await pool.execute("INSERT INTO people (name, role) VALUES ('jeremy', 'owner')")


async def _seeded_events(pool) -> list:
    return [e for e in await governance.recent_events(pool) if e["kind"] == governance.AGENT_SEEDED]


async def test_no_owner_yet_means_not_settled_and_nothing_made(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    assert await browser_agent.ensure_browser_agent(pool, app) is False
    assert await agents.by_name(pool, "browser") is None
    assert await _seeded_events(pool) == []


async def test_with_an_owner_it_is_made_with_its_tools_and_recorded(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    await _owner(pool)
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    made = await agents.by_name(pool, "browser")
    assert made is not None
    assert made.tools == browser_agent.SPEC.tools
    # PIN MOVED (no-ceiling T6): was max_tool_rounds == 30; an agent has no rounds.
    assert not hasattr(made, "max_tool_rounds")
    assert made.role == "agent_browser"
    assert (root / "agents" / "browser").is_dir()
    events = await _seeded_events(pool)
    assert len(events) == 1 and events[0]["actor"] == "seed (S38)"


def test_the_seed_spec_names_no_rounds():
    """no-ceiling T6: the browser agent's seed carries no round count — no
    count of tool rounds stops any turn, the browsing agent's included."""
    assert not hasattr(browser_agent.SPEC, "max_tool_rounds")
    assert "max_tool_rounds" not in inspect.getsource(browser_agent)


async def test_asking_again_makes_nothing_new(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    await _owner(pool)
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    assert len(await _seeded_events(pool)) == 1
    assert len([a for a in await agents.list_all(pool) if a.name == "browser"]) == 1


async def test_a_deleted_agent_is_not_made_again(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    await _owner(pool)
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    await agents.delete(pool, app, "browser", actor="jeremy")
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    assert await agents.by_name(pool, "browser") is None


async def test_an_agent_the_owner_already_named_browser_is_left_alone(pool, mount_peers, root):
    mount_peers(gateway=_gateway())
    await _owner(pool)
    spec = agents.AgentSpec(
        name="browser", purpose="his own", instructions="his words", tools=("get_time",)
    )
    await agents.create(pool, app, spec, created_via="page", created_turn_id=None, actor="jeremy")
    assert await browser_agent.ensure_browser_agent(pool, app) is True
    kept = await agents.by_name(pool, "browser")
    assert kept.purpose == "his own" and kept.tools == ("get_time",)
    events = await _seeded_events(pool)
    assert len(events) == 1 and events[0]["meta"]["made"] is False


async def test_seeded_tool_names_are_a_subset_of_the_live_registry(pool, mount_peers, root):
    """A renamed or removed tool must fail the seed loudly, never seed a dead
    name the agent could advertise but never call."""
    from app import tools

    live = frozenset(tools.REGISTRY)
    assert set(browser_agent.SPEC.tools) <= live
