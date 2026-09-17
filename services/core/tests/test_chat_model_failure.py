"""A model call that does not answer leaves a VISIBLE, HONEST reply behind.

Measured 2026-09-04 17:11 UTC: "list files in my workspace directory" — the
gateway sent headers after 280 s (a 27B model loading on CPU), the stream
ended at 300 s with nothing in it, the turn closed 'error', and no assistant
message was persisted. The chat showed "Nova is still responding…" and then
NOTHING; the llm_call span carried no error at all.

The property pinned here: every turn that ends 'error' at the model call
persists an assistant message stating what happened — the model, the engine
when known, the failure class, and whether anything ran — DERIVED from the
failed round's span and the tool spans, sent as the same error frame live,
recorded on the llm_call span as class + message, and never ingested.
"""

from __future__ import annotations

import json

import httpx
from starlette.applications import Starlette
from starlette.responses import StreamingResponse
from starlette.routing import Route

from app import chat, traces
from app.main import app
from tests import fakes
from tests.conftest import requires_db
from tests.fakes import FakeGateway, FakeMemory, ScriptedGateway

pytestmark = requires_db

DONE = "[DONE]"
MODEL = "qwen3:8b"


def frames(body: str) -> list:
    out = []
    for block in body.strip().split("\n\n"):
        assert block.startswith("data: "), block
        payload = block[len("data: ") :]
        out.append(payload if payload == DONE else json.loads(payload))
    return out


async def _set_model(client, model: str = MODEL) -> None:
    resp = await client.put("/api/v1/settings", json={"key": "chat.model", "value": model})
    assert resp.status_code == 200


async def _say(client, message: str = "list files in my workspace directory") -> list:
    resp = await client.post("/api/v1/chat/stream", json={"message": message})
    assert resp.status_code == 200, resp.text
    return frames(resp.text)


def _errors(sent: list) -> list[str]:
    return [f["error"] for f in sent if isinstance(f, dict) and "error" in f]


async def _llm_spans(pool) -> list:
    return await pool.fetch(
        "SELECT name, duration_ms, meta FROM turn_spans WHERE kind = 'llm_call' ORDER BY started_at"
    )


async def _assistant_rows(pool) -> list[str]:
    return [
        r["content"]
        for r in await pool.fetch(
            "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at"
        )
    ]


class RaisingTransport(httpx.AsyncBaseTransport):
    """Raises `make_exc(request)` on the `fail_on`th request; earlier requests
    are handed to `inner` — so a scripted round can run its tools before the
    transport dies under the next one."""

    def __init__(self, make_exc, *, inner=None, fail_on: int = 1) -> None:
        self.make_exc = make_exc
        self.inner = inner
        self.fail_on = fail_on
        self.calls = 0

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.calls >= self.fail_on or self.inner is None:
            raise self.make_exc(request)
        return await self.inner.handle_async_request(request)


def _mount_gateway_transport(transport) -> None:
    """After mount_peers: swap the gateway link's transport for one that fails."""
    app.state.peer_transports[fakes.GATEWAY_URL] = transport


def _read_timeout(request):
    return httpx.ReadTimeout("simulated silence", request=request)


def _connection_refused(request):
    return httpx.ConnectError("[Errno 111] Connection refused", request=request)


class RawStreamGateway:
    """A completions endpoint that answers 200 with EXACTLY `body` and closes —
    the shape the measured turn saw (an empty body) and the shape an upstream
    that writes a plain JSON error into a 200 stream produces."""

    def __init__(self, body: str, served_by: str = "ollama:qwen3:8b") -> None:
        self.body = body
        self.served_by = served_by
        self.app = Starlette(
            routes=[Route("/v1/chat/completions", self._completions, methods=["POST"])]
        )

    async def _completions(self, request):
        async def stream():
            if self.body:
                yield self.body

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"X-Nova-Served-By": self.served_by},
        )


# -- the timeout ---------------------------------------------------------------


