"""S12: `@name` in POST /api/v1/chat/stream — the whole turn runs as the agent.

What these pin: a leading `@coder` runs the turn as coder INSIDE the owner's
conversation — the user row is what was said, verbatim; the turns row
carries agent_id and role (kind stays 'chat', person_id stays the owner —
his money); the gateway request walks agent_coder's own chain (X-Nova-Role,
and NO model in the payload: model '' is "whatever the chain says", never
chat.model); the meta frame names the agent; memory recall and ingest run
under the AGENT's id, not the owner's, in the owner's conversation; a
reload derives `agent: 'coder'` on the assistant row from the trace. No
such agent, or an @ anywhere but the very start, is an ordinary Nova turn
(agent null, no agent_id, the chat chain, chat.model). History hands the
model "[coder] …" for rows written by SOMEONE ELSE and the bare content for
its own and for Nova's — stored rows untouched — and a deleted agent's rows
lose the name rather than gaining an invented one. An over-cap agent reached by @ ends the turn
with the cap statement as the error frame AND the persisted row, exactly as
delegation and a scheduled firing show it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import agents, chat, tools
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory
from tests.test_chat import DONE, _say, _set_model
from tests.test_chat_agents import _create
from tests.test_chat_cap import STATEMENT, _role_row, _spend

pytestmark = requires_db


@pytest.fixture
def root(monkeypatch, tmp_path) -> Path:
    """The WORKSPACE_ROOT every agent folder is made under."""
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


def _completions(gateway: FakeGateway) -> list[tuple[dict, dict]]:
    """(payload, headers) of every completion request the gateway saw."""
    return [
        (body, headers)
        for (path, body), headers in zip(gateway.seen, gateway.seen_headers, strict=True)
        if path == "/v1/chat/completions"
    ]


async def _owner_id(pool):
    return await pool.fetchval("SELECT id FROM people WHERE role = 'owner'")


async def _turn(pool):
    return await pool.fetchrow(
        "SELECT id, kind, status, model, agent_id, role, person_id, conversation_id "
        "FROM turns ORDER BY started_at DESC LIMIT 1"
    )


async def _rows(pool) -> list[tuple[str, str]]:
    rows = await pool.fetch("SELECT role, content FROM messages ORDER BY created_at, id")
    return [(r["role"], r["content"]) for r in rows]


def test_attributed_history_prefixes_only_the_other_speakers_rows():
    """The pure half, from BOTH seats (2026-09-08: `runner` moved this pin —
    the prefix now marks OTHER speakers, not every agent). A row an agent
    wrote reads "[name] …" to everyone EXCEPT that agent itself; a Nova row
    and a deleted agent's row (agent NULL) are byte-identical from either
    seat; a user row is never prefixed, whoever it addressed."""
    rows = [
        {"role": "assistant", "content": "hi", "agent": "coder"},
        {"role": "assistant", "content": "hi", "agent": "writer"},
        {"role": "assistant", "content": "hi", "agent": None},
        {"role": "user", "content": "@coder hi", "agent": None},
    ]
    # Nova's seat: every agent is named.
    assert chat.attributed_history(rows, None) == [
        {"role": "assistant", "content": "[coder] hi"},
        {"role": "assistant", "content": "[writer] hi"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "@coder hi"},
    ]
    # coder's seat: its own words are its own; the other agent is still named.
    assert chat.attributed_history(rows, "coder") == [
        {"role": "assistant", "content": "hi"},
        {"role": "assistant", "content": "[writer] hi"},
        {"role": "assistant", "content": "hi"},
        {"role": "user", "content": "@coder hi"},
    ]


async def test_a_leading_mention_runs_the_whole_turn_as_the_agent(
    owner_client, pool, mount_peers, root
):
    agent = await _create(pool, mount_peers)
    # chat.model is SET, so the pin that the agent path ignores it is real.
    await _set_model(owner_client)
    gateway = FakeGateway(deltas=("hi from coder",))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    status, sent = await _say(owner_client, "@coder hi")
    assert status == 200

    meta = sent[0]["meta"]
    assert meta["agent"] == "coder" and meta["model"] == ""
    assert [f["t"] for f in sent if isinstance(f, dict) and "t" in f] == ["hi from coder"]
    assert sent[-1] == DONE
    # The user row is what was said, verbatim — the @ is part of the message.
    assert await _rows(pool) == [("user", "@coder hi"), ("assistant", "hi from coder")]

    turn = await _turn(pool)
    owner = await _owner_id(pool)
    assert str(turn["id"]) == meta["turn_id"]
    assert (turn["kind"], turn["status"], turn["model"]) == ("chat", "ok", "")
    assert turn["agent_id"] == agent.id and turn["role"] == "agent_coder"
    # The owner's turn: his conversation, his money.
    assert turn["person_id"] == owner
    assert str(turn["conversation_id"]) == meta["conversation_id"]

    # One gateway round, on the agent's own chain: the role header names it
    # and the payload names NO model (its chain decides), with its subset.
    ((payload, headers),) = _completions(gateway)
    assert "model" not in payload
    assert headers["x-nova-role"] == "agent_coder"
    assert headers["x-nova-person"] == str(owner)
    assert headers["x-nova-turn-id"] == meta["turn_id"]
    assert payload["tools"] == tools.advertised_tools(agent.tools)
    assert "You are coder, an agent working for the household" in payload["messages"][0]["content"]

    # Memory: recalled from and ingested into the AGENT's partition, in the
    # owner's conversation.
    await chat.drain_background()
    assert memory.recalls == [{"query": "@coder hi", "person_id": str(agent.id), "k": 5}]
    assert memory.ingests == [
        {
            "person_id": str(agent.id),
            "conversation_id": meta["conversation_id"],
            "exchange": {"user": "@coder hi", "assistant": "hi from coder"},
        }
    ]

    # A reload derives the badge from the trace — the API already does.
    resp = await owner_client.get(f"/api/v1/conversations/{meta['conversation_id']}/messages")
    assert resp.status_code == 200
    listed = resp.json()["messages"]
    assert [(m["role"], m["content"], m["agent"]) for m in listed] == [
        ("user", "@coder hi", None),
        ("assistant", "hi from coder", "coder"),
    ]


@pytest.mark.parametrize("message", ["@nobody hi", "email @coder later"])
async def test_no_such_agent_or_an_at_elsewhere_is_an_ordinary_nova_turn(
    owner_client, pool, mount_peers, root, message
):
    """`@nobody` names no row; `email @coder later` mentions a real agent but
    does not ADDRESS it (the @ is not at the start). Both are Nova's turn,
    byte for byte: chat.model, the chat chain, no agent on the row."""
    await _create(pool, mount_peers)
    await _set_model(owner_client)
    gateway = FakeGateway(deltas=("nova here",))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    status, sent = await _say(owner_client, message)
    assert status == 200

    meta = sent[0]["meta"]
    assert meta["agent"] is None and meta["model"] == "qwen3:8b"
    assert await _rows(pool) == [("user", message), ("assistant", "nova here")]
    turn = await _turn(pool)
    assert (turn["agent_id"], turn["role"], turn["model"], turn["status"]) == (
        None,
        None,
        "qwen3:8b",
        "ok",
    )
    ((payload, headers),) = _completions(gateway)
    assert payload["model"] == "qwen3:8b" and headers["x-nova-role"] == "chat"
    assert payload["tools"] == tools.advertised_tools()
    await chat.drain_background()
    owner = await _owner_id(pool)
    assert memory.recalls == [{"query": message, "person_id": str(owner), "k": 5}]
    assert [i["person_id"] for i in memory.ingests] == [str(owner)]


async def test_history_names_the_agent_that_wrote_a_row_and_never_nova(
    owner_client, pool, mount_peers, root
):
    await _create(pool, mount_peers)
    await _set_model(owner_client)
    mount_peers(gateway=FakeGateway(deltas=("hi from coder",)), memory=FakeMemory())
    await _say(owner_client, "@coder hi")

    gateway = FakeGateway(deltas=("hello from nova",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _say(owner_client, "hello")
    ((payload, _),) = _completions(gateway)
    assert payload["messages"][-3:] == [
        {"role": "user", "content": "@coder hi"},
        {"role": "assistant", "content": "[coder] hi from coder"},
        {"role": "user", "content": "hello"},
    ]

    gateway = FakeGateway(deltas=("again",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _say(owner_client, "and again")
    ((payload, _),) = _completions(gateway)
    assert payload["messages"][-5:] == [
        {"role": "user", "content": "@coder hi"},
        # The agent's row carries its name…
        {"role": "assistant", "content": "[coder] hi from coder"},
        {"role": "user", "content": "hello"},
        # …and Nova's is byte-identical to what she said.
        {"role": "assistant", "content": "hello from nova"},
        {"role": "user", "content": "and again"},
    ]
    # The stored rows never carried the prefix.
    assert [c for r, c in await _rows(pool) if r == "assistant"] == [
        "hi from coder",
        "hello from nova",
        "again",
    ]

    # A deleted agent's turns lose their agent_id (021: SET NULL), so its
    # rows read as bare content — no name is invented for a row nobody can
    # be named for.
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    await agents.delete(pool, app, "coder", actor="jeremy")
    gateway = FakeGateway(deltas=("still here",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _say(owner_client, "who wrote that?")
    ((payload, _),) = _completions(gateway)
    assert [m["content"] for m in payload["messages"] if m["role"] == "assistant"] == [
        "hi from coder",
        "hello from nova",
        "again",
    ]


async def test_history_reads_first_person_from_the_running_agents_seat(
    owner_client, pool, mount_peers, root
):
    """The same transcript, two seats (2026-09-08). Nova is handed "[coder] …"
    for an agent's rows; coder is handed its OWN rows bare and every other
    speaker's named. Handing coder its own words back as somebody else's is
    how a model starts writing about itself in the third person — the exact
    sentence the delegation guard then has to correct."""
    await _create(pool, mount_peers)
    await _create(pool, mount_peers, name="writer")
    await _set_model(owner_client)

    mount_peers(gateway=FakeGateway(deltas=("hi from coder",)), memory=FakeMemory())
    assert (await _say(owner_client, "@coder hi"))[0] == 200
    mount_peers(gateway=FakeGateway(deltas=("hi from writer",)), memory=FakeMemory())
    assert (await _say(owner_client, "@writer hi"))[0] == 200

    # coder's seat: its own row bare, the other agent's named.
    gateway = FakeGateway(deltas=("again",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    assert (await _say(owner_client, "@coder again"))[0] == 200
    ((payload, _),) = _completions(gateway)
    assert [m for m in payload["messages"] if m["role"] == "assistant"] == [
        {"role": "assistant", "content": "hi from coder"},
        {"role": "assistant", "content": "[writer] hi from writer"},
    ]

    # Nova's seat: both agents named, including the row coder just read bare.
    gateway = FakeGateway(deltas=("nova here",))
    mount_peers(gateway=gateway, memory=FakeMemory())
    assert (await _say(owner_client, "who said what?"))[0] == 200
    ((payload, _),) = _completions(gateway)
    assert [m for m in payload["messages"] if m["role"] == "assistant"] == [
        {"role": "assistant", "content": "[coder] hi from coder"},
        {"role": "assistant", "content": "[writer] hi from writer"},
        {"role": "assistant", "content": "[coder] again"},
    ]
    # The stored rows never carried a prefix, from either seat.
    assert [c for r, c in await _rows(pool) if r == "assistant"] == [
        "hi from coder",
        "hi from writer",
        "again",
        "nova here",
    ]


async def test_a_mentioned_agent_over_its_cap_gets_the_cap_statement(
    owner_client, pool, mount_peers, root
):
    """The cap exit is the funnel's, so an @mention shows exactly what a
    delegation and a firing show: the statement as the error frame, the
    statement as the persisted row, the turn 'error', and nothing spent
    finding out — no recall, no round."""
    await _create(pool, mount_peers, monthly_cap_usd=20)
    gateway = FakeGateway(deltas=("must never stream",), spend_body=_spend(_role_row(21.4)))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    status, sent = await _say(owner_client, "@coder hi")
    assert status == 200

    assert sent[0]["meta"]["agent"] == "coder"
    assert sent[1:] == [{"error": STATEMENT}, DONE]
    assert await _rows(pool) == [("user", "@coder hi"), ("assistant", STATEMENT)]
    turn = await _turn(pool)
    assert turn["status"] == "error" and turn["role"] == "agent_coder"
    assert [path for path, _ in gateway.seen] == ["/admin/spend"]
    assert memory.recalls == [] and memory.ingests == []
