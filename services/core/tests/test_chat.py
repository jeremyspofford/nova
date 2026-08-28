"""POST /api/v1/chat/stream — frames, persistence, and the trace it leaves."""
from __future__ import annotations

import asyncio
import json

import pytest

from app import chat
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory

pytestmark = requires_db

DONE = "[DONE]"


def frames(body: str) -> list:
    """SSE text -> the parsed payload of each frame, in order."""
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


async def _set_model(client, model: str = "qwen3:8b") -> None:
    resp = await client.put("/api/v1/settings", json={"key": "chat.model", "value": model})
    assert resp.status_code == 200


async def _say(client, message: str = "hello nova", **body) -> tuple[int, list]:
    resp = await client.post("/api/v1/chat/stream", json={"message": message, **body})
    return resp.status_code, frames(resp.text) if resp.status_code == 200 else resp.json()


def _scope(cookie: str, content_length: int) -> dict:
    """A raw ASGI scope, so a test can hang up the way a browser does."""
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/api/v1/chat/stream",
        "raw_path": b"/api/v1/chat/stream",
        "query_string": b"",
        "root_path": "",
        "scheme": "http",
        "headers": [
            (b"host", b"test"),
            (b"content-type", b"application/json"),
            (b"content-length", str(content_length).encode()),
            (b"cookie", f"nova_session={cookie}".encode()),
        ],
        "client": ("127.0.0.1", 5000),
        "server": ("test", 80),
    }


async def _spans(pool, turn_id) -> dict:
    rows = await pool.fetch(
        "SELECT kind, name, duration_ms, meta FROM turn_spans WHERE turn_id = $1", turn_id
    )
    return {row["kind"]: row for row in rows}


async def test_happy_path_frames_persistence_and_trace(owner_client, pool, mount_peers):
    gateway = FakeGateway(
        deltas=("Hel", "lo."), usage={"prompt_tokens": 11, "completion_tokens": 2}
    )
    memory = FakeMemory(results=({"title": "Kitchen", "snippet": "the kettle is new"},))
    mount_peers(gateway=gateway, memory=memory)
    await _set_model(owner_client)

    status, sent = await _say(owner_client, "what did we say about the kitchen?")
    assert status == 200

    meta = sent[0]["meta"]
    assert set(meta) == {"conversation_id", "model", "turn_id"}
    assert meta["model"] == "qwen3:8b"
    assert [f["t"] for f in sent[1:-1]] == ["Hel", "lo."]
    assert sent[-1] == DONE

    rows = await pool.fetch("SELECT role, content FROM messages ORDER BY created_at")
    assert [(r["role"], r["content"]) for r in rows] == [
        ("user", "what did we say about the kitchen?"),
        ("assistant", "Hello."),
    ]

    turn = await pool.fetchrow("SELECT id, status, model, conversation_id, ended_at FROM turns")
    assert str(turn["id"]) == meta["turn_id"]
    assert turn["status"] == "ok"
    assert turn["model"] == "qwen3:8b"
    assert str(turn["conversation_id"]) == meta["conversation_id"]
    assert turn["ended_at"] is not None

    spans = await _spans(pool, turn["id"])
    assert {"memory_recall", "llm_call", "memory_ingest"} <= set(spans)
    assert spans["memory_recall"]["meta"] == {"k": 5, "hits": 1}
    assert spans["llm_call"]["meta"]["model"] == "qwen3:8b"
    assert spans["llm_call"]["meta"]["prompt_tokens"] == 11
    assert spans["llm_call"]["meta"]["completion_tokens"] == 2
    assert spans["llm_call"]["meta"]["served_by"] == "ollama:qwen3:8b"
    assert spans["llm_call"]["duration_ms"] >= 0

    await chat.drain_background()
    assert memory.ingests[0]["exchange"] == {
        "user": "what did we say about the kitchen?",
        "assistant": "Hello.",
    }
    assert memory.ingests[0]["conversation_id"] == meta["conversation_id"]
    assert spans["memory_ingest"]["meta"] == {"queued": True}


