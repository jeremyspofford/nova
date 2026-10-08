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

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import guards, machines, scheduler
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import _agent_turn, _nova_turn, _reply, _spans
from tests.test_chat_agents import _create as _create_agent
from tests.test_chat_agents import _owner as _agent_owner
from tests.test_chat_state_claim import (
    HUB,
    LOCAL,
    EngineGateway,
    _guard_spans,
    _say,
    _stored,
    _tool_spans,
    tool_call,
)
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


# ── stack_claim and ANOTHER machine's model server (live turn 07076682) ──────
#
# 2026-10-07: she read the Dell with machine_status (a walled remote "dell"
# provider) and said "can't reach Ollama" — true of the Dell's — and the guard
# replaced her whole reply. These drive the REAL machine_status against a
# gateway that serves a walled remote dell, so the excuse comes from the
# tool's own facts through chat's facts_sink copy, not a hand-built span.

DELL_URL = "http://100.122.40.93:11435/v1"
QUALIFIED_DELL = (
    "I can't reach Ollama on the Dell right now — it is walled for another few minutes."
)
BARE_DELL = "I can't reach Ollama: the Dell is walled for another few minutes."


@dataclass
class RemoteGateway(EngineGateway):
    """EngineGateway plus /admin/providers (a remote "dell" provider) and
    /admin/routes walls (a dell wall that ends in the FUTURE, so state_of
    reads it as walled, answering false)."""

    def __post_init__(self) -> None:
        super().__post_init__()
        self.app.router.routes.append(
            Route(machines.PROVIDERS_PATH, self._providers, methods=["GET"])
        )
        self.app.router.routes.append(Route(machines.ROUTES_PATH, self._routes, methods=["GET"]))

    async def _providers(self, request):
        return JSONResponse(
            {
                "providers": [
                    {
                        "name": "dell",
                        "adapter": "openai-chat",
                        "base_url": DELL_URL,
                        "listing": "unknown",
                        "listing_note": f"the last listing was refused (502): could not reach "
                        f"{DELL_URL}",
                    }
                ]
            }
        )

    async def _routes(self, request):
        until = (datetime.now(UTC) + timedelta(minutes=10)).isoformat()
        return JSONResponse(
            {
                "routes": [],
                "walls": [
                    {
                        "provider": "dell",
                        "model": "qwen3:8b",
                        "walled_until": until,
                        "reason": f"dell:qwen3:8b refused (502): could not reach {DELL_URL}",
                        "status": 502,
                        "strikes": 3,
                    }
                ],
            }
        )


def _remote_turn(reply: str, *, engine: bool) -> RemoteGateway:
    """Round 1 calls the real machine_status; round 2 is her text. CLOUD
    rounds carry no `local` usage (no engine head); ENGINE rounds carry it,
    served by the hub's engine."""
    if engine:
        return RemoteGateway(
            rounds=((tool_call("m1", "machine_status", {}), LOCAL), (text(reply), LOCAL)),
            served_by=HUB,
        )
    return RemoteGateway(rounds=((tool_call("m1", "machine_status", {}),), (text(reply),)))


@pytest.mark.parametrize("reply", [QUALIFIED_DELL, BARE_DELL], ids=["qualified", "bare"])
async def test_a_true_statement_about_the_dells_model_server_is_stored_verbatim(
    owner_client, pool, mount_peers, reply
):
    """Criteria 1 and 2: cloud-served, the real machine_status read a walled
    dell — her statement about the Dell's Ollama stands, word for word."""
    gateway = _remote_turn(reply, engine=False)
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "start the dell's ollama")

    assert gateway.calls == 2
    assert "stack_claim" not in [s["name"] for s in await _guard_spans(pool)]
    assert await _stored(pool) == reply


async def test_the_excuse_comes_from_the_real_tools_facts_and_the_guard_is_armed(
    owner_client, pool, mount_peers
):
    """Criterion 3, non-vacuity: the dell fact on the tool span is the REAL
    machine_status's (answering false), and the rounds are chat's, so the
    guard ran and chose not to fire."""
    mount_peers(gateway=_remote_turn(BARE_DELL, engine=False), memory=FakeMemory())

    await _say(owner_client, "start the dell's ollama")

    (tool,) = await _tool_spans(pool)
    assert tool["name"] == "machine_status" and tool["meta"]["ok"] is True
    dell = [f for f in tool["meta"]["facts"] if f.get("machine") == "dell"]
    assert dell and dell[0]["answering"] is False
    rounds = await pool.fetch("SELECT meta FROM turn_spans WHERE kind = 'llm_call'")
    assert len(rounds) == 2
    assert {r["meta"].get("purpose") for r in rounds} == {"chat"}


@pytest.mark.parametrize(
    ("reply", "engine"),
    [("I can't reach Ollama.", True), ("The backend is down right now.", False)],
    ids=["own-engine-served", "own-stack-noun"],
)
async def test_a_false_own_stack_claim_beside_the_dell_is_still_replaced(
    owner_client, pool, mount_peers, reply, engine
):
    """Criteria 4 and 5: the same walled dell, but her own engine served the
    turn, or the noun is her own stack's — the claim is false and REPLACED."""
    mount_peers(gateway=_remote_turn(reply, engine=engine), memory=FakeMemory())

    await _say(owner_client, "start the dell's ollama")

    assert "stack_claim" in [s["name"] for s in await _guard_spans(pool)]
    assert await _stored(pool) == guards.STACK_CLAIM_CORRECTION
