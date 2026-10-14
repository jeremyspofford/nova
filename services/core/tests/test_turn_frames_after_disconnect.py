"""verification-2-7 T28: once the client is gone, a turn's frames go nowhere.

The verification report (2026-10-13, item 2): the stream route hands a turn
`queue.put_nowait` onto an UNBOUNDED asyncio.Queue (chat.chat_stream), and
the turn runs on detached after a disconnect (S2c) — so every frame it emits
after the browser left (deltas, activity, cards) piles up in a queue nobody
will ever read, for the life of the turn. A 51-round turn the owner closed
the tab on holds every frame of every round.

The fix is not to stop the turn (a disconnect means "finish", S2c-R1) and
not to drop anything a connected reader would see: once `_stream_from_queue`
has stopped reading, further frames are dropped and what was queued unread is
released, while the turn runs to its end and persists exactly as before.

What a returning client needs is NOT the frames: ChatPage polls
GET /conversations/{id}/state (pending_turn, from traces.INFLIGHT) and then
reads GET /conversations/{id}/messages (the stored reply). C3 pins that path.

Memory is measured with tracemalloc INSIDE the flooding tool: the window
holds only the frames it emits (the card dicts are dropped as it goes), so
what is still allocated at the end of the window is what someone kept.
"""

from __future__ import annotations

import asyncio
import json
import tracemalloc
import uuid
from dataclasses import dataclass, field

import pytest

from app import chat, tools
from app.main import app
from app.tools.base import Tool
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat import DONE, _scope, frames
from tests.test_chat_tools import text, whole_call

pytestmark = requires_db

FLOOD = "t28_flood"
PARK = "t28_park"
CARDS = 200
CARD_CHARS = 20_000  # ~4 MB of card frames a flood
# What the turn may still hold of a ~4 MB flood emitted (or left unread) after
# the reader went: a few frames' worth, never the flood.
KEPT_LIMIT = 256 * 1024
WAIT_S = 15


@dataclass
class Rig:
    """The two tools' gates and what the flood measured."""

    start: asyncio.Event = field(default_factory=asyncio.Event)  # flood may emit
    measure: asyncio.Event = field(default_factory=asyncio.Event)  # flood may measure
    flooded: asyncio.Event = field(default_factory=asyncio.Event)  # every card emitted
    parked: asyncio.Event = field(default_factory=asyncio.Event)  # park reached
    go: asyncio.Event = field(default_factory=asyncio.Event)  # park may return
    kept: int | None = None  # bytes still allocated at the end of the window

    def open_all(self) -> None:
        for event in (self.start, self.measure, self.go):
            event.set()


@pytest.fixture
def rig(monkeypatch):
    rig = Rig()
    started_tracing = not tracemalloc.is_tracing()
    if started_tracing:
        tracemalloc.start()

    async def flood(args: dict, ctx) -> str:
        await asyncio.wait_for(rig.start.wait(), WAIT_S)
        assert ctx.card is not None, "the stream route binds a card channel"
        before = tracemalloc.get_traced_memory()[0]
        for index in range(CARDS):
            # Unique per card, so nothing is shared with an earlier one.
            ctx.card({"kind": "t28_card", "i": index, "blob": f"{index:06d}" + "x" * CARD_CHARS})
        rig.flooded.set()
        await asyncio.wait_for(rig.measure.wait(), WAIT_S)
        rig.kept = tracemalloc.get_traced_memory()[0] - before
        return f"sent {CARDS} cards"

    async def park(args: dict, ctx) -> str:
        rig.parked.set()
        await asyncio.wait_for(rig.go.wait(), WAIT_S)
        return "parked and released"

    empty = {"type": "object", "properties": {}, "additionalProperties": False}
    monkeypatch.setitem(
        tools.REGISTRY,
        FLOOD,
        Tool(name=FLOOD, description="Sends many cards.", parameters=empty, executor=flood),
    )
    monkeypatch.setitem(
        tools.REGISTRY,
        PARK,
        Tool(name=PARK, description="Waits.", parameters=empty, executor=park),
    )
    yield rig
    if started_tracing:
        tracemalloc.stop()


