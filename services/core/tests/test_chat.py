"""POST /api/v1/chat/stream — frames, persistence, and the trace it leaves."""

from __future__ import annotations

import asyncio
import json
from datetime import date

import pytest

from app import chat, guards, traces
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory, ScriptedGateway

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
    # S12 (2026-09-08): the meta frame gained `agent` — the name of the agent
    # that ran the turn, null for Nova herself. An optional field on a known
    # key; old clients ignore it.
    assert set(meta) == {"conversation_id", "model", "turn_id", "agent"}
    assert meta["agent"] is None
    assert meta["model"] == "qwen3:8b"
    assert [f["t"] for f in sent if isinstance(f, dict) and "t" in f] == ["Hel", "lo."]
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
    # The block says what is mechanically true of the hits under it (they
    # matched, they cleared recall's floor, they are records) — never that they
    # are "relevant", which is the property nothing had established.
    assert chat.NOTES_HEADER in sent[1]["content"]
    assert "the kettle is new" in sent[1]["content"]
    assert sent[2] == {"role": "user", "content": "kettle?"}
    assert memory.recalls[0] == {
        "query": "kettle?",
        "person_id": (await pool.fetchval("SELECT id::text FROM people")),
        "k": 5,
    }


def test_a_note_is_labelled_with_what_is_known_about_it_and_nothing_more():
    """S13: "Relevant notes:" asserted a property nothing had established.

    What a hit carries instead is what memory actually sent about it — its kind
    and its age — and a hit that sent neither is labelled with neither. Guessing
    "today" from a missing date is how a two-week-old note gets read as this
    morning's, so an unknown age is simply absent.
    """
    today = date(2026, 9, 9)
    labelled = chat._snippets(
        [
            {
                "title": "Journal - 2026-09-06",
                "snippet": "we settled on mise",
                "kind": "journal",
                "created": "2026-09-06",
            },
            {"title": "Kitchen", "snippet": "the kettle is new"},
        ],
        today,
    )
    assert labelled == [
        "[journal, 3 days ago] Journal - 2026-09-06: we settled on mise",
        "Kitchen: the kettle is new",
    ]
    assert chat._age("2026-09-09", today) == "today"
    assert chat._age("2026-09-08", today) == "yesterday"
    # Nothing to read the age from: say nothing about it.
    assert chat._age(None, today) is None and chat._age("not a date", today) is None


def test_a_note_standing_only_on_her_own_words_is_labelled_as_such():
    """S14-1. A distilled note names the message it came from and the ROLE of
    that row, and the role is the whole point: a fact supported only by an
    assistant row is supported by something the model itself produced, and it
    must not read in the prompt like something she was told.

    A note with no citation carries no marker — that is the ordinary state of
    the whole corpus, and a word on every line would distinguish nothing.
    """
    today = date(2026, 9, 10)
    labelled = chat._snippets(
        [
            {
                "title": "Coffee",
                "snippet": "pour-over, no sugar",
                "kind": "topic",
                "created": "2026-09-10",
                "source": {"message_id": "m1", "role": "user"},
            },
            {
                "title": "Vram",
                "snippet": "24GB",
                "kind": "topic",
                "created": "2026-09-10",
                "source": {"message_id": "m2", "role": "assistant"},
            },
            {"title": "Kitchen", "snippet": "the kettle is new", "kind": "topic"},
        ],
        today,
    )
    assert labelled == [
        "[topic, today, cited to something the person said] Coffee: pour-over, no sugar",
        "[topic, today, cited only to something she said herself] Vram: 24GB",
        "[topic] Kitchen: the kettle is new",
    ]
    # A citation memory sent without a usable role is not a citation this can
    # weigh — say nothing rather than pick the flattering reading.
    assert chat._support({"message_id": "m3"}) is None
    assert chat._support("people/x/journals/2026-09-01.md") is None


def test_a_note_a_tool_can_answer_now_is_labelled_as_not_the_current_answer():
    """Owner ruling 2026-09-10: a spec a command can read should be read ad
    hoc, and the ad-hoc answer is the truth. The note is history — worth
    keeping to say what changed, never the current figure — and the failure
    this label prevents is reciting "24GB" from a note written before the card
    was swapped, with the machine one call away and able to say."""
    today = date(2026, 9, 10)
    labelled = chat._snippets(
        [
            {
                "title": "Graphics memory",
                "snippet": "the card holds 24GB",
                "kind": "topic",
                "created": "2026-08-20",
                "live_source": {"tool": "device_info", "args": {"device": "desktop"}},
            },
            {
                "title": "Coffee",
                "snippet": "pour-over, no sugar",
                "kind": "topic",
                "created": "2026-08-20",
            },
        ],
        today,
    )
    assert labelled == [
        "[topic, 21 days ago, not the current answer — device_info answers this now, ask it "
        "first] Graphics memory: the card holds 24GB",
        # Nothing can check a preference; memory IS the source, and the line
        # says nothing extra about it.
        "[topic, 21 days ago] Coffee: pour-over, no sugar",
    ]
    assert chat._live_source({"args": {}}) is None
    assert chat._live_source("device_info") is None


