"""A round that only THOUGHT is marked as such, and a round can name links to pass over.

Measured 2026-10-08 (turns 67f46990, 47885337): dell:qwen3.8:27b streamed
reasoning, then [DONE], with no content and no tool calls; the turn ended
"I didn't get a response". The epic re-asks such a round, then passes the
link over (T3). This file pins what T3 stands on (T2):

- the round's llm_call span says `thinking_only` — derived from the stream's
  counted facts (reasoning > 0, [DONE] seen, no stray lines), never from the
  error text — and nothing else carries the flag;
- `_gateway_round(pass_over=...)` sends X-Nova-Pass-Over in the gateway's
  own encoding (T1's parse_pass_over), only when non-empty, and refuses to
  send one for a turn with no role (an eval, rail 17) rather than drop it.
"""

from __future__ import annotations

import asyncio
import inspect
import json
import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import quote, unquote

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse, StreamingResponse
from starlette.routing import Route

from app import chat, conversations, peers, traces
from app.main import app
from tests.conftest import requires_db
from tests.fakes import FakeMemory
from tests.test_chat_agents import _owner
from tests.test_chat_tools import text, whole_call

DELL = "dell:qwen3.8:27b"
MODEL = "qwen3.8:27b"


def _chunk(**delta) -> str:
    return "data: " + json.dumps({"choices": [{"delta": delta}]}) + "\n\n"


DONE = "data: [DONE]\n\n"


class BodyGateway:
    """A completions endpoint that answers 200 with `body`, stamped as served
    by `served_by`, and keeps every request's headers."""

    def __init__(self, body: str, served_by: str = DELL) -> None:
        self.body = body
        self.served_by = served_by
        self.requests: list[dict[str, str]] = []
        self.app = Starlette(
            routes=[Route("/v1/chat/completions", self._completions, methods=["POST"])]
        )

    async def _completions(self, request):
        self.requests.append({k.lower(): v for k, v in request.headers.items()})

        async def stream():
            yield self.body

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"X-Nova-Served-By": self.served_by},
        )


def _turn(kind: str = "chat") -> traces.Turn:
    # turn.model None: _round_model keeps the asked model (no settings read).
    return traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC), kind=kind)


async def _round(gateway: BodyGateway, mount_peers, *, kind: str = "chat", **kwargs):
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn = _turn(kind)
    text, calls, failure = await chat._gateway_round(
        app,
        turn,
        MODEL,
        [{"role": "user", "content": "hi"}],
        [],
        round_number=1,
        on_delta=None,
        **kwargs,
    )
    (span,) = [s for s in turn.spans if s.kind == "llm_call"]
    return turn, text, calls, failure, span


# The gateway's parse_pass_over, mirrored: core cannot import the gateway's
# `app` package (every service has a top-level `app`). Same steps: split ',',
# partition '=', strict percent-decode, a stray '%' refused.
_BAD_ESCAPE = re.compile(r"%(?![0-9A-Fa-f]{2})")


def _gateway_parse(value: str) -> dict[str, str]:
    passed: dict[str, str] = {}
    for pair in value.split(","):
        link, eq, words = pair.strip().partition("=")
        assert eq, pair
        for part in (link, words):
            assert not _BAD_ESCAPE.search(part), part
        passed[unquote(link, errors="strict").strip()] = unquote(words, errors="strict").strip()
    return passed


# -- criterion 1: a thinking-only round is marked -------------------------------


async def test_a_thinking_only_round_is_marked_on_its_span(mount_peers):
    thought = "Let me think about the files. " * 4
    gateway = BodyGateway(_chunk(reasoning=thought) + DONE)

    _, text, calls, failure, span = await _round(gateway, mount_peers)

    # The failure is stated exactly as today...
    assert text == "" and calls == []
    assert failure is not None
    assert failure.startswith("the model spent the whole round thinking and never answered")
    assert "[DONE] seen" in failure
    # ...and the span carries the live shape plus the flag T3 reads.
    assert span.meta["error_class"] == chat.EMPTY_ROUND
    assert span.meta["reasoning_chars"] == len(thought)
    assert span.meta["served_by"] == DELL
    assert span.meta["thinking_only"] is True