async def test_a_read_timeout_persists_a_statement_naming_the_model_and_the_budget(
    owner_client, pool, mount_peers
):
    memory = FakeMemory()
    mount_peers(gateway=FakeGateway(), memory=memory)
    _mount_gateway_transport(RaisingTransport(_read_timeout))
    await _set_model(owner_client)

    sent = await _say(owner_client)
    await chat.drain_background()

    # The turn ends 'error' — and the owner has a reply to read.
    assert await pool.fetchval("SELECT status FROM turns") == "error"
    rows = await _assistant_rows(pool)
    assert len(rows) == 1, rows
    statement = rows[0]
    assert statement.startswith(f"I didn't get a response from {MODEL}")
    assert f"{chat.GATEWAY_TIMEOUT.read:g} s" in statement  # "300 s" — the configured budget
    assert "read timeout" in statement
    assert "ReadTimeout" in statement
    assert "Nothing was run." in statement  # derived: no tool span this turn
    assert chat.RETRY_HINT in statement
    # Streamed live as the error frame — the same sentence, so a watcher and a
    # reload read the same thing.
    assert _errors(sent) == [statement]
    assert sent[-1] == DONE

    # The llm_call span carries the failure as class + message.
    (span,) = await _llm_spans(pool)
    assert span["meta"]["error_class"] == "ReadTimeout"
    assert "ReadTimeout" in span["meta"]["error"]
    assert span["meta"]["timeout_phase"] == "read"
    assert span["meta"]["timeout_s"] == chat.GATEWAY_TIMEOUT.read

    # Not ingested: a failed call is plumbing, not knowledge.
    assert memory.ingests == []


async def test_a_timeout_after_a_tool_ran_says_what_ran_instead_of_nothing(
    owner_client, pool, mount_peers
):
    """Round 1 asks for get_time and it runs; round 2's transport times out.
    "Nothing was run" would be a lie here, so the statement names the tool —
    from its span, never from any prose."""
    memory = FakeMemory()
    scripted = ScriptedGateway(
        rounds=(
            (
                {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": None,
                                "tool_calls": [
                                    {
                                        "id": "c1",
                                        "type": "function",
                                        "function": {"name": "get_time", "arguments": "{}"},
                                    }
                                ],
                            },
                            "finish_reason": "tool_calls",
                        }
                    ]
                },
            ),
        )
    )
    mount_peers(gateway=scripted, memory=memory)
    _mount_gateway_transport(
        RaisingTransport(_read_timeout, inner=fakes.StreamingASGITransport(scripted.app), fail_on=2)
    )
    await _set_model(owner_client)

    sent = await _say(owner_client, "what time is it?")
    await chat.drain_background()

    assert [(f["activity"]["tool"], f["activity"]["status"]) for f in sent if "activity" in f] == [
        ("get_time", "start"),
        ("get_time", "ok"),
    ]
    assert await pool.fetchval("SELECT status FROM turns") == "error"
    (statement,) = await _assistant_rows(pool)
    assert "in round 2" in statement
    assert "Before that, get_time ran" in statement
    assert "Nothing was run" not in statement
    assert _errors(sent) == [statement]
    spans = await _llm_spans(pool)
    assert [s["meta"].get("error_class") for s in spans] == [None, "ReadTimeout"]
    assert memory.ingests == []


# -- the connection ------------------------------------------------------------


async def test_a_refused_connection_names_the_connection_failure(owner_client, pool, mount_peers):
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    _mount_gateway_transport(RaisingTransport(_connection_refused))
    await _set_model(owner_client)

    sent = await _say(owner_client)

    assert await pool.fetchval("SELECT status FROM turns") == "error"
    (statement,) = await _assistant_rows(pool)
    assert statement.startswith(
        f"I didn't get a response from {MODEL}: could not reach the gateway"
    )
    assert "ConnectError" in statement
    assert "Connection refused" in statement
    assert "Nothing was run." in statement
    assert _errors(sent) == [statement]
    (span,) = await _llm_spans(pool)
    assert span["meta"]["error_class"] == "ConnectError"
    assert "timeout_phase" not in span["meta"]


# -- the gateway's own failures ------------------------------------------------


