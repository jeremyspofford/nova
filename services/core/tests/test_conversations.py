"""Conversations belong to a person, and only to that person."""

from __future__ import annotations

import logging
import uuid

from app import traces
from app.main import app, lifespan
from tests.conftest import OWNER, requires_db

pytestmark = requires_db


async def test_active_creates_one_then_reuses_it(owner_client, pool):
    first = await owner_client.get("/api/v1/conversations/active")
    assert first.status_code == 200
    body = first.json()
    # pending_turn joined the shape in S2c so a reloaded client can tell a
    # turn is still finishing server-side and poll for it (see chat.py).
    # pending_turn_id joined it in S15: the one case that most needs Stop is a
    # tab that reloaded into a hung turn, and such a tab has no meta frame and
    # so no turn id to aim the button at. Without this it could see the spinner
    # and not reach the stop.
    # `queued` joined it in S15 too: messages core accepted while a turn was
    # running, so a reloaded tab still shows what it sent rather than appearing
    # to have lost it.
    assert set(body) == {
        "id",
        "title",
        "created_at",
        "pending_turn",
        "pending_turn_id",
        "queued",
    }
    assert body["created_at"]
    # A brand-new conversation has no turn in flight.
    assert body["pending_turn"] is False
    assert body["pending_turn_id"] is None
    assert body["queued"] == []

    second = await owner_client.get("/api/v1/conversations/active")
    assert second.json()["id"] == body["id"]
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 1


async def _pending(owner_client) -> bool:
    return (await owner_client.get("/api/v1/conversations/active")).json()["pending_turn"]


async def test_active_reports_a_turn_this_process_is_running(owner_client, pool):
    """pending_turn is derived from TWO live facts: an unclosed turns row
    (status NULL) AND this process holding it in traces.INFLIGHT — the flag a
    reloaded client reads to know it should poll for the finishing reply.
    The row alone is not a turn: the moment the process lets go of the id
    the flag clears, whether or not the row has closed yet."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]

    # An open, not-yet-closed turn (status NULL), exactly as chat.py leaves it
    # while the model is still answering...
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('chat', $1) RETURNING id",
        uuid.UUID(conversation),
    )
    # ...and registered as running HERE, exactly as chat_stream does.
    traces.INFLIGHT.add(turn_id)
    try:
        assert await _pending(owner_client) is True
        # And WHICH turn (S15), from the same derivation — so a reloaded tab
        # can stop the turn it is waiting on instead of only watching it.
        body = (await owner_client.get("/api/v1/conversations/active")).json()
        assert body["pending_turn_id"] == str(turn_id)
    finally:
        traces.INFLIGHT.discard(turn_id)
    # Let go of it — the process is no longer running this turn.
    assert await _pending(owner_client) is False
    assert (await owner_client.get("/api/v1/conversations/active")).json()[
        "pending_turn_id"
    ] is None

    # Closed, the row is terminal and stays clear.
    await pool.execute("UPDATE turns SET status = 'ok', ended_at = now() WHERE id = $1", turn_id)
    assert await _pending(owner_client) is False


async def test_a_turn_no_process_is_running_is_never_pending(owner_client, pool, caplog):
    """The 2026-09-01 defect: core was SIGKILLed mid-turn by a redeploy, so
    close_turn never ran, and the NULL row it left read as "Nova is still
    responding" for a day. A NULL row THIS process is not running is not
    pending — and because the startup sweep should have closed it, finding one
    is said at WARNING rather than tidied silently."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('chat', $1) RETURNING id",
        uuid.UUID(conversation),
    )
    assert turn_id not in traces.INFLIGHT

    with caplog.at_level(logging.WARNING, logger="core"):
        assert await _pending(owner_client) is False

    (line,) = [
        r.getMessage()
        for r in caplog.records
        if r.levelno == logging.WARNING and str(turn_id) in r.getMessage()
    ]
    assert "no process is running" in line
    assert conversation in line
    # The row itself is untouched: reporting is not repairing — the sweep at
    # startup is the one writer of 'interrupted'.
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) is None