# -- criterion 2: nothing else carries the flag (guards) ------------------------


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(DONE, id="empty-no-reasoning"),
        pytest.param(_chunk(reasoning="hmm"), id="reasoning-no-done"),
        pytest.param(_chunk(reasoning="hmm") + '{"error":"x"}\n' + DONE, id="reasoning-stray"),
        pytest.param(_chunk(reasoning="hmm") + _chunk(content="Here.") + DONE, id="answered"),
        pytest.param(
            _chunk(reasoning="hmm")
            + _chunk(
                tool_calls=[
                    {
                        "index": 0,
                        "id": "c1",
                        "type": "function",
                        "function": {"name": "workspace_list", "arguments": "{}"},
                    }
                ]
            )
            + DONE,
            id="called-a-tool",
        ),
    ],
)
async def test_no_other_round_shape_is_marked_thinking_only(mount_peers, body):
    _, _, _, _, span = await _round(BodyGateway(body), mount_peers)

    assert "thinking_only" not in span.meta


# -- criterion 3: the pass-over header, in the gateway's encoding ---------------


def test_the_pass_over_encoding_round_trips_through_the_gateways_parser():
    pass_over = {
        DELL: "thinking only twice",
        "openrouter:google/gemini-3.8-flash": "a, b = c; d/e — naïve",
    }

    value = peers.pass_over_header(pass_over)

    assert value.isascii()
    assert _gateway_parse(value) == pass_over
    assert value == ",".join(
        f"{quote(k, safe='')}={quote(v, safe='')}" for k, v in pass_over.items()
    )


async def test_a_pass_over_is_sent_as_its_header_beside_the_role(mount_peers):
    pass_over = {DELL: "thinking only twice; a=b, c"}
    gateway = BodyGateway(_chunk(content="Hi.") + DONE)

    turn, _, _, failure, _ = await _round(gateway, mount_peers, pass_over=pass_over)

    assert failure is None
    (headers,) = gateway.requests
    assert "x-nova-pass-over" in headers
    assert headers["x-nova-pass-over"].isascii()
    assert _gateway_parse(headers["x-nova-pass-over"]) == pass_over
    assert headers["x-nova-role"] == "chat"
    assert headers["x-nova-turn-id"] == str(turn.id)


# -- criterion 4: no pass-over, no header (guard) -------------------------------


@pytest.mark.parametrize("pass_over", [None, {}], ids=["none", "empty"])
async def test_no_pass_over_sends_exactly_todays_headers(mount_peers, pass_over):
    gateway = BodyGateway(_chunk(content="Hi.") + DONE)

    turn, _, _, _, _ = await _round(gateway, mount_peers, pass_over=pass_over)

    (headers,) = gateway.requests
    assert "x-nova-pass-over" not in headers
    sent = {k: v for k, v in headers.items() if k.startswith("x-nova-")}
    expected = {k.lower(): v for k, v in peers.attribution_headers(turn, "chat", "chat").items()}
    assert sent == expected


# -- criterion 5: no role, no pass-over — refused before the gateway ------------


async def test_a_pass_over_on_a_turn_with_no_role_is_refused_before_any_request(mount_peers):
    gateway = BodyGateway(_chunk(content="Hi.") + DONE)
    mount_peers(gateway=gateway, memory=FakeMemory())
    turn = _turn("eval")
    assert chat._role_of(turn) is None

    with pytest.raises(ValueError, match="role"):
        await chat._gateway_round(
            app,
            turn,
            MODEL,
            [{"role": "user", "content": "hi"}],
            [],
            round_number=1,
            on_delta=None,
            pass_over={DELL: "thinking only twice"},
        )

    assert gateway.requests == []


async def test_an_explicit_role_lets_a_pass_over_through_on_a_roleless_turn(mount_peers):
    """'Has a role' is the role the round resolves: an explicit role kwarg
    counts even when the turn's own kind has none."""
    pass_over = {DELL: "thinking only twice"}
    gateway = BodyGateway(_chunk(content="Hi.") + DONE)

    _, _, _, failure, _ = await _round(
        gateway, mount_peers, kind="eval", role="chat", pass_over=pass_over
    )

    assert failure is None
    (headers,) = gateway.requests
    assert headers["x-nova-role"] == "chat"
    assert _gateway_parse(headers["x-nova-pass-over"]) == pass_over


async def test_an_empty_pass_over_on_a_turn_with_no_role_is_not_refused(mount_peers):
    """Only a pass-over that would be dropped is refused; an eval round with
    none runs exactly as today (guard)."""
    gateway = BodyGateway(_chunk(content="Hi.") + DONE)

    _, text, _, failure, _ = await _round(gateway, mount_peers, kind="eval", pass_over={})

    assert (text, failure) == ("Hi.", None)
    (headers,) = gateway.requests
    assert "x-nova-role" not in headers and "x-nova-pass-over" not in headers