def test_the_prompt_tells_nothing_matched_apart_from_could_not_be_read():
    """The two facts a bare empty list used to collapse into one."""
    nothing = chat.volatile_system_prompt(chat.Recalled(empty="no note matched those words"))
    down = chat.volatile_system_prompt(chat.Recalled(unreachable="ConnectError: refused"))
    assert nothing is not None and down is not None
    assert "returned nothing: no note matched those words" in nothing
    assert "could not be read this turn" not in nothing
    assert "could not be read this turn — ConnectError: refused" in down
    assert "returned nothing" not in down
    # Knowing neither is still no volatile block at all.
    assert chat.volatile_system_prompt(chat.Recalled()) is None


def test_the_prompt_says_when_only_half_the_search_ran():
    """S13-5: a third state, and it is neither of the other two.

    Memory searches twice — by word and by meaning — and the meaning half
    needs an embedding model that may not be installed. "Nothing was written
    down about that" and "I could not look properly" are different things to
    say to somebody, and she can only say which if she is told which.
    """
    reduced = (
        "the semantic search did not run — the embedding model 'nomic-embed-text' is not "
        "installed on the embedding service at http://ollama:11434."
    )
    with_notes = chat.volatile_system_prompt(
        chat.Recalled(notes=("Kitchen: the kettle is new",), degraded=reduced)
    )
    assert "How that search was done:" in with_notes
    assert "not installed" in with_notes
    # It qualifies the notes rather than replacing them.
    assert "the kettle is new" in with_notes

    without = chat.volatile_system_prompt(
        chat.Recalled(empty="no note matched those words", degraded=reduced)
    )
    assert "returned nothing: no note matched those words" in without
    assert "How that search was done:" in without
    assert "rather than that she has nothing on the subject" in without
    # Distinct from the memory-is-down sentence: memory answered.
    assert "could not be read this turn" not in without

    # A full search says nothing about how it was done.
    full = chat.volatile_system_prompt(chat.Recalled(notes=("a note",)))
    assert "How that search was done:" not in full


def test_a_reduced_search_is_read_off_memorys_own_report():
    """core does not decide what a retriever report means, or reword it.

    Whether the embedding model is installed is memory's business and the
    sentence is memory's; this only picks out the fact that a retriever did
    not run. An older memory service that sends no report claims nothing in
    either direction — it must not be described as having run a full search,
    and it cannot be described as having run a reduced one.
    """
    assert chat._degraded_from({"hits": [], "results": []}) is None
    assert (
        chat._degraded_from(
            {
                "retrievers": [
                    {"name": "lexical", "ran": True, "ranked": 3},
                    {"name": "semantic", "ran": True, "ranked": 2},
                ]
            }
        )
        is None
    )
    said = chat._degraded_from(
        {
            "retrievers": [
                {"name": "lexical", "ran": True, "ranked": 3},
                {"name": "semantic", "ran": False, "reason": "the model is not installed"},
            ]
        }
    )
    assert said == "the semantic search did not run — the model is not installed."
    # `ran: False` with no reason is not a sentence anybody can repeat, and
    # inventing one here would be this service speaking for memory.
    assert chat._degraded_from({"retrievers": [{"name": "semantic", "ran": False}]}) is None