async def test_the_prompt_is_two_system_messages_with_the_notes_in_the_volatile_one(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway()
    memory = FakeMemory(results=({"title": "Kitchen", "snippet": "the kettle is new"},))
    mount_peers(gateway=gateway, memory=memory)
    await _set_model(owner_client)

    await _say(owner_client, "kettle?")

    payload = gateway.seen[0][1]
    assert payload["stream"] is True
    assert payload["model"] == "qwen3:8b"
    sent = payload["messages"]
    assert [m["role"] for m in sent] == ["system", "system", "user"]
    assert "qwen3:8b" in sent[0]["content"]
    assert "Relevant notes:" in sent[1]["content"]
    assert "the kettle is new" in sent[1]["content"]
    assert sent[2] == {"role": "user", "content": "kettle?"}
    assert memory.recalls[0] == {
        "query": "kettle?",
        "person_id": (await pool.fetchval("SELECT id::text FROM people")),
        "k": 5,
    }


async def test_recall_failure_leaves_the_turn_fine_and_the_span_honest(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway(deltas=("fine",))
    memory = FakeMemory(recall_status=500)
    mount_peers(gateway=gateway, memory=memory)
    await _set_model(owner_client)

    status, sent = await _say(owner_client)
    assert status == 200
    assert sent[-1] == DONE
    assert [f["t"] for f in sent[1:-1]] == ["fine"]

    turn = await pool.fetchrow("SELECT id, status FROM turns")
    assert turn["status"] == "ok"
    recall = (await _spans(pool, turn["id"]))["memory_recall"]
    assert recall["meta"].get("hits", 0) == 0
    assert "500" in recall["meta"]["error"]

    # No snippets means no volatile message at all — not an empty one.
    sent_messages = gateway.seen[0][1]["messages"]
    assert [m["role"] for m in sent_messages] == ["system", "user"]


async def test_gateway_error_states_the_reason_and_marks_the_turn(
    owner_client, pool, mount_peers
):
    mount_peers(gateway=FakeGateway(status=500), memory=FakeMemory())
    await _set_model(owner_client)

    status, sent = await _say(owner_client, "are you there?")
    assert status == 200
    assert "meta" in sent[0]
    assert "error" in sent[1]
    assert sent[1]["error"]
    assert sent[-1] == DONE

    turn = await pool.fetchrow("SELECT id, status FROM turns")
    assert turn["status"] == "error"
    assert (await _spans(pool, turn["id"]))["llm_call"]["meta"]["error"]

    # The user's message stays; nothing is invented for the assistant.
    roles = [r["role"] for r in await pool.fetch("SELECT role FROM messages")]
    assert roles == ["user"]


async def test_an_empty_completion_is_an_error_not_a_silent_success(
    owner_client, pool, mount_peers
):
    mount_peers(gateway=FakeGateway(deltas=()), memory=FakeMemory())
    await _set_model(owner_client)

    status, sent = await _say(owner_client)
    assert status == 200
    assert sent[1] == {"error": "the model returned nothing"}
    assert sent[-1] == DONE

    assert [r["role"] for r in await pool.fetch("SELECT role FROM messages")] == ["user"]
    assert await pool.fetchval("SELECT status FROM turns") == "error"


async def test_history_drops_whole_oldest_messages_at_the_char_cap(
    owner_client, pool, mount_peers
):
    gateway = FakeGateway()
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    conversation = (await owner_client.get("/api/v1/conversations/active")).json()["id"]
    for index, size in enumerate((3000, 3000, 3000)):
        await pool.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at) "
            "VALUES ($1, 'user', $2, now() + make_interval(secs => $3))",
            conversation,
            f"{index}" * size,
            index,
        )

    await _say(owner_client, "and now?", conversation_id=conversation)

    sent = gateway.seen[0][1]["messages"]
    history = [m["content"] for m in sent if m["role"] == "user"][:-1]
    # 3 x 3000 chars would be 9000: the oldest whole message goes, not a slice.
    assert len(history) == 2
    assert history[0].startswith("1")
    assert history[1].startswith("2")
    assert sum(len(h) for h in history) <= chat.HISTORY_CHAR_BUDGET


async def test_the_second_turn_reuses_the_active_conversation(owner_client, pool, mount_peers):
    mount_peers(gateway=FakeGateway(deltas=("ok",)), memory=FakeMemory())
    await _set_model(owner_client)

    first = (await _say(owner_client, "one"))[1][0]["meta"]["conversation_id"]
    second = (await _say(owner_client, "two"))[1][0]["meta"]["conversation_id"]
    assert first == second
    assert await pool.fetchval("SELECT count(*) FROM conversations") == 1