# -- criterion 6: the empty-round statement is unchanged (guard) ----------------


async def test_the_empty_round_statement_is_unchanged(mount_peers):
    _, _, _, failure, span = await _round(BodyGateway(DONE), mount_peers)

    assert failure is not None
    assert re.fullmatch(
        r"the stream ended after \d+\.\d s with no content and no tool calls "
        r"\(1 data line\(s\), \[DONE\] seen\)",
        failure,
    )
    assert span.meta["error"] == failure
    assert span.meta["error_class"] == chat.EMPTY_ROUND


# =============================================================================
# T3: the turn loop re-asks a thinking-only round, then passes its link over.
#
# Driven through chat._run_turn itself (the one turn loop) against a gateway
# that plays one scripted answer per request, records each request's headers
# and body, and stamps X-Nova-Served-By / X-Nova-Route the way the real one
# does. Re-ask is per link; a pass-over only grows within a round and resets
# with the next one; the exit when no link is left is ONE stated ending.
# =============================================================================

HUB = "hub:qwen3:8b"
REASON = "every link in the chain answered with thinking only"
PASS_OVER_WORDS = "answered with thinking only"
NO_REPLY = "I didn't get a response"
GATEWAY_503 = (
    "nothing in the chat chain is runnable: dell:qwen3.8:27b passed over; hub:qwen3:8b passed over"
)


@dataclass
class Answer:
    """One scripted gateway answer: an SSE body (chunk payloads, then
    [DONE]) stamped as served by `served_by` at chain link `link`, or a
    refusal `status` with the gateway's `words`."""

    chunks: tuple = ()
    served_by: str = DELL
    link: int = 1
    status: int = 200
    words: str = ""


def _think(served_by: str = DELL, link: int = 1) -> Answer:
    return Answer(
        chunks=({"choices": [{"delta": {"reasoning": "Let me think."}}]},),
        served_by=served_by,
        link=link,
    )


def _say_text(words: str, served_by: str = DELL, link: int = 1) -> Answer:
    return Answer(chunks=(text(words),), served_by=served_by, link=link)


def _call_time(call_id: str = "c1", served_by: str = DELL, link: int = 1) -> Answer:
    return Answer(chunks=(whole_call(call_id, "get_time", {}),), served_by=served_by, link=link)


class ChainGateway:
    """Plays `script` one answer per /v1/chat/completions request; running
    past its end is a loud 500 so a loop that asks more than the test
    expects fails it."""

    def __init__(self, *script: Answer, forever: Answer | None = None) -> None:
        self.script = list(script)
        # Played for every request past the script, without end: a gateway
        # that keeps serving the same link (T1's no-chain path ignores the
        # pass-over), so only core can stop the walk.
        self.forever = forever
        self.requests: list[tuple[dict[str, str], dict]] = []
        self.app = Starlette(
            routes=[Route("/v1/chat/completions", self._completions, methods=["POST"])]
        )

    @property
    def headers(self) -> list[dict[str, str]]:
        return [h for h, _ in self.requests]

    @property
    def bodies(self) -> list[dict]:
        return [b for _, b in self.requests]

    def pass_overs(self) -> list[dict[str, str] | None]:
        return [
            _gateway_parse(h["x-nova-pass-over"]) if "x-nova-pass-over" in h else None
            for h in self.headers
        ]

    async def _completions(self, request):
        body = json.loads(await request.body())
        self.requests.append(({k.lower(): v for k, v in request.headers.items()}, body))
        index = len(self.requests) - 1
        if index >= len(self.script) and self.forever is None:
            return JSONResponse(
                {"error": {"message": f"the test script has no answer {index + 1}"}},
                status_code=500,
            )
        answer = self.script[index] if index < len(self.script) else self.forever
        if answer.status != 200:
            return JSONResponse({"error": {"message": answer.words}}, status_code=answer.status)
        headers = {
            "X-Nova-Route": f"role=chat;link={answer.link};reason="
            + quote(f"link {answer.link} served")
        }
        if answer.served_by:
            headers["X-Nova-Served-By"] = answer.served_by

        async def stream():
            for chunk in answer.chunks:
                yield "data: " + json.dumps(chunk) + "\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(stream(), media_type="text/event-stream", headers=headers)