async def test_startup_closes_an_orphan_before_anyone_can_read_it_as_pending(owner_client, pool):
    """The whole path, through the app's real lifespan: a NULL-status turn in
    the owner's active conversation left by a dead process is 'interrupted'
    once the app has started, and /conversations/active reports no pending
    turn. (Plain ASGITransport never runs the lifespan — conftest — so it is
    entered here directly; that is the startup the container runs.)"""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    orphan = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('chat', $1) RETURNING id",
        uuid.UUID(conversation),
    )
    assert orphan not in traces.INFLIGHT

    async with lifespan(app):
        row = await pool.fetchrow("SELECT status, ended_at FROM turns WHERE id = $1", orphan)
        assert row["status"] == "interrupted"
        assert row["ended_at"] is not None
        assert await _pending(owner_client) is False


async def test_messages_come_back_oldest_first(owner_client, pool):
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    for index, (role, content) in enumerate(
        [("user", "first"), ("assistant", "second"), ("user", "third")]
    ):
        await pool.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at) "
            "VALUES ($1, $2, $3, now() + make_interval(secs => $4))",
            conversation,
            role,
            content,
            index,
        )

    resp = await owner_client.get(f"/api/v1/conversations/{conversation}/messages")
    assert resp.status_code == 200
    messages = resp.json()["messages"]
    assert [m["content"] for m in messages] == ["first", "second", "third"]
    assert [m["role"] for m in messages] == ["user", "assistant", "user"]
    assert all(m["created_at"] for m in messages)


async def test_someone_elses_conversation_is_a_404(owner_client, pool):
    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('stranger', 'adult') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", stranger
    )
    resp = await owner_client.get(f"/api/v1/conversations/{theirs}/messages")
    assert resp.status_code == 404


async def test_an_unknown_conversation_is_a_404(owner_client):
    resp = await owner_client.get(f"/api/v1/conversations/{uuid.uuid4()}/messages")
    assert resp.status_code == 404


async def test_conversations_need_an_identity(client):
    assert (await client.get("/api/v1/conversations/active")).status_code == 401


# -- clear chat: delete the transcript, leave the audit + memory alone ------


async def test_clear_deletes_this_conversations_messages(owner_client, pool):
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    for role, content in [("user", "hi"), ("assistant", "hello"), ("user", "again")]:
        await pool.execute(
            "INSERT INTO messages (conversation_id, role, content) VALUES ($1, $2, $3)",
            conversation,
            role,
            content,
        )

    resp = await owner_client.post(f"/api/v1/conversations/{conversation}/clear")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"id": conversation, "cleared": 3}  # a real count, not a bare "ok"

    # The transcript is gone; the empty state is real.
    remaining = await pool.fetchval(
        "SELECT count(*) FROM messages WHERE conversation_id = $1", conversation
    )
    assert remaining == 0
    listed = (await owner_client.get(f"/api/v1/conversations/{conversation}/messages")).json()
    assert listed["messages"] == []


async def test_clear_needs_an_identity(client, pool):
    # A real, owned conversation exists — the refusal is about the caller, not
    # the target. Register the owner, take their conversation, then call as an
    # anonymous client (no cookie, no bearer).
    resp = await client.post("/api/v1/auth/register", json=OWNER)
    assert resp.status_code == 200
    conversation = (await client.get("/api/v1/conversations/active")).json()["id"]
    # Drop the session cookie so the next call carries no identity at all.
    client.cookies.clear()
    resp = await client.post(f"/api/v1/conversations/{conversation}/clear")
    assert resp.status_code == 401
    # Nothing was cleared — but there was nothing to clear; the point is the 401.