async def test_a_provider_error_frame_is_stated_with_the_engine(owner_client, pool, mount_peers):
    """The gateway got far enough to send headers (so the engine is known) and
    then reported a failure in-stream, the way its relay does when the backend
    dies mid-flight."""
    mount_peers(
        gateway=FakeGateway(deltas=(), error_chunk="the backend stream failed — ReadTimeout"),
        memory=FakeMemory(),
    )
    await _set_model(owner_client)

    sent = await _say(owner_client)

    (statement,) = await _assistant_rows(pool)
    assert statement.startswith(f"I didn't get a response from {MODEL} (ollama): ")
    assert "the gateway reported: the backend stream failed — ReadTimeout" in statement
    assert _errors(sent) == [statement]
    (span,) = await _llm_spans(pool)
    assert span["meta"]["error_class"] == "GatewayFailure"
    assert span["meta"]["served_by"] == "ollama:qwen3:8b"


async def test_a_gateway_5xx_is_stated_with_its_status(owner_client, pool, mount_peers):
    mount_peers(gateway=FakeGateway(status=502), memory=FakeMemory())
    await _set_model(owner_client)

    sent = await _say(owner_client)

    (statement,) = await _assistant_rows(pool)
    assert "the gateway refused the request (502)" in statement
    assert "backend refused" in statement  # the gateway's own words, kept
    assert _errors(sent) == [statement]
    (span,) = await _llm_spans(pool)
    assert span["meta"]["error_class"] == "GatewayFailure"
    assert span["meta"]["gateway_status"] == 502


# -- the empty stream (the measured shape) --------------------------------------


async def test_an_empty_stream_is_a_stated_round_failure_with_its_counted_facts(
    owner_client, pool, mount_peers
):
    """The measured turn: 200 with headers, then the stream ended with nothing
    — no data line, no [DONE]. Before this the span said nothing about it and
    the turn's only trace was "the model returned nothing" on a frame nobody
    was still reading."""
    memory = FakeMemory()
    mount_peers(gateway=FakeGateway(), memory=memory)
    _mount_gateway_transport(fakes.StreamingASGITransport(RawStreamGateway("").app))
    await _set_model(owner_client)

    sent = await _say(owner_client)
    await chat.drain_background()

    assert await pool.fetchval("SELECT status FROM turns") == "error"
    (statement,) = await _assistant_rows(pool)
    assert statement.startswith(f"I didn't get a response from {MODEL} (ollama): the stream ended")
    assert "with no content and no tool calls" in statement
    assert "0 data line(s)" in statement
    assert "[DONE] never sent" in statement
    assert "Nothing was run." in statement
    # NOT mislabelled as a backend without tool support: only a reason the
    # gateway itself stated can be about tools.
    assert "does not support tools" not in statement
    assert _errors(sent) == [statement]
    (span,) = await _llm_spans(pool)
    assert span["meta"]["error_class"] == chat.EMPTY_ROUND
    assert span["meta"]["error"] == statement.split(": ", 1)[1].split(". Nothing")[0]
    assert span["meta"]["stream"] == {"done": False, "data_lines": 0}
    assert memory.ingests == []


async def test_a_plain_json_error_in_a_200_stream_is_counted_not_dropped(
    owner_client, pool, mount_peers
):
    """A line that is not SSE data used to be skipped in silence. It is the one
    thing an upstream that gave up mid-load actually said, so its head is on
    the span and in the statement."""
    body = '{"error":{"message":"timed out waiting for llama runner to start"}}\n'
    mount_peers(gateway=FakeGateway(), memory=FakeMemory())
    _mount_gateway_transport(fakes.StreamingASGITransport(RawStreamGateway(body).app))
    await _set_model(owner_client)

    await _say(owner_client)

    (statement,) = await _assistant_rows(pool)
    assert "1 non-SSE line(s)" in statement
    assert "timed out waiting for llama runner to start" in statement
    (span,) = await _llm_spans(pool)
    assert span["meta"]["stream"] == {
        "done": False,
        "data_lines": 0,
        "stray_lines": 1,
        "stray_head": body.strip(),
    }


async def test_a_done_only_stream_still_counts_its_one_line(owner_client, pool, mount_peers):
    mount_peers(gateway=FakeGateway(deltas=()), memory=FakeMemory())
    await _set_model(owner_client)

    await _say(owner_client)

    (statement,) = await _assistant_rows(pool)
    assert "1 data line(s), [DONE] seen" in statement
    (span,) = await _llm_spans(pool)
    assert span["meta"]["error_class"] == chat.EMPTY_ROUND
    # A clean [DONE] with no strays is not unusual enough to file counters for.
    assert "stream" not in span["meta"]