@dataclass
class Ran:
    turn: traces.Turn
    frames: list
    events: list[tuple[str, str]]
    status: str
    rows: list[str]

    @property
    def errors(self) -> list[str]:
        return [f["error"] for f in self.frames if isinstance(f, dict) and "error" in f]

    def spans(self, kind: str) -> list[traces.Span]:
        return [s for s in self.turn.spans if s.kind == kind]

    def retries(self) -> list[dict]:
        return [s.meta for s in self.spans("round_retry")]


def _decode(frame: str | None):
    if frame is None:
        return None
    payload = frame.strip()[len("data: ") :]
    return payload if payload == "[DONE]" else json.loads(payload)


async def _run(pool, mount_peers, monkeypatch, gateway: ChainGateway, *, kind: str = "chat") -> Ran:
    mount_peers(gateway=gateway, memory=FakeMemory())
    owner = await _owner(pool)
    conversation = await conversations.active_conversation(pool, owner)
    turn = await traces.open_turn(
        pool, kind=kind, conversation_id=conversation["id"], model=MODEL, person_id=owner.id
    )
    events: list[tuple[str, str]] = []
    real_persist = chat._persist_assistant

    async def persist(pool_, conversation_id, text_, turn_id=None):
        events.append(("persist", text_))
        await real_persist(pool_, conversation_id, text_, turn_id)

    monkeypatch.setattr(chat, "_persist_assistant", persist)
    frames: list = []

    def emit(frame):
        decoded = _decode(frame)
        frames.append(decoded)
        if isinstance(decoded, dict) and "error" in decoded:
            events.append(("error", decoded["error"]))

    kwargs: dict = {}
    if "max_tool_rounds" in inspect.signature(chat._run_turn).parameters:
        kwargs["max_tool_rounds"] = 10
    before = set(chat._BACKGROUND)
    await chat._run_turn(
        app,
        pool,
        turn,
        owner,
        conversation["id"],
        "what time is it",
        [],
        MODEL,
        emit=emit,
        **kwargs,
    )
    await chat.settle_detached(before)
    status = await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id)
    rows = [
        r["content"]
        for r in await pool.fetch(
            "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at"
        )
    ]
    return Ran(turn=turn, frames=frames, events=events, status=status, rows=rows)


def _assert_one_stated_exit(ran: Ran) -> str:
    """The every-link-thinking-only exit: status error, ONE assistant row,
    the same words as the ONE error frame, persisted before it was emitted,
    and never the generic no-response statement."""
    assert ran.status == "error"
    (row,) = ran.rows
    (error,) = ran.errors
    assert row == error
    persisted = [i for i, (what, _) in enumerate(ran.events) if what == "persist"]
    emitted = [i for i, (what, _) in enumerate(ran.events) if what == "error"]
    assert len(persisted) == 1 and len(emitted) == 1 and persisted[0] < emitted[0]
    assert NO_REPLY not in row
    assert REASON in row
    return row


# -- T3 criterion 1: re-ask once, same request ---------------------------------


@requires_db
async def test_a_thinking_only_round_is_re_asked_once_with_the_same_request(
    pool, mount_peers, monkeypatch
):
    gateway = ChainGateway(_think(), _say_text("It is noon."))

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert len(gateway.requests) == 2
    first, second = gateway.bodies
    assert second["model"] == first["model"]
    assert second["messages"] == first["messages"]
    assert gateway.pass_overs() == [None, None]
    assert ran.retries() == [{"why": "thinking_only", "action": "reask", "link": DELL, "round": 1}]
    assert ran.status == "ok"
    assert ran.rows == ["It is noon."]
    assert ran.errors == []


# -- T3 criterion 2: thinking-only twice -> the link is passed over -------------


@requires_db
async def test_a_link_thinking_only_twice_is_passed_over_and_the_next_link_answers(
    pool, mount_peers, monkeypatch
):
    gateway = ChainGateway(_think(), _think(), _say_text("It is noon.", served_by=HUB, link=2))

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert gateway.pass_overs() == [None, None, {DELL: PASS_OVER_WORDS}]
    assert [(m["action"], m["link"]) for m in ran.retries()] == [
        ("reask", DELL),
        ("pass_over", DELL),
    ]
    assert all(m["why"] == "thinking_only" and m["round"] == 1 for m in ran.retries())
    # Each attempt is its own llm_call span; the thinking-only ones stay as evidence.
    llm = ran.spans("llm_call")
    assert len(llm) == 3
    assert [s.meta.get("thinking_only") for s in llm] == [True, True, None]
    assert ran.status == "ok"
    assert ran.rows == ["It is noon."]
    routes = [f["route"] for f in ran.frames if isinstance(f, dict) and "route" in f]
    assert len(routes) == 1 and routes[0]["served_by"] == HUB and routes[0]["link"] == 2


