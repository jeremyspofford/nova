"""A message sent while a turn is running — parked, then answered (S15).

The defect this closes is two-sided. The owner could not send at all: the
composer was simply dead while Nova worked, so a correction typed during a
twenty-minute model pull had nowhere to go. And underneath that, nothing
server-side stopped a second POST: it opened a SECOND turn against the same
conversation, neither turn saw the other's message, and two replies landed
interleaved.

So the gate is mechanical and it is the server's: one turn per conversation,
decided under a per-conversation lock, and a message that arrives while one is
running is accepted as a row and run by itself the moment the turn ends.
"""

from __future__ import annotations

import asyncio
import uuid

from app import chat, conversations, queued, traces
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

pytestmark = requires_db


async def _set_model(client, model: str = "qwen3:8b") -> None:
    assert (
        await client.put("/api/v1/settings", json={"key": "chat.model", "value": model})
    ).status_code == 200


async def _active(client) -> dict:
    return (await client.get("/api/v1/conversations/active")).json()


async def _waiting(pool, conversation_id) -> list[str]:
    rows = await pool.fetch(
        "SELECT body FROM queued_messages WHERE conversation_id = $1 "
        "AND claimed_at IS NULL AND cancelled_at IS NULL ORDER BY seq",
        conversation_id,
    )
    return [r["body"] for r in rows]


# -- the gate ---------------------------------------------------------------