async def test_clear_on_someone_elses_conversation_is_a_404_and_touches_nothing(owner_client, pool):
    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('stranger', 'adult') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", stranger
    )
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'theirs')",
        theirs,
    )

    resp = await owner_client.post(f"/api/v1/conversations/{theirs}/clear")
    assert resp.status_code == 404  # not found, not forbidden — someone else's

    # Their message is untouched: a 404 clears nothing.
    assert (
        await pool.fetchval("SELECT count(*) FROM messages WHERE conversation_id = $1", theirs)
    ) == 1


async def test_clear_on_an_unknown_conversation_is_a_404(owner_client):
    resp = await owner_client.post(f"/api/v1/conversations/{uuid.uuid4()}/clear")
    assert resp.status_code == 404


async def test_clear_leaves_the_audit_trail_and_conversation_intact(owner_client, pool):
    """Clear removes the transcript, NOT the audit history. turns/turn_spans and
    the governance ledger are what Activity and the operator's audit read; they
    must survive a clear — and the conversation row itself survives, so a turn's
    conversation_id is not even nulled."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'ask')",
        conversation,
    )
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, status, ended_at) "
        "VALUES ('chat', $1, 'ok', now()) RETURNING id",
        conversation,
    )
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name) VALUES ($1, 'tool', 'fetch_url')",
        turn_id,
    )
    await pool.execute("INSERT INTO governance_events (kind) VALUES ('device.enrolled')")

    resp = await owner_client.post(f"/api/v1/conversations/{conversation}/clear")
    assert resp.status_code == 200

    # Transcript gone...
    msg_count = await pool.fetchval(
        "SELECT count(*) FROM messages WHERE conversation_id = $1", conversation
    )
    assert msg_count == 0
    # ...but every audit row remains, and the conversation still exists.
    assert await pool.fetchval("SELECT count(*) FROM turns") == 1
    conversation_id = await pool.fetchval(
        "SELECT conversation_id FROM turns WHERE id = $1", turn_id
    )
    assert conversation_id is not None
    span_count = await pool.fetchval("SELECT count(*) FROM turn_spans WHERE turn_id = $1", turn_id)
    assert span_count == 1
    assert await pool.fetchval("SELECT count(*) FROM governance_events") == 1
    assert (
        await pool.fetchval("SELECT count(*) FROM conversations WHERE id = $1", conversation)
    ) == 1


# -- S12: a row says who wrote it and who was handed work ------------------
#
# Both keys are derived from the TRACE behind the row (the turns row via
# messages.turn_id, the agents row via turns.agent_id, the delegate spans in
# turn_spans) — never a label stored on the message, which could drift from
# what actually ran. Pinned the way turn_kind and served_by are: by inserting
# the ledger rows directly and reading the transcript back.

MESSAGE_KEYS = {
    "id",
    "role",
    "content",
    "created_at",
    "served_by",
    "turn_kind",
    "cost_usd",
    "route_reason",
    # S12 (2026-09-08): `agent` — the name of the agent whose turn wrote the
    # row — and `delegations` — the agents Nova handed work to in that turn.
    "agent",
    "delegations",
}


async def _agent(pool, name: str = "coder") -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO agents (name, purpose, instructions, tools, max_tool_rounds, created_via) "
        "VALUES ($1, 'writes code', 'be terse', ARRAY['workspace_write_file'], 8, 'page') "
        "RETURNING id",
        name,
    )


async def _turn(pool, conversation, *, agent_id=None, role=None, kind="chat") -> uuid.UUID:
    return await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id, status, ended_at, agent_id, role) "
        "VALUES ($1, $2, 'ok', now(), $3, $4) RETURNING id",
        kind,
        uuid.UUID(conversation),
        agent_id,
        role,
    )


async def _row(pool, conversation, role, content, turn_id=None, *, offset: int = 0) -> None:
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content, turn_id, created_at) "
        "VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))",
        uuid.UUID(conversation),
        role,
        content,
        turn_id,
        offset,
    )


async def _delegate_span(pool, turn_id, *, offset: int, meta: dict) -> None:
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name, started_at, meta) "
        "VALUES ($1, 'tool', 'delegate_to_agent', now() + make_interval(secs => $2), $3::jsonb)",
        turn_id,
        offset,
        meta,
    )


async def _messages(owner_client, conversation) -> list[dict]:
    resp = await owner_client.get(f"/api/v1/conversations/{conversation}/messages")
    assert resp.status_code == 200
    return resp.json()["messages"]


async def test_an_ordinary_nova_row_is_unchanged_but_for_agent_none_and_no_delegations(
    owner_client, pool
):
    """The pin for every row that has nothing to do with agents: the same
    keys as before plus the two new ones, and those read None / []."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    turn = await _turn(pool, conversation)
    await _row(pool, conversation, "user", "hi")
    await _row(pool, conversation, "assistant", "hello", turn, offset=1)

    user, nova = await _messages(owner_client, conversation)
    assert set(user) == MESSAGE_KEYS
    assert set(nova) == MESSAGE_KEYS
    assert (user["agent"], user["delegations"]) == (None, [])
    assert (nova["agent"], nova["delegations"]) == (None, [])
    assert nova["turn_kind"] == "chat"

    # Derived, never stored: messages carries no such column.
    columns = {
        r["column_name"]
        for r in await pool.fetch(
            "SELECT column_name FROM information_schema.columns WHERE table_name = 'messages'"
        )
    }
    assert not {"agent", "delegations"} & columns


