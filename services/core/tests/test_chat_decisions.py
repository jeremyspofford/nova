"""The decision role in the live turn (decision-role spec §2).

Pins: a turn he typed asks the decision role before the first round — the
hint is one system line immediately before his message, the set-aside note is
gone from her notes, and the `decisions` span sits between recall and the
first llm_call; with no decision model the turn is byte-for-byte the pre-slice
turn; a slow decision model costs the budget and the turn still answers; every
note set aside is SAID; an eval case runs the step like a chat turn; a drained
queued message and an agent's turn never ask."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

from app import agents, chat, conversations, decisions, queued, traces
from app.evals import runner
from app.evals.cases import Case, PredicateSpec
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat_agents import _create, _open_agent_turn, _owner
from tests.test_decisions import _until_calls, decider

pytestmark = requires_db

MODEL = "qwen3:8b"
PHONE = "How do I get you on my phone"
HITS = (
    {
        "path": "people/o/journals/2026-09-15.md",
        "snippet": "sideload the app through TestFlight",
        "kind": "journal",
    },
    {"path": "people/o/topics/phone.md", "snippet": "his phone is an iPhone 16"},
)
HINT = (
    "A decision model reads the owner's message as needing your tool show_setup_qr "
    "(fit 0.85). Use it if it fits."
)


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


async def _nova(pool, owner, message: str, *, decide: bool) -> traces.Turn:
    """One owner turn through the funnel, as the stream route runs it (decide=True)
    or as every other caller does (decide=False)."""
    conversation = await conversations.active_conversation(pool, owner)
    turn = await traces.open_turn(
        pool, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )
    frames: list = []
    before = set(chat._BACKGROUND)
    await chat._run_turn(
        app,
        pool,
        turn,
        owner,
        conversation["id"],
        message,
        [],
        MODEL,
        frames.append,
        decide=decide,
    )
    await chat.settle_detached(before)
    return turn


def _sent(gateway: FakeGateway) -> list[list[dict]]:
    return [body["messages"] for path, body in gateway.seen if path == "/v1/chat/completions"]


def _clockless(messages: list[dict]) -> list[dict]:
    return [
        dict(m, content=re.sub(r"Current time: \S+", "Current time: T", m["content"]))
        for m in messages
    ]


async def test_a_decision_puts_its_hint_before_his_message_and_drops_the_stale_note(
    pool, mount_peers
):
    owner = await _owner(pool)
    gateway = FakeGateway(
        deltas=("Hello.",),
        decision_answer=decider(notes={"sideload": (0.8, 0.2, 0.9), "iPhone": (0.9, 0.1, 0.1)}),
    )
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))

    turn = await _nova(pool, owner, PHONE, decide=True)

    (messages,) = _sent(gateway)
    assert messages[-1] == {"role": "user", "content": PHONE}
    assert messages[-2] == {"role": "system", "content": HINT}
    volatile = messages[1]["content"]
    assert "iPhone 16" in volatile and "TestFlight" not in volatile
    kinds = [span.kind for span in turn.spans]
    assert kinds.index("memory_recall") < kinds.index("decisions") < kinds.index("llm_call")
    (span,) = [s for s in turn.spans if s.kind == "decisions"]
    assert span.meta["outcome"] == "decided"
    assert span.meta["hint"] == {"tool": "show_setup_qr", "fit": 0.85, "gate": 0.9}
    assert [(n["path"], n["kept"]) for n in span.meta["notes"]] == [
        ("people/o/journals/2026-09-15.md", False),
        ("people/o/topics/phone.md", True),
    ]


async def test_with_no_decision_model_the_turn_is_the_turn_it_was(pool, mount_peers):
    """Review focus 1, in core: no decisions chain (every install's first
    state). The gateway says so; her prompt is byte-for-byte what a turn that
    never asked gets, and the span says why nothing was applied."""
    owner = await _owner(pool)
    gateway = FakeGateway(deltas=("Hello.",))  # /v1/systemone: 503, no decision model
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))

    before = await _nova(pool, owner, PHONE, decide=False)
    after = await _nova(pool, owner, PHONE, decide=True)

    without, with_step = _sent(gateway)
    assert _clockless(with_step) == _clockless(without)
    assert not [s for s in before.spans if s.kind == "decisions"]
    (span,) = [s for s in after.spans if s.kind == "decisions"]
    assert span.meta["outcome"] == "failed_open"
    assert "the decisions chain is empty" in span.meta["reason"]


async def _switch(pool, key: str, on: bool) -> None:
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        key,
        on,
    )


@pytest.mark.parametrize(
    ("local", "cloud", "named"),
    [(None, None, "cloud"), (True, None, "cloud,local"), (True, False, "local")],
    ids=["the-defaults", "both-on", "local-only"],
)
async def test_the_turn_asks_with_the_kinds_of_decision_model_he_switched_on(
    pool, mount_peers, local, cloud, named
):
    """Decision-role spec §6: read for this turn, from his two switches — local
    (alpha) ships off and cloud (beta) on — and named on every call, so the
    gateway passes over a link of any other kind."""
    for key, on in (("decisions.local", local), ("decisions.cloud", cloud)):
        if on is not None:
            await _switch(pool, key, on)
    owner = await _owner(pool)
    gateway = FakeGateway(deltas=("Hello.",), decision_answer=decider())
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))

    turn = await _nova(pool, owner, PHONE, decide=True)

    assert len(gateway.decision_calls) == 4
    assert {c["headers"]["x-nova-decision-kinds"] for c in gateway.decision_calls} == {named}
    (span,) = [s for s in turn.spans if s.kind == "decisions"]
    assert span.meta["kinds"] == named.split(",")


async def test_with_both_switched_off_the_turn_asks_nothing_and_is_the_turn_it_was(
    pool, mount_peers
):
    """No call, no delay: her prompt is byte-for-byte a turn that never asked,
    every recalled note stands, and the span says the step is off."""
    await _switch(pool, "decisions.cloud", False)
    owner = await _owner(pool)
    gateway = FakeGateway(deltas=("Hello.",), decision_answer=decider())
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))

    before = await _nova(pool, owner, PHONE, decide=False)
    after = await _nova(pool, owner, PHONE, decide=True)

    assert gateway.decision_calls == []
    without, with_step = _sent(gateway)
    assert _clockless(with_step) == _clockless(without)
    assert not [m for m in with_step if m["content"] == HINT]
    assert not [s for s in before.spans if s.kind == "decisions"]
    (span,) = [s for s in after.spans if s.kind == "decisions"]
    assert span.meta["outcome"] == "off"
    assert (
        span.meta["why"] == "both decision models are switched off in Settings, so none was asked"
    )


async def test_a_slow_decision_model_costs_the_budget_and_she_still_answers(
    pool, mount_peers, monkeypatch
):
    monkeypatch.setattr(decisions, "TURN_BUDGET_S", 0.3)
    owner = await _owner(pool)
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("Hello.",), decision_answer=decider(), decision_hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))
    try:
        turn = await _nova(pool, owner, PHONE, decide=True)
    finally:
        hold.set()

    (messages,) = _sent(gateway)
    assert not [m for m in messages if m["content"] == HINT]
    assert "TestFlight" in messages[1]["content"], "a failed step leaves every note"
    (span,) = [s for s in turn.spans if s.kind == "decisions"]
    assert span.meta["reason"] == "no decision within the 0.3 s budget"
    assert (
        await pool.fetchval(
            "SELECT content FROM messages WHERE turn_id = $1 AND role = 'assistant'", turn.id
        )
        == "Hello."
    )


async def test_when_every_note_is_set_aside_her_prompt_says_so(pool, mount_peers):
    """Review focus 4, in the turn."""
    owner = await _owner(pool)
    gateway = FakeGateway(
        deltas=("Hello.",),
        decision_answer=decider(notes={"sideload": (0.8, 0.2, 0.9), "iPhone": (0.1, 0.0, 0.0)}),
    )
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))

    await _nova(pool, owner, PHONE, decide=True)

    (messages,) = _sent(gateway)
    volatile = messages[1]["content"]
    assert (
        "Her memory was searched for this turn; a decision model set aside all 2 notes it "
        "returned as unrelated to this message or superseded by what she can do now."
    ) in volatile
    assert "returned nothing" not in volatile


async def test_the_chat_stream_asks_the_decision_role(owner_client, mount_peers):
    gateway = FakeGateway(deltas=("Hi.",), decision_answer=decider())
    mount_peers(gateway=gateway, memory=FakeMemory())
    put = await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": MODEL})
    assert put.status_code == 200

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": PHONE})

    assert resp.status_code == 200
    assert len(gateway.decision_calls) == 2, "a turn he typed asks the decision role"
    assert all(c["headers"]["x-nova-role"] == "decisions" for c in gateway.decision_calls)
    assert all(c["headers"]["x-nova-purpose"] == "chat" for c in gateway.decision_calls)


async def test_an_eval_case_runs_the_decision_step_like_a_chat_turn(pool, mount_peers):
    """The runner measures the real chat path, so its turns ask too — under the
    eval purpose, attributed to the eval turn."""
    gateway = FakeGateway(
        deltas=("An answer.",), decision_answer=decider(tool="get_time", fit=0.9, gate=0.9)
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = Case(
        id="c",
        suite="corpus",
        suite_version=1,
        message="what time is it?",
        contract=(PredicateSpec("reply_matches", "answer"),),
    )

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True, run.detail
    spans = await pool.fetch(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'decisions'", run.turn_id
    )
    assert len(spans) == 1 and spans[0]["meta"]["hint"]["tool"] == "get_time"
    assert all(c["headers"]["x-nova-purpose"] == "eval" for c in gateway.decision_calls)


async def test_a_drained_queued_message_asks_no_decision_model(pool, mount_peers):
    """Spec §2, "Not on: … drains": the queue drain passes no `decide`."""
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    await queued.enqueue_for_test(pool, conversation, person, PHONE)
    gateway = FakeGateway(deltas=("Hi.",), decision_answer=decider())
    mount_peers(gateway=gateway, memory=FakeMemory())

    await chat.drain_queue(app, pool, conversation)
    await asyncio.wait_for(chat.drain_background(), timeout=15)

    assert await pool.fetchval("SELECT count(*) FROM messages WHERE role = 'assistant'") == 1
    assert gateway.decision_calls == []
    assert await pool.fetchval("SELECT count(*) FROM turn_spans WHERE kind = 'decisions'") == 0


async def test_an_agents_turn_asks_no_decision_model_even_when_told_to(pool, mount_peers, root):
    """Spec §2, "Not on: … agent delegation": an agent's persona never asks,
    whoever passed `decide` (an @mention reaches the funnel from the stream)."""
    owner = await _owner(pool)
    agent = await _create(pool, mount_peers)
    gateway = FakeGateway(deltas=("done",), decision_answer=decider())
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn = await _open_agent_turn(pool, agent, owner, kind="chat")
    before = set(chat._BACKGROUND)

    await chat._run_turn(
        app,
        pool,
        turn,
        agent.person(),
        agent.log_conversation_id,
        PHONE,
        [],
        MODEL,
        [].append,
        persona=agents.persona_for(agent, owner_id=owner.id),
        decide=True,
    )
    await chat.settle_detached(before)

    assert gateway.decision_calls == []
    assert not [s for s in turn.spans if s.kind == "decisions"]


async def test_a_recall_that_found_nothing_is_never_narrowed(pool, mount_peers, monkeypatch):
    """With no notes there is nothing to set aside, whatever the step answers:
    her prompt says the search came back empty, never that a decision model set
    aside "all 0 notes" — a search that found notes, which this one did not."""

    async def keeps_nothing(app, turn, message, notes, paths, advertised, *, kinds=None):
        return decisions.Advice(keep=())

    monkeypatch.setattr(decisions, "run", keeps_nothing)
    owner = await _owner(pool)
    gateway = FakeGateway(deltas=("Hello.",))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _nova(pool, owner, PHONE, decide=True)

    (messages,) = _sent(gateway)
    volatile = messages[1]["content"]
    assert "Her memory was searched for this turn and returned nothing" in volatile
    assert "set aside" not in volatile


async def test_a_turn_cancelled_during_the_step_ends_cancelled_and_closed(pool, mount_peers):
    """A cancellation that lands while the decision model is asked (a shutdown)
    is the turn's own: the step says so on its span and passes it on, the turn's
    task ends cancelled rather than running its rounds, and the turn is closed."""
    owner = await _owner(pool)
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("Hello.",), decision_answer=decider(), decision_hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory(results=HITS))
    conversation = await conversations.active_conversation(pool, owner)
    turn = await traces.open_turn(
        pool, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )
    before = set(chat._BACKGROUND)
    running = asyncio.create_task(
        chat._run_turn(
            app,
            pool,
            turn,
            owner,
            conversation["id"],
            PHONE,
            [],
            MODEL,
            [].append,
            decide=True,
        )
    )
    try:
        await _until_calls(gateway, 1)
        running.cancel()
        with pytest.raises(asyncio.CancelledError):
            await running
    finally:
        hold.set()
    await chat.settle_detached(before)

    assert _sent(gateway) == [], "no round ran after the cancellation"
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "error"
    meta = await pool.fetchval(
        "SELECT meta FROM turn_spans WHERE turn_id = $1 AND kind = 'decisions'", turn.id
    )
    assert meta["outcome"] == "cancelled"