def _script() -> ScriptedGateway:
    return ScriptedGateway(
        rounds=(
            (text("first "), whole_call("c1", FLOOD, {})),
            (whole_call("c2", PARK, {}),),
            (text("done."),),
        )
    )


async def _set_model(client) -> None:
    resp = await client.put("/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"})
    assert resp.status_code == 200, resp.text


@dataclass
class Leaving:
    """One raw-ASGI turn whose client hangs up; what reached the wire."""

    sent: list[bytes] = field(default_factory=list)

    @property
    def turn_id(self) -> uuid.UUID:
        for body in self.sent:
            for block in body.decode().split("\n\n"):
                if block.startswith("data: {") and '"meta"' in block:
                    return uuid.UUID(json.loads(block[len("data: ") :])["meta"]["turn_id"])
        raise AssertionError("no meta frame reached the wire")


async def _leave_while_waiting(owner_client, message: str = "flood me") -> Leaving:
    """The client hangs up the instant the first delta reaches it: the reader
    is parked in its wait for the NEXT frame when it goes."""
    body = json.dumps({"message": message}).encode()
    cookie = owner_client.cookies["nova_session"]
    saw_delta = asyncio.Event()
    request_sent = False
    leaving = Leaving()

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await saw_delta.wait()
        return {"type": "http.disconnect"}

    async def send(msg) -> None:
        if msg["type"] == "http.response.body":
            leaving.sent.append(msg.get("body", b""))
            if b'"t"' in msg.get("body", b""):
                saw_delta.set()

    await asyncio.wait_for(app(_scope(cookie, len(body)), receive, send), timeout=WAIT_S)
    return leaving


async def _leave_while_stuck(owner_client, rig: Rig) -> Leaving:
    """A slow client: its socket stops taking bytes at the first card, the
    flood queues up unread behind it, and then it hangs up."""
    body = json.dumps({"message": "flood me"}).encode()
    cookie = owner_client.cookies["nova_session"]
    never = asyncio.Event()
    request_sent = False
    leaving = Leaving()

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await rig.flooded.wait()
        return {"type": "http.disconnect"}

    async def send(msg) -> None:
        if msg["type"] == "http.response.body":
            leaving.sent.append(msg.get("body", b""))
            if b'"card"' in msg.get("body", b""):
                await never.wait()  # the socket is full; cancelled at the hang-up

    await asyncio.wait_for(app(_scope(cookie, len(body)), receive, send), timeout=WAIT_S)
    return leaving


async def _ticks() -> None:
    """A moment for the response's own teardown, never a gc.collect()."""
    for _ in range(5):
        await asyncio.sleep(0)
    await asyncio.sleep(0.05)


async def _turn_spans(pool, turn_id: uuid.UUID) -> list[tuple[str, str]]:
    rows = await pool.fetch(
        "SELECT kind, name FROM turn_spans WHERE turn_id = $1 ORDER BY kind, name", turn_id
    )
    return [(row["kind"], row["name"]) for row in rows]


async def _reply_of(pool, turn_id: uuid.UUID) -> str:
    # Each assistant row belongs to the turn its conversation ran last before it.
    return await pool.fetchval(
        "SELECT m.content FROM messages m JOIN turns t ON t.conversation_id = m.conversation_id "
        "WHERE t.id = $1 AND m.role = 'assistant' AND m.created_at >= t.started_at "
        "ORDER BY m.created_at LIMIT 1",
        turn_id,
    )


def _assert_kept_nothing(rig: Rig) -> None:
    assert rig.kept is not None, "the flood never measured"
    assert rig.kept < KEPT_LIMIT, (
        f"{rig.kept:,} bytes of a {CARDS * CARD_CHARS:,}-byte flood are still held "
        "after the reader went — frames nobody will read were kept"
    )


# -- C1: nothing piles up once the reader has gone ---------------------------