# -- the statement itself -------------------------------------------------------


def _span(kind: str, name: str | None, **meta) -> traces.Span:
    from datetime import UTC, datetime

    return traces.Span(kind=kind, name=name, started_at=datetime.now(UTC), duration_ms=1, meta=meta)


def test_the_ran_clause_is_derived_from_tool_spans_and_excludes_refusals():
    spans = [
        _span("llm_call", "m", model="m", round=3, served_by="openai:gpt-x"),
        _span("tool", "get_time", ok=True),
        _span("tool", "workspace_list", ok=False, error="Error: no such dir"),
        _span("tool", "device_run", ok=False, refused_out_of_rounds=True),
        _span("tool", "get_time", ok=True),  # deduped
    ]
    statement = chat.model_failure_statement(model="m", failure="the reason", spans=spans)
    assert statement == (
        "I didn't get a response from m (openai) in round 3: the reason. "
        "Before that, get_time ran and workspace_list failed. "
        f"{chat.RETRY_HINT}"
    )


def test_a_failure_sends_him_to_no_page_at_all():
    """2026-09-09, his words: "I don't want to check the model settings, or
    activity for results. You're AI, you're supposed to know that you should do
    that." Both of the next day's failures sent him to Settings anyway.

    The statement names what he can ASK HER; the pages still exist for when he
    wants them, and a failure message is not the place to send him to do her job.
    """
    spans = [
        _span("llm_call", "m", model="m", round=1),
        _span("tool", "get_time", ok=True),
    ]
    for statement in (
        chat.model_failure_statement(model="m", failure="the reason", spans=spans),
        chat.turn_failure_statement("the reason", spans),
        chat.stopped_statement(stated="he asked to stop it", where="between steps", spans=spans),
    ):
        assert "Settings" not in statement, statement
        assert "Activity" not in statement, statement


def test_the_statement_with_no_model_and_no_spans_still_names_what_is_known():
    statement = chat.model_failure_statement(model="", failure="the reason", spans=[])
    assert statement == (
        f"I didn't get a response from the gateway's default model: the reason. "
        f"Nothing was run. {chat.RETRY_HINT}"
    )


# -- the unplanned path ---------------------------------------------------------


async def test_an_unplanned_failure_before_the_reply_lands_still_leaves_a_statement(
    owner_client, pool, mount_peers, monkeypatch
):
    """A bug in the turn itself (here: the registry blowing up before the
    first round) is not a model failure, and the statement says so in its own
    words — but the owner still gets a reply, not a blank."""
    mount_peers(gateway=FakeGateway(deltas=("fine",)), memory=FakeMemory())
    await _set_model(owner_client)

    def _boom() -> list:
        raise RuntimeError("boom")

    monkeypatch.setattr(chat.tools, "advertised_tools", _boom)
    sent = await _say(owner_client)

    assert await pool.fetchval("SELECT status FROM turns") == "error"
    (statement,) = await _assistant_rows(pool)
    assert statement.startswith(
        "This turn failed before I could answer: the turn failed — RuntimeError: boom"
    )
    assert "Nothing was run." in statement
    assert _errors(sent) == ["the turn failed — RuntimeError: boom"]


async def test_an_unplanned_failure_after_the_reply_landed_does_not_add_a_second_row(
    owner_client, pool, mount_peers, monkeypatch
):
    mount_peers(gateway=FakeGateway(deltas=("fine",)), memory=FakeMemory())
    await _set_model(owner_client)

    def _boom(*args, **kwargs) -> None:
        raise RuntimeError("ingest exploded")

    monkeypatch.setattr(chat, "_queue_ingest", _boom)
    sent = await _say(owner_client)

    assert await pool.fetchval("SELECT status FROM turns") == "error"
    assert await _assistant_rows(pool) == ["fine"]
    assert _errors(sent) == ["the turn failed — RuntimeError: ingest exploded"]