async def test_an_agent_turns_row_carries_the_agents_name(owner_client, pool):
    """The agents API reads an agent's log conversation through the same
    rows: its report row names the agent (from turns.agent_id through the
    agents row), the brief row — a user row with no turn — does not."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    coder = await _agent(pool, "coder")
    turn = await _turn(pool, conversation, agent_id=coder, role="agent_coder", kind="agent")
    await _row(pool, conversation, "user", "Task: write hello.py")
    await _row(pool, conversation, "assistant", "Wrote hello.py", turn, offset=1)

    messages = await _messages(owner_client, conversation)
    assert [(m["role"], m["agent"]) for m in messages] == [("user", None), ("assistant", "coder")]
    assert messages[1]["turn_kind"] == "agent"
    assert messages[1]["delegations"] == []


async def test_a_deleted_agents_row_carries_none_not_a_remembered_name(owner_client, pool):
    """021: turns.agent_id is ON DELETE SET NULL. The transcript loses the
    name rather than inventing one; the ledger keeps the role text."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    coder = await _agent(pool, "coder")
    turn = await _turn(pool, conversation, agent_id=coder, role="agent_coder", kind="agent")
    await _row(pool, conversation, "assistant", "Wrote hello.py", turn)
    assert (await _messages(owner_client, conversation))[0]["agent"] == "coder"

    await pool.execute("DELETE FROM agents WHERE id = $1", coder)

    (row,) = await _messages(owner_client, conversation)
    assert row["agent"] is None
    assert row["turn_kind"] == "agent"
    assert await pool.fetchval("SELECT role FROM turns WHERE id = $1", turn) == "agent_coder"