async def test_v27_t28_c1_frames_emitted_after_the_client_left_are_not_kept(
    owner_client, pool, mount_peers, rig
):
    mount_peers(gateway=_script(), memory=FakeMemory())
    await _set_model(owner_client)
    rig.measure.set()
    rig.go.set()

    await _leave_while_waiting(owner_client)
    rig.start.set()  # the client is gone; now the turn floods
    await asyncio.wait_for(rig.flooded.wait(), WAIT_S)
    await asyncio.wait_for(chat.drain_background(), WAIT_S)

    _assert_kept_nothing(rig)


async def test_v27_t28_c1_frames_left_unread_when_a_stuck_client_hangs_up_are_released(
    owner_client, pool, mount_peers, rig
):
    mount_peers(gateway=_script(), memory=FakeMemory())
    await _set_model(owner_client)
    rig.start.set()
    rig.go.set()

    await _leave_while_stuck(owner_client, rig)
    await _ticks()
    rig.measure.set()  # the response has ended: measure what the turn still holds
    await asyncio.wait_for(chat.drain_background(), WAIT_S)

    _assert_kept_nothing(rig)


# -- C2: the turn runs to its end and persists exactly as a stayed one -------


async def test_v27_t28_c2_a_left_turn_persists_exactly_what_a_stayed_turn_does(
    owner_client, pool, mount_peers, rig
):
    await _set_model(owner_client)

    # The same script, a client that stays to [DONE].
    mount_peers(gateway=_script(), memory=FakeMemory())
    rig.open_all()
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "flood me"})
    assert resp.status_code == 200, resp.text
    stayed = uuid.UUID(frames(resp.text)[0]["meta"]["turn_id"])
    await asyncio.wait_for(chat.drain_background(), WAIT_S)

    # Again, a client that leaves before the flood.
    for event in (rig.start, rig.flooded, rig.parked):
        event.clear()
    rig.kept = None
    mount_peers(gateway=_script(), memory=FakeMemory())
    leaving = await _leave_while_waiting(owner_client)
    left = leaving.turn_id
    rig.start.set()
    await asyncio.wait_for(chat.drain_background(), WAIT_S)

    for turn_id in (stayed, left):
        assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == "ok"
    stayed_reply = await _reply_of(pool, stayed)
    assert stayed_reply and "done." in stayed_reply
    assert await _reply_of(pool, left) == stayed_reply
    assert await _turn_spans(pool, left) == await _turn_spans(pool, stayed)
    assert (FLOOD in str(await _turn_spans(pool, left))) and (
        PARK in str(await _turn_spans(pool, left))
    )

    _assert_kept_nothing(rig)