# -- T3 criterion 3: every link thinking-only -> one stated exit ----------------


@requires_db
async def test_every_link_thinking_only_ends_the_turn_with_what_the_tools_found(
    pool, mount_peers, monkeypatch
):
    gateway = ChainGateway(
        _call_time(),
        _think(),
        _think(),
        _think(served_by=HUB, link=2),
        _think(served_by=HUB, link=2),
        Answer(status=503, words=GATEWAY_503),
    )

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert gateway.pass_overs() == [
        None,
        None,
        None,
        {DELL: PASS_OVER_WORDS},
        {DELL: PASS_OVER_WORDS},
        {DELL: PASS_OVER_WORDS, HUB: PASS_OVER_WORDS},
    ]
    assert [(m["action"], m["link"], m["round"]) for m in ran.retries()] == [
        ("reask", DELL, 2),
        ("pass_over", DELL, 2),
        ("reask", HUB, 2),
        ("pass_over", HUB, 2),
    ]
    row = _assert_one_stated_exit(ran)
    statement = chat.tool_results_statement(ran.turn.spans)
    assert statement is not None
    assert row.startswith(statement + "\n\n")
    assert f"{REASON}: {DELL}, {HUB}" in row
    assert GATEWAY_503 in row


# -- T3 criterion 4: no loop when the chain cannot move ------------------------


@requires_db
async def test_a_link_served_again_after_its_pass_over_ends_the_turn(
    pool, mount_peers, monkeypatch
):
    gateway = ChainGateway(_think(), _think(), _think())

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert len(gateway.requests) == 3
    assert gateway.pass_overs() == [None, None, {DELL: PASS_OVER_WORDS}]
    row = _assert_one_stated_exit(ran)
    assert f"{REASON}: {DELL}" in row
    assert "the gateway served it again after it was passed over" in row


@pytest.mark.parametrize(
    ("script", "expected_requests", "links"),
    [
        pytest.param((), 3, [DELL], id="one-link"),
        pytest.param(
            (_think(), _think(), _think(served_by=HUB, link=2), _think(served_by=HUB, link=2)),
            5,
            [DELL, HUB],
            id="after-two-links",
        ),
    ],
)
@requires_db
async def test_a_gateway_that_keeps_serving_a_passed_over_link_never_loops(
    pool, mount_peers, monkeypatch, script, expected_requests, links
):
    """No infinite loop: the gateway serves an already-passed-over link
    thinking-only on EVERY request, without end. Core stops by itself on the
    first repeat — the pass-over map only grows, so this is mechanical, not a
    count — and the timeout turns a hang into a failure instead of a stuck run."""
    gateway = ChainGateway(*script, forever=_think())

    ran = await asyncio.wait_for(_run(pool, mount_peers, monkeypatch, gateway), timeout=30)

    assert len(gateway.requests) == expected_requests
    row = _assert_one_stated_exit(ran)
    assert f"{REASON}: {', '.join(links)} — " in row
    assert "the gateway served it again after it was passed over" in row
    # No tool ran, so the exit is the stated reason alone — nothing in front.
    assert row.startswith("Stopped: ")


@requires_db
async def test_a_thinking_only_round_with_no_served_by_is_re_asked_then_ends_stated(
    pool, mount_peers, monkeypatch
):
    gateway = ChainGateway(_think(served_by=""), _think(served_by=""))

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert len(gateway.requests) == 2
    assert gateway.pass_overs() == [None, None]
    assert [m["action"] for m in ran.retries()] == ["reask"]
    _assert_one_stated_exit(ran)


@requires_db
async def test_a_thinking_only_eval_round_is_re_asked_then_ends_stated_without_a_pass_over(
    pool, mount_peers, monkeypatch
):
    gateway = ChainGateway(_think(), _think())

    ran = await _run(pool, mount_peers, monkeypatch, gateway, kind="eval")

    assert len(gateway.requests) == 2
    assert all("x-nova-role" not in h for h in gateway.headers)
    assert gateway.pass_overs() == [None, None]
    assert [m["action"] for m in ran.retries()] == ["reask"]
    _assert_one_stated_exit(ran)