def test_a_search_that_ran_over_part_of_the_notes_is_a_limitation_too():
    """MAJOR 2 of the adversarial review, 2026-09-10.

    Memory composes the sentence — "The semantic search covered only part of
    the notes — 12 of 47 notes in this scope are embedded." — and sends it on
    every answer. This selected on `ran is False` alone, so a semantic
    retriever that RAN over a quarter of the corpus (ran=True, no reason,
    coverage set) produced None: no `retrievers_missing` on the span, nothing
    in the prompt, and an answer out of a quarter of the notes reading exactly
    like an answer out of all of them.
    """
    partial = chat._degraded_from(
        {
            "retrievers": [
                {"name": "lexical", "ran": True, "ranked": 3},
                {
                    "name": "semantic",
                    "ran": True,
                    "ranked": 2,
                    "coverage": "12 of 47 notes in this scope are embedded",
                },
            ]
        }
    )
    assert partial == (
        "the semantic search covered only part of the notes — 12 of 47 notes in this scope "
        "are embedded."
    )
    # And a retriever that did not run carries its coverage as well: "all 47
    # embedded at a width nothing can compare" is not "0 embedded", and the
    # reason alone never said which. (MINOR 4, same review.)
    both = chat._degraded_from(
        {
            "retrievers": [
                {"name": "lexical", "ran": True, "ranked": 3},
                {
                    "name": "semantic",
                    "ran": False,
                    "reason": "too few of these notes could be matched by meaning",
                    "coverage": "0 of 47 notes in this scope could be matched by meaning — 47 "
                    "carry a vector from a model whose vectors are a different width",
                },
            ]
        }
    )
    assert "different width" in both
    assert both.startswith("the semantic search did not run — too few")


def test_a_partial_search_qualifies_the_notes_it_did_return():
    """The branch WITH hits. "Here are three notes" reads as "and that is what
    there is"; a search over a quarter of the corpus has to say so beside the
    notes, not instead of them."""
    partial = (
        "the semantic search covered only part of the notes — 12 of 47 notes in this scope "
        "are embedded."
    )
    prompt = chat.volatile_system_prompt(
        chat.Recalled(notes=("Kitchen: the kettle is new",), degraded=partial)
    )
    assert "the kettle is new" in prompt
    assert "How that search was done:" in prompt
    assert "12 of 47" in prompt
    assert "rather than that she has nothing on the subject" in prompt


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
    assert [f["t"] for f in sent if isinstance(f, dict) and "t" in f] == ["fine"]

    turn = await pool.fetchrow("SELECT id, status FROM turns")
    assert turn["status"] == "ok"
    recall = (await _spans(pool, turn["id"]))["memory_recall"]
    assert recall["meta"].get("hits", 0) == 0
    assert "500" in recall["meta"]["error"]

    # S13: a recall that FAILED reaches the prompt as a failure. It used to be
    # indistinguishable from a recall that found nothing — both were an absent
    # volatile message — so she answered "I have nothing on that" out of an
    # outage. The reason is on the span AND in front of the model.
    sent_messages = gateway.seen[0][1]["messages"]
    assert [m["role"] for m in sent_messages] == ["system", "system", "user"]
    volatile = sent_messages[1]["content"]
    assert volatile.startswith("Her memory could not be read this turn — ")
    assert "500" in volatile
    assert "say the lookup failed" in volatile
    assert "returned nothing" not in volatile


async def test_gateway_error_states_the_reason_and_marks_the_turn(owner_client, pool, mount_peers):
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
    llm = (await _spans(pool, turn["id"]))["llm_call"]["meta"]
    assert llm["error"]
    assert llm["error_class"] == "GatewayFailure"
    assert llm["gateway_status"] == 500

    # The user's message stays, and the assistant row is the STATED failure —
    # the same sentence the error frame carried — never an invented reply and
    # never nothing (tests/test_chat_model_failure.py has the whole property).
    rows = await pool.fetch("SELECT role, content FROM messages ORDER BY created_at")
    assert [r["role"] for r in rows] == ["user", "assistant"]
    assert rows[1]["content"] == sent[1]["error"]
    assert "the gateway refused the request (500)" in rows[1]["content"]
    assert "backend refused" in rows[1]["content"]


async def test_an_empty_completion_is_an_error_not_a_silent_success(
    owner_client, pool, mount_peers
):
    mount_peers(gateway=FakeGateway(deltas=()), memory=FakeMemory())
    await _set_model(owner_client)

    status, sent = await _say(owner_client)
    assert status == 200
    # An empty round is a stated failure with the stream's counted facts in
    # it, not a bare "returned nothing" — and it is on record, so a reload
    # shows it (the measured 2026-09-04 silence).
    assert "error" in sent[1]
    assert sent[1]["error"].startswith("I didn't get a response from qwen3:8b (ollama): ")
    assert "no content and no tool calls" in sent[1]["error"]
    assert sent[-1] == DONE

    rows = await pool.fetch("SELECT role, content FROM messages ORDER BY created_at")
    assert [r["role"] for r in rows] == ["user", "assistant"]
    assert rows[1]["content"] == sent[1]["error"]
    assert await pool.fetchval("SELECT status FROM turns") == "error"


async def test_history_drops_whole_oldest_messages_at_the_char_cap(owner_client, pool, mount_peers):
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