async def test_someone_elses_conversation_is_a_404(owner_client, pool, mount_peers):
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    stranger = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('stranger', 'adult') RETURNING id"
    )
    theirs = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", stranger
    )

    resp = await owner_client.post(
        "/api/v1/chat/stream", json={"message": "hi", "conversation_id": str(theirs)}
    )
    assert resp.status_code == 404
    assert await pool.fetchval("SELECT count(*) FROM messages") == 0
    assert await pool.fetchval("SELECT count(*) FROM turns") == 0


async def test_a_disconnect_mid_stream_keeps_the_partial_text_and_says_interrupted(
    owner_client, pool, mount_peers
):
    hold = asyncio.Event()
    mount_peers(gateway=FakeGateway(deltas=("half an ans",), hold=hold), memory=FakeMemory())
    await _set_model(owner_client)

    body = json.dumps({"message": "tell me something long"}).encode()
    cookie = owner_client.cookies["nova_session"]
    streamed: list[bytes] = []
    saw_delta = asyncio.Event()
    request_sent = False

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await saw_delta.wait()
        return {"type": "http.disconnect"}

    async def send(message) -> None:
        if message["type"] == "http.response.body":
            chunk = message.get("body", b"")
            streamed.append(chunk)
            if b'"t":' in chunk:
                saw_delta.set()

    await asyncio.wait_for(app(_scope(cookie, len(body)), receive, send), timeout=10)
    hold.set()
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    assert any(b'"t": "half an ans"' in c or b'"t":"half an ans"' in c for c in streamed)
    turn = await pool.fetchrow("SELECT id, status FROM turns")
    assert turn["status"] == "interrupted"
    assert await pool.fetchval("SELECT content FROM messages WHERE role='assistant'") == (
        "half an ans"
    )


async def test_a_disconnect_after_the_answer_lands_does_not_store_it_twice(
    owner_client, pool, mount_peers
):
    """The stream's tail was lost, not the work — one reply, and it counts."""
    mount_peers(gateway=FakeGateway(deltas=("all done",)), memory=FakeMemory())
    await _set_model(owner_client)

    body = json.dumps({"message": "say something"}).encode()
    cookie = owner_client.cookies["nova_session"]
    saw_done = asyncio.Event()
    request_sent = False

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await saw_done.wait()
        return {"type": "http.disconnect"}

    async def send(message) -> None:
        if message["type"] == "http.response.body" and b"[DONE]" in message.get("body", b""):
            saw_done.set()

    await asyncio.wait_for(app(_scope(cookie, len(body)), receive, send), timeout=10)
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    assert await pool.fetchval("SELECT count(*) FROM messages WHERE role = 'assistant'") == 1
    assert await pool.fetchval("SELECT content FROM messages WHERE role='assistant'") == "all done"
    assert await pool.fetchval("SELECT status FROM turns") == "ok"


async def test_a_failure_storing_the_reply_still_ends_the_stream_properly(
    owner_client, pool, mount_peers
):
    """A truncated stream is indistinguishable from a dropped network — say it."""
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("almost there",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    turn = asyncio.create_task(
        owner_client.post("/api/v1/chat/stream", json={"message": "say something"})
    )
    # Once the turn is talking to the gateway, take its conversation away, so
    # writing the assistant row hits a real foreign-key failure.
    while not gateway.seen:
        await asyncio.sleep(0.01)
    await pool.execute("DELETE FROM conversations")
    hold.set()

    resp = await asyncio.wait_for(turn, timeout=10)
    assert resp.status_code == 200
    sent = frames(resp.text)
    assert "meta" in sent[0]
    assert [f["t"] for f in sent[1:-2]] == ["almost there"]
    assert sent[-2]["error"]
    assert sent[-1] == DONE
    assert await pool.fetchval("SELECT status FROM turns") == "error"


async def test_chat_needs_an_identity(client, mount_peers):
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    resp = await client.post("/api/v1/chat/stream", json={"message": "hello"})
    assert resp.status_code == 401


@pytest.mark.parametrize("message", ["", "   \n "])
async def test_an_empty_message_is_refused(owner_client, mount_peers, message):
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code in (400, 422)