async def test_delegations_derive_from_the_turns_delegate_spans(owner_client, pool):
    """One entry per delegate_to_agent tool span on the row's turn, in the
    order they ran: from meta.facts[0] when the run composed its result, else
    from args_redacted.agent with status 'error' — a delegate span that never
    got as far as facts is a failed hand-off, never a dropped one and never
    an 'ok' guessed from silence. Other tool spans are not delegations."""
    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    turn = await _turn(pool, conversation)
    await _row(pool, conversation, "user", "get coder to write hello.py and writer a draft")
    await _row(
        pool, conversation, "assistant", "coder wrote hello.py; writer failed", turn, offset=1
    )

    finished = str(uuid.uuid4())
    errored = str(uuid.uuid4())
    # 1. A run that finished: facts as the delegate tool files them.
    await _delegate_span(
        pool,
        turn,
        offset=0,
        meta={
            "ok": True,
            "args_redacted": {"agent": "coder", "task": "write hello.py"},
            "result_head": "[coder finished: status ok …]",
            "facts": [
                {
                    "agent": "coder",
                    "agent_turn_id": finished,
                    "status": "ok",
                    "files": ["agents/coder/hello.py", "agents/coder/notes/plan.md"],
                    "rounds": 2,
                    "calls_ok": 3,
                    "calls_failed": 0,
                }
            ],
        },
    )
    # 2. A call that never composed its result — no facts at all.
    await _delegate_span(
        pool,
        turn,
        offset=1,
        meta={
            "ok": False,
            "args_redacted": {"agent": "writer", "task": "draft it"},
            "result_head": "Error: no agent named writer — live agents: coder",
            "error": "Error: no agent named writer — live agents: coder",
        },
    )
    # 3. A run that finished in error, with facts (the child closed error).
    await _delegate_span(
        pool,
        turn,
        offset=2,
        meta={
            "ok": False,
            "args_redacted": {"agent": "coder", "task": "again"},
            "result_head": "Error: agent coder did not finish",
            "facts": [
                {
                    "agent": "coder",
                    "agent_turn_id": errored,
                    "status": "error",
                    "files": [],
                    "rounds": 1,
                    "calls_ok": 0,
                    "calls_failed": 1,
                }
            ],
        },
    )
    # 4. The known quirk: args_redacted degraded to a clipped STRING, no facts.
    await _delegate_span(
        pool,
        turn,
        offset=3,
        meta={"ok": False, "args_redacted": "xxx… (+4800 more chars)", "result_head": "Error"},
    )
    # A tool span that is not a delegation, and a delegate span on ANOTHER
    # turn — neither may show up on this row.
    await pool.execute(
        "INSERT INTO turn_spans (turn_id, kind, name, meta) VALUES ($1, 'tool', $2, $3::jsonb)",
        turn,
        "workspace_write_file",
        {"ok": True, "args_redacted": {"path": "a.md"}, "facts": [{"agent": "nope"}]},
    )
    other = await _turn(pool, conversation)
    await _delegate_span(
        pool,
        other,
        offset=0,
        meta={"ok": True, "facts": [{"agent": "coder", "agent_turn_id": "x", "status": "ok"}]},
    )

    user, nova = await _messages(owner_client, conversation)
    assert user["delegations"] == []
    assert nova["delegations"] == [
        {
            "agent": "coder",
            "agent_turn_id": finished,
            "status": "ok",
            "files": ["agents/coder/hello.py", "agents/coder/notes/plan.md"],
        },
        {"agent": "writer", "agent_turn_id": None, "status": "error", "files": []},
        {"agent": "coder", "agent_turn_id": errored, "status": "error", "files": []},
        {"agent": None, "agent_turn_id": None, "status": "error", "files": []},
    ]


async def test_messages_json_reads_one_conversation_and_the_route_still_scopes(owner_client, pool):
    """messages_json is the shared reader: it takes a conversation id and
    returns its rows with NO ownership check — the agents API reads an
    agent's log conversation (a household object, owned by whoever created
    the agent) through it. The ROUTE keeps its scoping: the same conversation
    is a 404 to anyone but its owner."""
    from app import conversations

    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('stranger', 'adult') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id, active, title) "
        "VALUES ($1, false, 'agent:coder') RETURNING id",
        stranger,
    )
    await pool.execute(
        "INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', 'Task: x')",
        theirs,
    )

    rows = await conversations.messages_json(pool, theirs)
    assert [(r["role"], r["content"]) for r in rows] == [("user", "Task: x")]
    assert set(rows[0]) == MESSAGE_KEYS
    assert (await owner_client.get(f"/api/v1/conversations/{theirs}/messages")).status_code == 404