async def test_v27_t28_c2_a_message_queued_while_a_left_turn_runs_still_runs_after_it(
    owner_client, pool, mount_peers, rig
):
    """The queued (202) path rides the same end-of-turn marker as the stream:
    _run_turn's emit(None) lands on a CLOSED frame queue when the client has
    gone, and the drain of the conversation's queued messages comes after it.
    A closed queue must swallow that marker, never raise on it — or the
    message the owner queued mid-turn is never answered."""
    gateway = ScriptedGateway(
        rounds=(
            (text("first "), whole_call("c1", FLOOD, {})),
            (whole_call("c2", PARK, {}),),
            (text("done."),),
            (text("second answer."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    rig.measure.set()

    leaving = await _leave_while_waiting(owner_client)
    conversation_id = await pool.fetchval(
        "SELECT conversation_id FROM turns WHERE id = $1", leaving.turn_id
    )
    rig.start.set()
    await asyncio.wait_for(rig.parked.wait(), WAIT_S)

    queued = await owner_client.post(
        "/api/v1/chat/stream",
        json={"message": "the second thing", "conversation_id": str(conversation_id)},
    )
    assert queued.status_code == 202, queued.text

    rig.go.set()
    await asyncio.wait_for(chat.drain_background(), WAIT_S)

    rows = await pool.fetch(
        "SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY created_at, id",
        conversation_id,
    )
    assert [(r["role"], r["content"].strip()) for r in rows] == [
        ("user", "flood me"),
        ("assistant", rows[1]["content"].strip()),
        ("user", "the second thing"),
        ("assistant", "second answer."),
    ], rows
    assert rows[1]["content"].startswith("first ") and rows[1]["content"].rstrip().endswith("done.")
    statuses = await pool.fetch(
        "SELECT id, status FROM turns WHERE conversation_id = $1 ORDER BY started_at",
        conversation_id,
    )
    assert [r["status"] for r in statuses] == ["ok", "ok"]
    assert statuses[0]["id"] == leaving.turn_id

    _assert_kept_nothing(rig)


# -- C3: the returning client's path needs no frame --------------------------


async def test_v27_t28_c3_a_returning_client_reads_the_whole_reply_from_state_and_messages(
    owner_client, pool, mount_peers, rig
):
    mount_peers(gateway=_script(), memory=FakeMemory())
    await _set_model(owner_client)
    rig.measure.set()

    leaving = await _leave_while_waiting(owner_client)
    turn_id = leaving.turn_id
    conversation_id = await pool.fetchval(
        "SELECT conversation_id FROM turns WHERE id = $1", turn_id
    )
    rig.start.set()
    await asyncio.wait_for(rig.parked.wait(), WAIT_S)

    # Mid-turn, exactly as ChatPage asks after a hard refresh.
    state = await owner_client.get(f"/api/v1/conversations/{conversation_id}/state")
    assert state.status_code == 200, state.text
    assert state.json()["pending_turn"] is True
    assert state.json()["pending_turn_id"] == str(turn_id)

    rig.go.set()
    await asyncio.wait_for(chat.drain_background(), WAIT_S)

    state = await owner_client.get(f"/api/v1/conversations/{conversation_id}/state")
    assert state.json()["pending_turn"] is False
    listed = await owner_client.get(f"/api/v1/conversations/{conversation_id}/messages")
    assert listed.status_code == 200, listed.text
    rows = [m for m in listed.json()["messages"] if m["role"] == "assistant"]
    assert len(rows) == 1
    stored = await _reply_of(pool, turn_id)
    assert rows[0]["content"] == stored
    assert stored.startswith("first ") and stored.rstrip().endswith("done.")

    _assert_kept_nothing(rig)


# -- C4: a reader that stays gets every frame, in order ----------------------


async def test_v27_t28_c4_a_connected_client_gets_every_frame_in_order(
    owner_client, pool, mount_peers, rig
):
    """A pin: passes before GREEN. Dropping is for a reader that has GONE —
    a connected one (however slow) is never cut short or reordered."""
    mount_peers(gateway=_script(), memory=FakeMemory())
    await _set_model(owner_client)
    rig.open_all()

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "flood me"})
    assert resp.status_code == 200, resp.text
    sent = frames(resp.text)
    await asyncio.wait_for(chat.drain_background(), WAIT_S)

    assert "meta" in sent[0]
    assert sent[-1] == DONE
    cards = [f["card"] for f in sent if isinstance(f, dict) and "card" in f]
    assert [c["i"] for c in cards] == list(range(CARDS))
    assert all(len(c["blob"]) == 6 + CARD_CHARS for c in cards)
    deltas = [f["t"] for f in sent if isinstance(f, dict) and "t" in f]
    assert deltas[0] == "first " and "".join(deltas).rstrip().endswith("done.")
    first_card = next(i for i, f in enumerate(sent) if isinstance(f, dict) and "card" in f)
    last_card = max(i for i, f in enumerate(sent) if isinstance(f, dict) and "card" in f)
    first_t = next(i for i, f in enumerate(sent) if isinstance(f, dict) and f.get("t") == "first ")
    done_t = max(i for i, f in enumerate(sent) if isinstance(f, dict) and "t" in f)
    assert first_t < first_card <= last_card < done_t