async def test_a_message_sent_mid_turn_is_queued_and_opens_no_second_turn(
    owner_client, pool, mount_peers
):
    """The server decides, not the client's idea of whether it is busy.

    A second POST gets 202 and a queued row — never a stream and never a
    second `turns` row, which is what used to produce two interleaved replies
    in one conversation.
    """
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("working on it",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    first = asyncio.create_task(
        owner_client.post("/api/v1/chat/stream", json={"message": "pull gemma4:26b"})
    )
    while not gateway.seen:
        await asyncio.sleep(0.01)
    try:
        second = await owner_client.post(
            "/api/v1/chat/stream", json={"message": "actually, 12b is fine"}
        )
        assert second.status_code == 202, second.text
        body = second.json()["queued"]
        assert body["body"] == "actually, 12b is fine"
        # Nothing else is waiting, so it is next up.
        assert body["ahead"] == 0
        assert body["conversation_id"]
        assert await pool.fetchval("SELECT count(*) FROM turns") == 1
    finally:
        hold.set()

    await asyncio.wait_for(first, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=15)


async def test_a_queued_message_runs_by_itself_once_the_turn_ends(owner_client, pool, mount_peers):
    """The promise a 202 makes, kept: the parked message becomes a real turn
    with a real reply, with nobody watching and nothing asked again."""
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("first answer",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    first = asyncio.create_task(
        owner_client.post("/api/v1/chat/stream", json={"message": "the first thing"})
    )
    while not gateway.seen:
        await asyncio.sleep(0.01)
    try:
        queued_resp = await owner_client.post(
            "/api/v1/chat/stream", json={"message": "the second thing"}
        )
        assert queued_resp.status_code == 202
    finally:
        hold.set()

    await asyncio.wait_for(first, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=15)

    # Two turns, in order, each with its own user message and reply.
    rows = await pool.fetch("SELECT role, content FROM messages ORDER BY created_at, id")
    assert [r["role"] for r in rows] == ["user", "assistant", "user", "assistant"]
    assert rows[0]["content"] == "the first thing"
    assert rows[2]["content"] == "the second thing"
    assert rows[3]["content"], "the queued message got a real reply"
    assert await pool.fetchval("SELECT count(*) FROM turns") == 2
    # The row is settled, claimed by the turn that ran it — not still waiting.
    claim = await pool.fetchrow("SELECT claimed_at, turn_id, cancelled_at FROM queued_messages")
    assert claim["claimed_at"] is not None
    assert claim["turn_id"] is not None
    assert claim["cancelled_at"] is None


async def test_two_queued_messages_run_in_the_order_they_were_typed(
    owner_client, pool, mount_peers
):
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("ok",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    first = asyncio.create_task(owner_client.post("/api/v1/chat/stream", json={"message": "one"}))
    while not gateway.seen:
        await asyncio.sleep(0.01)
    try:
        assert (
            await owner_client.post("/api/v1/chat/stream", json={"message": "two"})
        ).status_code == 202
        third = await owner_client.post("/api/v1/chat/stream", json={"message": "three"})
        assert third.status_code == 202
        # "two" runs before it.
        assert third.json()["queued"]["ahead"] == 1
    finally:
        hold.set()

    await asyncio.wait_for(first, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=20)

    users = await pool.fetch(
        "SELECT content FROM messages WHERE role = 'user' ORDER BY created_at, id"
    )
    assert [r["content"] for r in users] == ["one", "two", "three"]


async def test_an_empty_queued_message_is_refused_exactly_like_a_sent_one(
    owner_client, pool, mount_peers
):
    """The 400 on an empty message is the stream route's rule, and queueing
    must not become a way around it."""
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("x",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    first = asyncio.create_task(owner_client.post("/api/v1/chat/stream", json={"message": "one"}))
    while not gateway.seen:
        await asyncio.sleep(0.01)
    try:
        resp = await owner_client.post("/api/v1/chat/stream", json={"message": "   \n "})
        assert resp.status_code in (400, 422)
        assert await pool.fetchval("SELECT count(*) FROM queued_messages") == 0
    finally:
        hold.set()
    await asyncio.wait_for(first, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=15)


# -- what the owner can see and undo ----------------------------------------


async def test_active_shows_the_queue_and_stays_pending_until_it_drains(
    owner_client, pool, mount_peers
):
    """pending_turn means "an answer is still coming", which is exactly as
    true of a parked message as of a running turn. A reloaded tab polls on
    that flag; if it cleared between the turn closing and the drain opening
    the next one, the poll would stop and the queued reply would never land.
    """
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("ok",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    first = asyncio.create_task(owner_client.post("/api/v1/chat/stream", json={"message": "one"}))
    while not gateway.seen:
        await asyncio.sleep(0.01)
    try:
        await owner_client.post("/api/v1/chat/stream", json={"message": "two"})
        active = await _active(owner_client)
        assert active["pending_turn"] is True
        assert [q["body"] for q in active["queued"]] == ["two"]
    finally:
        hold.set()
    await asyncio.wait_for(first, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=20)

    settled = await _active(owner_client)
    assert settled["pending_turn"] is False
    assert settled["queued"] == []


async def test_a_queued_message_can_be_taken_back_before_it_runs(owner_client, pool, mount_peers):
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("ok",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    first = asyncio.create_task(owner_client.post("/api/v1/chat/stream", json={"message": "one"}))
    while not gateway.seen:
        await asyncio.sleep(0.01)
    try:
        queued_id = (
            await owner_client.post("/api/v1/chat/stream", json={"message": "never mind"})
        ).json()["queued"]["id"]
        gone = await owner_client.delete(f"/api/v1/chat/queued/{queued_id}")
        assert gone.status_code == 200, gone.text
        assert gone.json()["cancelled"] is True
        # Reported from the row it actually changed: a second delete changed
        # nothing and says so rather than answering 200 over a no-op.
        again = await owner_client.delete(f"/api/v1/chat/queued/{queued_id}")
        assert again.status_code == 409, again.text
    finally:
        hold.set()

    await asyncio.wait_for(first, timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=15)

    users = await pool.fetch("SELECT content FROM messages WHERE role = 'user'")
    assert [r["content"] for r in users] == ["one"], "a cancelled message never ran"
    assert await pool.fetchval("SELECT count(*) FROM turns") == 1


async def test_someone_elses_queued_message_is_not_found(owner_client, pool):
    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('someone else', 'guest') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", stranger
    )
    row = await queued.enqueue_for_test(pool, theirs, stranger, "not yours")
    resp = await owner_client.delete(f"/api/v1/chat/queued/{row}")
    assert resp.status_code == 404


# -- the promise, when the process does not survive to keep it --------------


async def test_startup_says_out_loud_which_queued_messages_it_will_not_send(pool, caplog):
    """A 202 is a promise; a promise nothing keeps is the worst kind of
    "success" to report. A fresh process runs no turns, so nothing will ever
    end and trigger a drain for a row left waiting by the process that died.

    It is NOT silently sent either: the box may have been down for days and
    the message may be long stale. So each one is cancelled with a stated
    reason the owner can read, and counted in the log.
    """
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    stranded = await queued.enqueue_for_test(pool, conversation, person, "still waiting")

    with caplog.at_level("WARNING"):
        await queued.sweep_stranded(pool)

    row = await pool.fetchrow(
        "SELECT cancelled_at, cancelled_reason FROM queued_messages WHERE id = $1", stranded
    )
    assert row["cancelled_at"] is not None
    assert row["cancelled_reason"], "cancelled, and it says why"
    assert "restart" in row["cancelled_reason"].lower()
    assert any("queued" in r.message.lower() for r in caplog.records)

    # Idempotent: a second sweep finds nothing and says nothing new.
    caplog.clear()
    with caplog.at_level("WARNING"):
        await queued.sweep_stranded(pool)
    assert caplog.records == []


async def test_a_shutting_down_process_does_not_start_a_queued_turn(pool, monkeypatch):
    """drain_background() waits for every detached task, and a drained turn
    spawns another drain — so a queue draining at shutdown could hold the
    process open past its grace period and be SIGKILLed mid-turn, which is how
    a claimed row ends up with no reply. A shutting-down process leaves the row
    waiting instead, for the next start to cancel with a reason.
    """
    person = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('owner', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", person
    )
    await queued.enqueue_for_test(pool, conversation, person, "do not start me")

    monkeypatch.setattr(chat, "_SHUTTING_DOWN", True)
    await chat.drain_queue(None, pool, conversation)

    assert await _waiting(pool, conversation) == ["do not start me"]
    assert await pool.fetchval("SELECT count(*) FROM turns") == 0


# -- the lock --------------------------------------------------------------


async def test_two_messages_arriving_together_cannot_both_open_a_turn(
    owner_client, pool, mount_peers
):
    """The check used to be advisory: seven round trips separated it from the
    INFLIGHT registration, so a double-tap (or a phone and a laptop) could both
    read "not busy" and both start. The decision is taken under a
    per-conversation advisory lock, so one wins and the other queues.
    """
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("ok",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    # Both in flight at once. The 200 is a stream that does not finish until the
    # gateway is released, so they cannot both be awaited before releasing it —
    # wait for the LOSER to come back, which is the whole assertion anyway.
    taps = [
        asyncio.create_task(owner_client.post("/api/v1/chat/stream", json={"message": f"tap {n}"}))
        for n in ("one", "two")
    ]
    try:
        done: set = set()
        while not done:
            done, _pending = await asyncio.wait(
                taps, timeout=5, return_when=asyncio.FIRST_COMPLETED
            )
            assert done, "neither send answered within 5 s"
        loser = done.pop().result()
        assert loser.status_code == 202, loser.text
        assert await pool.fetchval("SELECT count(*) FROM turns") == 1, "two turns at once"
        assert await pool.fetchval("SELECT count(*) FROM queued_messages") == 1
    finally:
        hold.set()

    answers = sorted(r.status_code for r in await asyncio.gather(*taps))
    assert answers == [200, 202]
    await asyncio.wait_for(chat.drain_background(), timeout=20)
    # And the loser was not dropped: it ran after the winner, in its own turn.
    users = await pool.fetch(
        "SELECT content FROM messages WHERE role = 'user' ORDER BY created_at, id"
    )
    assert sorted(r["content"] for r in users) == ["tap one", "tap two"]
    assert await pool.fetchval("SELECT count(*) FROM turns") == 2


async def test_a_message_accepted_into_a_conversation_that_just_went_free_still_runs(
    owner_client, pool, mount_peers, monkeypatch
):
    """The one window the drain's cheap pre-check cannot see.

    The drain that runs when a turn ends reads COMMITTED rows only, without the
    lock — so a message still inside its own open transaction is invisible to it,
    and that transaction can commit a moment after the turn has finished. Nothing
    would ever end again to try a second time.

    Simulated exactly: the gate says busy while nothing is running, so the message
    is accepted into a conversation no turn will ever free. It must still run,
    which it does because the accepting request triggers a drain of its own after
    it commits.
    """
    mount_peers(gateway=FakeGateway(deltas=("answered anyway",)), memory=FakeMemory())
    await _set_model(owner_client)

    calls = {"n": 0}

    async def busy_once(conn, conversation_id):
        calls["n"] += 1
        return calls["n"] == 1

    monkeypatch.setattr(conversations, "conversation_busy", busy_once)

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "do not strand me"})
    assert resp.status_code == 202, resp.text
    await asyncio.wait_for(chat.drain_background(), timeout=15)

    users = await pool.fetch("SELECT content FROM messages WHERE role = 'user'")
    assert [r["content"] for r in users] == ["do not strand me"]
    assert await pool.fetchval("SELECT count(*) FROM turns") == 1
    claim = await pool.fetchrow("SELECT claimed_at, turn_id FROM queued_messages")
    assert claim["claimed_at"] is not None and claim["turn_id"] is not None


async def test_a_scheduled_turn_also_makes_the_conversation_busy(owner_client, pool, mount_peers):
    """The gate must not read a set that only chat turns join. A timer firing
    runs a turn in the OWNER'S conversation through the same loop; if the gate
    missed it, a message typed during a scheduled turn would interleave —
    exactly the defect the gate exists to stop.
    """
    mount_peers(gateway=FakeGateway(deltas=("ok",)), memory=FakeMemory())
    conversation = uuid.UUID((await _active(owner_client))["id"])
    turn_id = await pool.fetchval(
        "INSERT INTO turns (kind, conversation_id) VALUES ('scheduled', $1) RETURNING id",
        conversation,
    )
    # Exactly what _run_turn records for EVERY kind it runs, chat or not.
    traces.set_doing(turn_id, "thinking")
    try:
        assert await conversations.conversation_busy(pool, conversation) is True
        assert await conversations.has_pending_turn(pool, conversation) is True
    finally:
        traces.clear_doing(turn_id)
    assert await conversations.conversation_busy(pool, conversation) is False
