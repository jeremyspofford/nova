"""S12: an agent's monthly cap, enforced in chat._run_turn before any round.

What these pin: an agent over its cap ends the turn BEFORE recall and before
the first gateway round, with the cap sentence persisted verbatim as the
assistant row, the same sentence as the error frame, the turn 'error', an
agent_cap span carrying what the ledger said, and NO llm_call span or
completion request; under the cap the turn runs; a ledger that cannot be
read does NOT refuse — the turn runs and the span says `unreadable: …`;
no cap at all skips the read entirely (`skipped`, no /admin/spend).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import traces
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat_agents import _agent_turn, _create, _owner, _parsed, _reply, _spans

pytestmark = requires_db


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    """The WORKSPACE_ROOT every agent folder is made under (agents.create
    makes agents/<name>/ there)."""
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


STATEMENT = (
    "agent coder is over its monthly cap ($21.40 of $20.00 this month) — raise it on the "
    "Agents page"
)


def _spend(*rows: dict) -> dict:
    return {"window": "month", "timezone": "UTC", "totals": {"usd": 0}, "by_role": list(rows)}


def _role_row(usd: float) -> dict:
    return {"key": "agent_coder", "local": False, "usd": usd, "calls": 3}


async def _status(pool, turn_id) -> str | None:
    return await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id)


async def test_an_agent_over_its_cap_ends_before_any_round(pool, mount_peers, root):
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, monthly_cap_usd=20)
    gateway = FakeGateway(
        deltas=("must never stream",),
        spend_body=_spend(_role_row(21.4), {"key": "chat", "usd": 99.0}),
    )
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    turn, frames = await _agent_turn(pool, agent, owner)

    # The persisted assistant row IS the cap statement, verbatim.
    rows = await pool.fetch(
        "SELECT role, content FROM messages WHERE turn_id = $1 ORDER BY created_at", turn.id
    )
    assert [(r["role"], r["content"]) for r in rows] == [("assistant", STATEMENT)]
    assert await _status(pool, turn.id) == "error"
    # One span, the cap's, saying what the ledger said — and nothing else ran.
    spans = await _spans(pool, turn.id)
    assert [(s["kind"], s["name"]) for s in spans] == [("agent_cap", None)]
    assert spans[0]["meta"] == {
        "role": "agent_coder",
        "cap_usd": 20.0,
        "spent_usd": 21.4,
        "ledger": "read",
    }
    assert [path for path, _ in gateway.seen] == ["/admin/spend"]
    assert memory.recalls == [] and memory.ingests == []
    # The stream: meta, the same sentence as the error frame, [DONE].
    parsed = _parsed(frames)
    assert parsed[0]["meta"]["agent"] == "coder"
    assert parsed[1:] == [{"error": STATEMENT}, "[DONE]"]
    # And the exit path cleared the liveness map like every other exit.
    assert traces.doing(turn.id) is None


async def test_under_the_cap_the_turn_runs(pool, mount_peers, root):
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, monthly_cap_usd=20)
    gateway = FakeGateway(deltas=("ran",), spend_body=_spend(_role_row(3.0)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _agent_turn(pool, agent, owner)

    assert await _reply(pool, turn.id) == "ran"
    assert await _status(pool, turn.id) == "ok"
    spans = await _spans(pool, turn.id)
    assert [s["kind"] for s in spans][:3] == ["agent_cap", "memory_recall", "llm_call"]
    assert spans[0]["meta"] == {
        "role": "agent_coder",
        "cap_usd": 20.0,
        "spent_usd": 3.0,
        "ledger": "read",
    }
    assert [path for path, _ in gateway.seen] == ["/admin/spend", "/v1/chat/completions"]


async def test_an_unreadable_ledger_runs_the_turn_and_says_so(pool, mount_peers, root):
    """Fail-open, never quiet (rail 20): a gateway that cannot serve the
    spend report is not a reason to refuse the agent's work, and the span
    states exactly what could not be checked."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, monthly_cap_usd=20)
    # spend_body None: /admin/spend falls through to the admin echo, refused.
    gateway = FakeGateway(deltas=("ran",), admin_status=500, admin_body={"error": "ledger locked"})
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _agent_turn(pool, agent, owner)

    assert await _reply(pool, turn.id) == "ran" and await _status(pool, turn.id) == "ok"
    spans = await _spans(pool, turn.id)
    assert "llm_call" in {s["kind"] for s in spans}
    (cap,) = [s for s in spans if s["kind"] == "agent_cap"]
    assert cap["meta"] == {
        "role": "agent_coder",
        "cap_usd": 20.0,
        "spent_usd": None,
        "ledger": "unreadable: ledger locked",
    }


async def test_no_cap_skips_the_ledger(pool, mount_peers, root):
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)  # monthly_cap_usd NULL
    gateway = FakeGateway(deltas=("ran",))
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _ = await _agent_turn(pool, agent, owner)

    assert await _reply(pool, turn.id) == "ran" and await _status(pool, turn.id) == "ok"
    (cap,) = [s for s in await _spans(pool, turn.id) if s["kind"] == "agent_cap"]
    assert cap["meta"] == {"role": "agent_coder", "cap_usd": None, "ledger": "skipped"}
    assert [path for path, _ in gateway.seen] == ["/v1/chat/completions"]


async def test_at_exactly_the_cap_the_turn_ends_and_says_reached(pool, mount_peers, root):
    """spent == cap is a hit too (the next round would go over), and the
    sentence says `reached`, not `over` — the figure it quotes is not more
    than the cap, so `over` would be a false statement about the ledger."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers, monthly_cap_usd=20)
    gateway = FakeGateway(deltas=("must never stream",), spend_body=_spend(_role_row(20.0)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    turn, frames = await _agent_turn(pool, agent, owner)

    reached = (
        "agent coder has reached its monthly cap ($20.00 of $20.00 this month) — raise it on "
        "the Agents page"
    )
    assert await _reply(pool, turn.id) == reached
    assert await _status(pool, turn.id) == "error"
    assert _parsed(frames)[1:] == [{"error": reached}, "[DONE]"]
    assert [path for path, _ in gateway.seen] == ["/admin/spend"]
    assert memory.recalls == []