async def test_switching_the_model_between_turns_is_used_by_the_very_next_one(
    owner_client, pool, mount_peers
):
    """The load-bearing property behind Settings -> Models "switch persists
    live": chat.model is read fresh at the top of every chat_stream call
    (app/chat.py), never cached for the life of a conversation or a process,
    so an operator switching it mid-session is honoured by the very next
    turn — no restart, no new conversation required."""
    mount_peers(gateway=FakeGateway(deltas=("ok",)))

    await _set_model(owner_client, "qwen3:8b")
    first_meta = (await _say(owner_client, "one"))[1][0]["meta"]
    assert first_meta["model"] == "qwen3:8b"

    await _set_model(owner_client, "qwen3:14b")
    second_meta = (await _say(owner_client, "two"))[1][0]["meta"]
    assert second_meta["model"] == "qwen3:14b"
    # Same conversation both times — this is a live switch, not a new session.
    assert second_meta["conversation_id"] == first_meta["conversation_id"]

    turns = await pool.fetch("SELECT model FROM turns ORDER BY started_at")
    assert [t["model"] for t in turns] == ["qwen3:8b", "qwen3:14b"]


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


def _whole_call(call_id: str, name: str, arguments: dict) -> dict:
    """A finished tool call in one completion chunk (the non-streaming shape),
    enough to drive a second tool-loop round from this suite without pulling
    in test_chat_tools' whole helper kit."""
    return {
        "choices": [
            {
                "message": {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [
                        {
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ],
                },
                "finish_reason": "tool_calls",
            }
        ]
    }


async def test_a_hard_refresh_mid_turn_finishes_server_side_with_the_full_reply(
    owner_client, pool, mount_peers
):
    """The durable-turn fix: a client that hangs up mid-reply tears down only
    the browser↔core stream. Core keeps draining the gateway — including the
    content that arrives AFTER the disconnect — and persists the COMPLETE
    answer with status 'ok', exactly as if the browser had stayed. (S2c.)"""
    hold = asyncio.Event()
    # "part one " streams before the client leaves; "part two." arrives only
    # after the hold releases — i.e. after the browser is already gone.
    mount_peers(
        gateway=FakeGateway(deltas=("part one ",), after_hold=("part two.",), hold=hold),
        memory=FakeMemory(),
    )
    await _set_model(owner_client)

    body = json.dumps({"message": "tell me something long"}).encode()
    cookie = owner_client.cookies["nova_session"]
    saw_delta = asyncio.Event()
    request_sent = False

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        # Hang up the instant the first delta reaches the wire — the model is
        # still mid-answer, and "part two." has not been sent yet.
        await saw_delta.wait()
        return {"type": "http.disconnect"}

    async def send(message) -> None:
        if message["type"] == "http.response.body" and b'"t"' in message.get("body", b""):
            saw_delta.set()

    await asyncio.wait_for(app(_scope(cookie, len(body)), receive, send), timeout=10)
    # The client is gone; release the rest of the gateway stream.
    hold.set()
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    # Exactly one assistant row (exactly-one-writer: only the detached
    # completion persists), and it is the WHOLE reply, not the pre-disconnect
    # prefix.
    assert await pool.fetchval("SELECT count(*) FROM messages WHERE role='assistant'") == 1
    assert await pool.fetchval("SELECT content FROM messages WHERE role='assistant'") == (
        "part one part two."
    )
    turn = await pool.fetchrow("SELECT id, status FROM turns")
    assert turn["status"] == "ok"
    # The trace is complete too — the llm_call span landed in the same atomic
    # close the detached completion performed.
    spans = await _spans(pool, turn["id"])
    assert "llm_call" in spans


async def test_the_detached_completion_still_runs_the_honesty_guard(
    owner_client, pool, mount_peers
):
    """There is exactly ONE turn path, so the honesty guard runs on the final
    text whether or not the browser stayed: a fabricated file-write claim that
    arrives AFTER the client disconnects is still contradicted in the durable
    reply."""
    hold = asyncio.Event()
    # The fabricated claim (no tool ever runs) arrives only after the client
    # has gone — the exact case a detached path could otherwise skip the guard.
    lie = "I've created a summary file called kv_offloading_summary.md."
    mount_peers(
        gateway=FakeGateway(deltas=("one moment ",), after_hold=(lie,), hold=hold),
        memory=FakeMemory(),
    )
    await _set_model(owner_client)

    body = json.dumps({"message": "summarize kv offloading to a file"}).encode()
    cookie = owner_client.cookies["nova_session"]
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
        if message["type"] == "http.response.body" and b'"t"' in message.get("body", b""):
            saw_delta.set()

    await asyncio.wait_for(app(_scope(cookie, len(body)), receive, send), timeout=10)
    hold.set()
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    stored = await pool.fetchval("SELECT content FROM messages WHERE role='assistant'")
    assert stored.endswith(guards.CORRECTION_TEXT)
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    turn_id = await pool.fetchval("SELECT id FROM turns")
    spans = await _spans(pool, turn_id)
    assert "guard" in spans and spans["guard"]["name"] == "narration"


async def test_the_detached_completion_runs_the_remaining_tool_rounds(
    owner_client, pool, mount_peers
):
    """Detaching is not "persist whatever streamed" — the tool loop's later
    rounds still run after the client leaves, and their output is part of the
    persisted reply."""
    hold = asyncio.Event()
    gateway = ScriptedGateway(
        rounds=(
            (_whole_call("c1", "get_time", {}),),  # round 0: ask for a tool
            ({"choices": [{"delta": {"content": "the answer after the tool"}}]},),  # round 1
        ),
        hold=hold,
        hold_before=1,  # stall round 1 until the client is gone
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)

    body = json.dumps({"message": "what time is it"}).encode()
    cookie = owner_client.cookies["nova_session"]
    saw_tool = asyncio.Event()
    request_sent = False

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        await saw_tool.wait()
        return {"type": "http.disconnect"}

    async def send(message) -> None:
        # The tool's activity frame proves round 0 ran; hang up right after it,
        # while round 1 is still held.
        if message["type"] == "http.response.body" and b'"activity"' in message.get("body", b""):
            saw_tool.set()

    await asyncio.wait_for(app(_scope(cookie, len(body)), receive, send), timeout=10)
    hold.set()  # let round 1 answer, now that the client is gone
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    assert await pool.fetchval("SELECT count(*) FROM messages WHERE role='assistant'") == 1
    assert await pool.fetchval("SELECT content FROM messages WHERE role='assistant'") == (
        "the answer after the tool"
    )
    assert await pool.fetchval("SELECT status FROM turns") == "ok"
    turn_id = await pool.fetchval("SELECT id FROM turns")
    spans = await _spans(pool, turn_id)
    # The tool genuinely ran, and it ran as part of the detached completion.
    assert "tool" in spans and spans["tool"]["name"] == "get_time"


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
    assert [f["t"] for f in sent if isinstance(f, dict) and "t" in f] == ["almost there"]
    assert sent[-2]["error"]
    assert sent[-1] == DONE
    assert await pool.fetchval("SELECT status FROM turns") == "error"


@pytest.mark.parametrize("outcome", ["ok", "error"])
async def test_a_turn_is_in_flight_exactly_while_this_process_runs_it(
    owner_client, pool, mount_peers, outcome
):
    """traces.INFLIGHT holds a turn's id from open_turn to the close, and
    /conversations/active reports pending_turn from THAT set — so while the
    model is talking the flag is true, and once the turn has reached a
    terminal status (ok or error alike) the id is gone and the flag is
    false. A row left NULL by a dead process is never in the set, which is
    what keeps a reload from spinning over nothing."""
    hold = asyncio.Event()
    gateway = FakeGateway(deltas=("almost there",), hold=hold)
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _set_model(owner_client)
    assert traces.INFLIGHT == set()

    turn = asyncio.create_task(
        owner_client.post("/api/v1/chat/stream", json={"message": "say something"})
    )
    while not gateway.seen:
        await asyncio.sleep(0.01)
    # Mid-turn: the row is open, this process holds its id, and the owner's
    # active conversation says so. Release the gateway in a finally so a
    # failed assertion cannot leave the turn held and cascade into the
    # module's later tests through the pool fixture's drain timeout.
    try:
        turn_id = await pool.fetchval("SELECT id FROM turns WHERE status IS NULL")
        assert traces.INFLIGHT == {turn_id}
        active = await owner_client.get("/api/v1/conversations/active")
        assert active.json()["pending_turn"] is True

        if outcome == "error":
            # Take the conversation away so persisting the reply fails — the
            # turn's error path, not its happy one.
            await pool.execute("DELETE FROM conversations")
    finally:
        hold.set()
    resp = await asyncio.wait_for(turn, timeout=10)
    assert resp.status_code == 200
    assert frames(resp.text)[-1] == DONE
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    assert traces.INFLIGHT == set()
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id) == outcome


async def test_chat_needs_an_identity(client, mount_peers):
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    resp = await client.post("/api/v1/chat/stream", json={"message": "hello"})
    assert resp.status_code == 401


@pytest.mark.parametrize("message", ["", "   \n "])
async def test_an_empty_message_is_refused(owner_client, mount_peers, message):
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    resp = await owner_client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code in (400, 422)