# -- T3 criterion 5: per round, and nothing else changes -----------------------


@requires_db
async def test_the_pass_over_resets_with_the_next_round(pool, mount_peers, monkeypatch):
    gateway = ChainGateway(
        _think(),
        _think(),
        _call_time(served_by=HUB, link=2),
        _say_text("It is noon."),
    )

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert gateway.pass_overs() == [None, None, {DELL: PASS_OVER_WORDS}, None]
    assert ran.status == "ok"
    assert ran.rows == ["It is noon."]
    assert all(set(m) >= {"why", "action", "link", "round"} for m in ran.retries())


@requires_db
async def test_a_refusal_on_the_re_ask_ends_the_turn_as_today(pool, mount_peers, monkeypatch):
    gateway = ChainGateway(_think(), Answer(status=500, words="upstream fell over"))

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert len(gateway.requests) == 2
    assert ran.status == "error"
    (row,) = ran.rows
    assert row == ran.errors[0]
    assert row.startswith(NO_REPLY)
    assert "(500)" in row and "upstream fell over" in row
    assert REASON not in row


@requires_db
async def test_a_non_503_refusal_after_a_pass_over_ends_the_turn_as_today(
    pool, mount_peers, monkeypatch
):
    """Only a 503 answering a pass-over means the chain ran out; any other
    refusal on that attempt is today's failure, stated as today."""
    gateway = ChainGateway(_think(), _think(), Answer(status=500, words="upstream fell over"))

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert gateway.pass_overs() == [None, None, {DELL: PASS_OVER_WORDS}]
    assert ran.status == "error"
    (row,) = ran.rows
    assert row == ran.errors[0]
    assert row.startswith(NO_REPLY)
    assert "upstream fell over" in row
    assert REASON not in row


@requires_db
async def test_an_empty_re_ask_with_no_reasoning_ends_the_turn_as_today(
    pool, mount_peers, monkeypatch
):
    gateway = ChainGateway(_think(), Answer())

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert len(gateway.requests) == 2
    assert ran.status == "error"
    (row,) = ran.rows
    assert row.startswith(NO_REPLY) and "no content and no tool calls" in row
    assert REASON not in row


@pytest.mark.parametrize(
    "first",
    [
        pytest.param(Answer(), id="empty-no-reasoning"),
        pytest.param(Answer(status=503, words=GATEWAY_503), id="503-with-no-pass-over-sent"),
    ],
)
@requires_db
async def test_a_first_attempt_that_is_not_thinking_only_ends_the_turn_as_today(
    pool, mount_peers, monkeypatch, first
):
    """Guard: only a thinking-only round is re-asked; a 503 that answered no
    pass-over is today's exit, unchanged."""
    gateway = ChainGateway(first)

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert len(gateway.requests) == 1
    assert ran.status == "error"
    assert ran.retries() == []
    (row,) = ran.rows
    assert row.startswith(NO_REPLY)
    assert REASON not in row


# -- no-ceiling T4 criterion 3: the owner's stop still ends a re-asking turn ----


class StopPressingGateway(ChainGateway):
    """Answers like ChainGateway, and the owner presses Stop while its first
    answer is on the wire — so the stop is seen at the re-ask boundary."""

    async def _completions(self, request):
        response = await super()._completions(request)
        if len(self.requests) == 1:
            # What the stop route records (traces.ask_to_stop), written
            # directly: this harness runs _run_turn without the chat route,
            # so the turn is not in INFLIGHT. _run_turn's finally clears it.
            turn_id = uuid.UUID(self.headers[0]["x-nova-turn-id"])
            traces.STOPPING.setdefault(turn_id, "he pressed Stop")
        return response


@requires_db
async def test_the_owners_stop_ends_the_turn_between_thinking_only_re_asks(
    pool, mount_peers, monkeypatch
):
    """C3 (T3 survivor): a stop asked while a thinking-only round is in flight
    is honoured before its re-ask: one request, never a second, and the turn
    ends `stopped`, not error and not re-asked."""
    gateway = StopPressingGateway(_think(), _say_text("must never be asked"))

    ran = await _run(pool, mount_peers, monkeypatch, gateway)

    assert len(gateway.requests) == 1
    assert ran.status == "stopped"
    assert "must never be asked" not in "".join(ran.rows)
