"""verification-2-7 T26: a turn past its token budget ends between rounds, on a
stated note.

The verification report (2026-10-13, item 2): a turn had no hard bound. The
worst real turn (30 d of live turn_spans) spent 4,156,412 tokens over 51 rounds,
its largest single prompt 151,253; the next worst spent 772,035, the p99 turn
241,350. T25 bounds a turn's wall-clock seconds; this bounds its tokens — a
setting (`turns.token_budget`, default 1,000,000), the prompt and completion
tokens every round of the turn reported, summed, and checked where the circling
and time-budget stops are checked: after a round's tools have all run. Past it
the turn ends the same way — a `round_stop` span, one toolless narration round,
a note that states why — never mid-tool, never discarding an answer, never
asking the owner anything (no-approvals.md), never a count of rounds.

A round that reports no usage is not counted as nothing: its tokens are core's
estimate of what it sent and wrote, and the note says so (C6).

Usage reaches core as the gateway's synthetic chunk ({"choices": [], "usage":
{...}}); each scripted round here carries one, or deliberately none.
"""

from __future__ import annotations

import dataclasses
import json
import math
import re

import pytest

from app import chat, context_fit, settings_store, tools
from app.tools.base import Tool
from tests.conftest import requires_db
from tests.fakes import FakeMemory, ScriptedGateway
from tests.test_chat_agents import SUBSET, _agent_turn, _calls, _create, _reply
from tests.test_chat_agents import _owner as _agent_owner
from tests.test_chat_tools import _say, whole_call
from tests.test_chat_tools import text as text_delta
from tests.test_turn_progress import (
    PROBE,
    PROBE_SCHEMA,
    PROSE,
    _arm_probe,
    _narration_held,
    _spans_of,
    _stops,
    _stored,
    _texts,
)

BUDGET_KEY = "turns.token_budget"
DEFAULT_BUDGET = 1_000_000
MIN_BUDGET, MAX_BUDGET = 10_000, 100_000_000
TOKEN_BUDGET = "token_budget"
APPROVAL_WORDS = ("approve", "allow", "permission", "confirm", "would you like", "should i")
# What the stop must never say: it did not circle, it is not the time budget,
# and no model failed.
UNTRUE_WORDS = ("circl", "repeated", "time budget", "failed", "the model couldn", "try again")


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


@pytest.fixture(autouse=True)
def fresh_link_facts(monkeypatch):
    """What chat.py learned about a served link (window, chars-per-token) lives
    in process memory across tests; these tests read the ratio a turn used, so
    each starts with none learned, and none leaks out."""
    monkeypatch.setattr(chat, "_SERVED_CHARS_PER_TOKEN", {})
    monkeypatch.setattr(chat, "_SERVED_WINDOWS", {})
    monkeypatch.setattr(chat, "_SERVED_LINK_BY_REQUEST", {})


def _usage(prompt: int | None, completion: int | None) -> dict:
    """The gateway's usage chunk as core reads it (S10)."""
    return {
        "choices": [],
        "usage": {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "local": True,
            "metered": prompt is not None and completion is not None,
            "recorded": True,
        },
    }


def _probe_round(i: int, q: str, prompt: int | None = None, completion: int | None = None):
    """One tool round asking for the probe; with usage when given."""
    call = whole_call(f"c{i}", PROBE, {"q": q})
    return (call,) if prompt is None and completion is None else (call, _usage(prompt, completion))


def _answer(text: str, prompt: int | None = None, completion: int | None = None) -> tuple:
    chunk = text_delta(text)
    return (chunk,) if prompt is None else (chunk, _usage(prompt, completion))


def _stated(n: int, text: str) -> bool:
    """The number stated as a whole number, plain or comma-grouped, never as
    part of a longer number."""
    return any(
        re.search(rf"(?<![\d,.]){re.escape(form)}(?![\d,]|\.\d)", text)
        for form in {str(n), f"{n:,}"}
    )


def _budget_note(stored: str, *, rounds: int, budget: int, spent: int) -> str:
    note = stored.rsplit("\n\n", 1)[-1]
    assert note.startswith(f"[stopped after {rounds} tool rounds: "), stored
    assert note.endswith("]"), stored
    assert _stated(spent, note), f"the note does not state the tokens spent {spent}: {note!r}"
    assert _stated(budget, note), f"the note does not state the budget {budget}: {note!r}"
    assert BUDGET_KEY in note, f"the note does not name {BUDGET_KEY}: {note!r}"
    lowered = note.lower()
    assert [w for w in UNTRUE_WORDS if w in lowered] == [], note
    return note


def _token_stop(stops: list[dict], *, rounds: int, budget: int) -> dict:
    """The one round_stop, token_budget, with every fact an int and the sum
    adding up; returned so the caller can pin the figures."""
    assert len(stops) == 1, stops
    stop = stops[0]
    assert stop.get("reason") == TOKEN_BUDGET, stop
    for key in (
        "rounds",
        "budget_tokens",
        "spent_tokens",
        "prompt_tokens",
        "completion_tokens",
        "estimated_rounds",
    ):
        assert type(stop.get(key)) is int, (key, stop)
    assert stop["rounds"] == rounds, stop
    assert stop["budget_tokens"] == budget, stop
    assert stop["spent_tokens"] == stop["prompt_tokens"] + stop["completion_tokens"], stop
    assert stop["spent_tokens"] >= budget, stop
    return stop


def _asks_nothing(text: str) -> None:
    assert "?" not in text, text
    lowered = text.lower()
    assert [w for w in APPROVAL_WORDS if w in lowered] == [], text


async def _put_budget(client, value) -> None:
    resp = await client.put("/api/v1/settings", json={"key": BUDGET_KEY, "value": value})
    assert resp.status_code == 200, resp.text


def _sent_estimate(payload: dict, ratio: float) -> int:
    """Core's own estimate of a request the gateway received: its messages and
    its tools array, at `ratio` chars per token."""
    return context_fit.estimate_tokens(
        payload["messages"], ratio, context_fit.tools_chars(payload.get("tools") or None)
    )


# -- C1: a setting, listed and bounded; a named stop reason ------------------------


@requires_db
async def test_v27_t26_c1_the_budget_is_a_listed_setting_with_its_default(owner_client):
    resp = await owner_client.get("/api/v1/settings")
    assert resp.status_code == 200, resp.text
    items = {item["key"]: item for item in resp.json()["settings"]}
    assert BUDGET_KEY in items, sorted(items)
    item = items[BUDGET_KEY]
    assert item["type"] == "int"
    assert item["default"] == DEFAULT_BUDGET
    assert item["value"] == DEFAULT_BUDGET
    described = item["description"].lower()
    for fact in ("token", "prompt", "completion", "between rounds", "estimate"):
        assert fact in described, (fact, item["description"])
    assert settings_store.DEFS_BY_KEY[BUDGET_KEY].validate is not None


@requires_db
async def test_v27_t26_c1_the_budget_is_bounded_at_the_write(owner_client, pool):
    await _put_budget(owner_client, 250_000)
    assert await pool.fetchval("SELECT value FROM settings WHERE key = $1", BUDGET_KEY) == 250_000

    for bad, named in ((MIN_BUDGET - 1, str(MIN_BUDGET)), (MAX_BUDGET + 1, str(MAX_BUDGET))):
        resp = await owner_client.put("/api/v1/settings", json={"key": BUDGET_KEY, "value": bad})
        assert resp.status_code == 400, resp.text
        assert named in resp.json()["error"], resp.text
    resp = await owner_client.put("/api/v1/settings", json={"key": BUDGET_KEY, "value": True})
    assert resp.status_code == 400, resp.text
    assert await pool.fetchval("SELECT value FROM settings WHERE key = $1", BUDGET_KEY) == 250_000


@pytest.mark.parametrize("value", [MIN_BUDGET, DEFAULT_BUDGET, MAX_BUDGET])
def test_v27_t26_c1_the_bounds_and_default_are_accepted(value):
    definition = settings_store.validated(BUDGET_KEY, value)
    assert definition.default == DEFAULT_BUDGET


def test_v27_t26_c1_the_stop_has_its_own_reason_and_is_not_a_circling_one():
    assert getattr(chat, "STOP_TOKEN_BUDGET", None) == TOKEN_BUDGET
    assert chat.STOP_TOKEN_BUDGET in chat.ROUND_STOP_REASONS
    assert chat.STOP_TOKEN_BUDGET not in chat.CIRCLING_NOTE_WORDS
    assert chat.STOP_TOKEN_BUDGET != chat.STOP_TIME_BUDGET


# -- C2: summed from each round's usage; past it, the turn ends after that round ----


@requires_db
async def test_v27_t26_c2_a_turn_past_its_budget_ends_after_that_rounds_tools_with_a_note(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Each tool round reports 100,000 prompt + 2,000 completion tokens. Under
    300,000 the turn has spent 306,000 when round 3's tool returns, so round 3
    is the last tool round. Without the budget the script's 4th round would be
    her plain answer and nothing would stop."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    gateway = ScriptedGateway(
        rounds=(
            _probe_round(1, "a", 100_000, 2_000),
            _probe_round(2, "b", 100_000, 2_000),
            _probe_round(3, "c", 100_000, 2_000),
            _answer(PROSE),
            _probe_round(5, "d", 100_000, 2_000),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, 300_000)

    sent = await _say(owner_client, "find it")

    assert ran == ["a", "b", "c"]
    await _narration_held(pool, gateway, tool_rounds=3)
    stop = _token_stop(_stops(await _spans_of(pool)), rounds=3, budget=300_000)
    assert (stop["prompt_tokens"], stop["completion_tokens"]) == (300_000, 6_000)
    assert (stop["spent_tokens"], stop["estimated_rounds"]) == (306_000, 0)
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=3, budget=300_000, spent=306_000)
    assert "estimated" not in note, note
    assert stored == f"{PROSE}\n\n{note}"
    assert "".join(_texts(sent)) == stored
    # ci-event-gaps T2: she answered, so no no_answer span.
    assert [s for s in await _spans_of(pool) if s.kind == "no_answer"] == []


@requires_db
async def test_v27_t26_c2_every_call_of_the_crossing_round_runs_and_reaches_narration(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Round 1 asks for two calls and reports 320,000 tokens, over 300,000:
    both calls still run, both results reach the narration request, and the
    turn stops after round 1."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} finished")
    gateway = ScriptedGateway(
        rounds=(
            (
                _calls(("c1", PROBE, {"q": "one"}), ("c2", PROBE, {"q": "two"})),
                _usage(300_000, 20_000),
            ),
            _answer(PROSE),
            _probe_round(3, "later", 1_000, 10),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, 300_000)

    await _say(owner_client, "do both")

    assert ran == ["one", "two"]
    await _narration_held(pool, gateway, tool_rounds=1)
    results = [m["content"] for m in gateway.payloads[1]["messages"] if m.get("role") == "tool"]
    assert results == ["one finished", "two finished"]
    stop = _token_stop(_stops(await _spans_of(pool)), rounds=1, budget=300_000)
    assert stop["spent_tokens"] == 320_000
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{_budget_note(stored, rounds=1, budget=300_000, spent=320_000)}"


@requires_db
async def test_v27_t26_c2_an_agent_turn_past_its_budget_stops_the_same_way(
    pool, mount_peers, workspace, monkeypatch
):
    owner = await _agent_owner(pool)
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    agent = await _create(pool, mount_peers, tools=(*SUBSET, PROBE))
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        BUDGET_KEY,
        "300000",
    )
    gateway = ScriptedGateway(
        rounds=(
            _probe_round(1, "a", 100_000, 2_000),
            _probe_round(2, "b", 100_000, 2_000),
            _probe_round(3, "c", 100_000, 2_000),
            (),
            _probe_round(5, "d", 100_000, 2_000),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "find them")

    assert ran == ["a", "b", "c"]
    assert gateway.calls == 4
    stop = _token_stop(_stops(turn.spans), rounds=3, budget=300_000)
    # ci-event-gaps T2: the narration said nothing; the trace names the stop.
    (no_answer,) = [dict(s.meta) for s in turn.spans if s.kind == "no_answer"]
    assert no_answer == {
        "reason": TOKEN_BUDGET,
        "words": chat._budget_note_words(TOKEN_BUDGET, stop),
    }
    statement = chat.tool_results_statement(turn.spans)
    assert isinstance(statement, str)
    reply = await _reply(pool, turn.id)
    assert reply == f"{statement}\n\n{_budget_note(reply, rounds=3, budget=300_000, spent=306_000)}"
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"


# -- C3: every string the stop emits is true, and it asks nothing --------------------


@requires_db
async def test_v27_t26_c3_the_narration_round_is_told_the_true_reason_and_its_call_is_refused(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """The narration round's nudge and the refusal of a call it asks for anyway
    say the turn spent its token budget — not that it went in circles or ran
    out of time. The call is not dispatched; the reply is the statement of what
    the tools returned, then the note; no gateway call follows."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    gateway = ScriptedGateway(
        rounds=(
            _probe_round(1, "a", 100_000, 2_000),
            _probe_round(2, "b", 100_000, 2_000),
            _probe_round(3, "c", 100_000, 2_000),
            (whole_call("c9", PROBE, {"q": "more"}),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, 300_000)

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "find it"})
    assert resp.status_code == 200, resp.text

    assert ran == ["a", "b", "c"]
    await _narration_held(pool, gateway, tool_rounds=3, refused=1)
    nudge = gateway.payloads[3]["messages"][-1]
    assert nudge["role"] == "system", nudge
    said = nudge["content"].lower()
    assert "token budget" in said, nudge["content"]
    assert [w for w in UNTRUE_WORDS if w in said] == [], nudge["content"]
    _asks_nothing(nudge["content"])
    spans = await _spans_of(pool)
    (refused,) = [s for s in spans if s.kind == "tool" and s.meta.get("refused_out_of_rounds")]
    head = refused.meta["result_head"]
    assert head.startswith(tools.ERROR_PREFIX), head
    assert "token budget" in head.lower(), head
    assert [w for w in UNTRUE_WORDS if w in head.lower()] == [], head
    stored = await _stored(pool)
    statement = chat.tool_results_statement(spans)
    note = _budget_note(stored, rounds=3, budget=300_000, spent=306_000)
    assert stored == f"{statement}\n\n{note}"
    _asks_nothing(note)
    assert chat.RETRY_HINT not in stored
    assert "consent" not in resp.text.lower()


@requires_db
async def test_v27_t26_c3_the_narration_rounds_log_line_names_the_token_budget_stop(
    owner_client, pool, mount_peers, workspace, monkeypatch, caplog
):
    """The narration round fails (the script has no 4th round): its log line
    names the token-budget stop, and no log line calls it the circling stop."""
    _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    gateway = ScriptedGateway(
        rounds=(
            _probe_round(1, "a", 100_000, 2_000),
            _probe_round(2, "b", 100_000, 2_000),
            _probe_round(3, "c", 100_000, 2_000),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, 300_000)

    await _say(owner_client, "find it")

    _token_stop(_stops(await _spans_of(pool)), rounds=3, budget=300_000)
    messages = [r.getMessage() for r in caplog.records]
    assert [m for m in messages if "circling" in m.lower()] == [], messages
    narration_lines = [m for m in messages if "narration round" in m]
    assert narration_lines, messages
    for line in narration_lines:
        assert re.search(r"token[- ]budget", line), line
        assert "time-budget" not in line and "time budget" not in line, line


# -- C4: never discards an answer; per turn; read at each turn's start --------------


@requires_db
async def test_v27_t26_c4_an_answer_is_kept_and_the_sum_restarts_each_turn(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Under 300,000: a round that answers with no tool calls is the reply even
    though it alone reported 400,000 tokens (the budget never decides whether a
    round is sent or kept). The next turn starts from 0: two tool rounds of
    102,000 each, then her answer — no stop. With 150,000 written, the third
    turn stops after its round 2 (204,000)."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    gateway = ScriptedGateway(
        rounds=(
            _answer("It is done.", 390_000, 10_000),
            _probe_round(2, "a", 100_000, 2_000),
            _probe_round(3, "b", 100_000, 2_000),
            _answer("Both checked.", 50_000, 1_000),
            _probe_round(5, "c", 100_000, 2_000),
            _probe_round(6, "d", 100_000, 2_000),
            _answer(PROSE),
            _probe_round(8, "e", 100_000, 2_000),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, 300_000)

    await _say(owner_client, "answer straight away")
    assert await _stored(pool) == "It is done."
    assert _stops(await _spans_of(pool)) == []

    await _say(owner_client, "check two")
    assert ran == ["a", "b"]
    assert await _stored(pool) == "Both checked."
    assert _stops(await _spans_of(pool)) == []

    await _put_budget(owner_client, 150_000)
    await _say(owner_client, "check two more")
    assert ran == ["a", "b", "c", "d"]
    _token_stop(_stops(await _spans_of(pool)), rounds=2, budget=150_000)
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{_budget_note(stored, rounds=2, budget=150_000, spent=204_000)}"


# -- C5: the loop T13 left open ----------------------------------------------------

LIVE_PROBE = "t26_uptime"
NARRATION = "Uptime keeps rising; the machine is up."


@dataclasses.dataclass
class _PollForever(ScriptedGateway):
    """A model that polls the live reading every round it is offered tools,
    each round reporting 125,000 prompt + 5,000 completion tokens, and answers
    only when offered none (the narration round). A safety end after 60 polls
    keeps a missing budget from looping the test forever."""

    def _next(self, body: dict) -> tuple:
        if not body.get("tools"):
            return (text_delta(NARRATION),)
        if self.calls >= 60:
            return (text_delta("I polled sixty times."),)
        return (whole_call(f"p{self.calls}", LIVE_PROBE, {"q": "uptime"}), _usage(125_000, 5_000))

    async def _completions(self, request):
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        self.rounds = (*self.rounds[: self.calls], self._next(body or {}))
        return await super()._completions(request)


@requires_db
async def test_v27_t26_c5_a_live_reading_that_changes_every_call_is_stopped_by_the_budget(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """A live reading (ephemeral AND reads_only) whose answer ticks on every
    call: neither circling stop ends it (T13). 130,000 tokens a round under the
    default 1,000,000: stopped after round 8 (1,040,000), never a 9th poll."""
    ran: list[str] = []

    async def uptime(args: dict, ctx) -> str:
        ran.append(args["q"])
        return f"up {3_600 + 7 * len(ran)} s, load 0.{len(ran) % 10}"

    monkeypatch.setitem(
        tools.REGISTRY,
        LIVE_PROBE,
        Tool(LIVE_PROBE, "d", PROBE_SCHEMA, uptime, reads_only=True, ephemeral=True),
    )
    assert LIVE_PROBE in tools.live_reading_tool_names()
    gateway = _PollForever()
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "watch the uptime")

    assert ran == ["uptime"] * 8
    stop = _token_stop(_stops(await _spans_of(pool)), rounds=8, budget=DEFAULT_BUDGET)
    assert stop["spent_tokens"] == 1_040_000
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=8, budget=DEFAULT_BUDGET, spent=1_040_000)
    assert stored == f"{NARRATION}\n\n{note}"


# -- C6: a round that reports no usage is estimated, never counted as 0 ------------


@dataclasses.dataclass
class _RatioWatch(ScriptedGateway):
    """A ScriptedGateway that notes, as each request arrives, the chars/token
    ratio core holds for its link at that moment — so a test reads the ratio
    in force when a round was sent (or a stop decided before it), never the
    one a later reporting round recalibrated."""

    ratios: list[float] = dataclasses.field(default_factory=list)

    async def _completions(self, request):
        self.ratios.append(
            chat._SERVED_CHARS_PER_TOKEN.get(self.served_by, context_fit.DEFAULT_CHARS_PER_TOKEN)
        )
        return await super()._completions(request)


@requires_db
async def test_v27_t26_c6_a_served_round_with_no_usage_counts_its_estimate_and_says_so(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Budget 30,000. Round 1 reports 20,000 + 500. Round 2 is served with NO
    usage chunk: counted as 0 it would leave the turn at 20,500 and round 3
    (reported) would be the stop; counted as core's estimate of what it sent
    (at the ratio round 1 taught), the turn is over the budget after round 2.
    Reported figures stay as reported; the note says one round was estimated.

    The ratio is read as it stood when the stop was decided (as the narration
    request arrives), not after the turn: the narration round reports its own
    usage and recalibrates the link after the stop was already filed."""
    _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n} " + "reading " * 400)
    gateway = _RatioWatch(
        rounds=(
            _probe_round(1, "a", 20_000, 500),
            _probe_round(2, "b"),
            _probe_round(3, "c", 20_000, 500),
            _answer(PROSE),
            _probe_round(5, "d", 20_000, 500),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, 30_000)

    await _say(owner_client, "find it")

    assert gateway.calls == 3, "two tool rounds, then the narration round"
    # gateway.ratios[i] is the ratio as request i arrived: [1] is what round 2
    # was estimated at (round 1 had calibrated it), [2] what stood when the
    # stop was decided; round 2 reported nothing, so the two are the same.
    ratio = gateway.ratios[2]
    assert ratio == gateway.ratios[1], gateway.ratios
    assert ratio != context_fit.DEFAULT_CHARS_PER_TOKEN, "round 1's usage calibrated nothing"
    estimate = _sent_estimate(gateway.payloads[1], ratio)
    assert estimate > 0
    stop = _token_stop(_stops(await _spans_of(pool)), rounds=2, budget=30_000)
    assert stop["estimated_rounds"] == 1, stop
    assert stop["prompt_tokens"] == 20_000 + estimate, (stop, estimate)
    assert stop["completion_tokens"] >= 500, stop
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=2, budget=30_000, spent=stop["spent_tokens"])
    assert "estimated" in note, note
    assert re.search(
        r"(?<![\d,])1(?![\d,])[^\]]*estimated|estimated[^\]]*(?<![\d,])1(?![\d,])", note
    ), note


@requires_db
@pytest.mark.parametrize("shape", ["no_usage_chunk", "null_tokens"])
async def test_v27_t26_c6_a_turn_whose_rounds_report_no_usage_is_still_stopped(
    owner_client, pool, mount_peers, workspace, monkeypatch, shape
):
    """No round reports a token count — no usage chunk at all, or one with
    null counts (an unmetered link). Every round is estimated from what it sent
    at the default ratio (nothing calibrates), so the turn is still stopped by
    the budget, at the first round whose estimates reach it."""
    _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n} " + "reading " * 2_000)
    if shape == "no_usage_chunk":
        script = tuple(_probe_round(i, f"q{i}") for i in range(1, 31))
    else:
        script = tuple(
            (whole_call(f"c{i}", PROBE, {"q": f"q{i}"}), _usage(None, None)) for i in range(1, 31)
        )
    gateway = ScriptedGateway(rounds=(*script, _answer(PROSE)))
    mount_peers(gateway=gateway, memory=FakeMemory())
    budget = 100_000
    await _put_budget(owner_client, budget)

    await _say(owner_client, "find it")

    stops = _stops(await _spans_of(pool))
    assert len(stops) == 1 and stops[0].get("reason") == TOKEN_BUDGET, stops
    rounds = stops[0]["rounds"]
    assert 2 <= rounds < 30, stops
    stop = _token_stop(stops, rounds=rounds, budget=budget)
    assert stop["estimated_rounds"] == rounds, stop
    ratio = context_fit.DEFAULT_CHARS_PER_TOKEN
    prompts = [_sent_estimate(p, ratio) for p in gateway.payloads[:rounds]]
    assert stop["prompt_tokens"] == sum(prompts), (stop, prompts)
    assert sum(prompts[:-1]) < budget, "the stop came later than the estimates reach the budget"
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=rounds, budget=budget, spent=stop["spent_tokens"])
    assert "estimated" in note, note


# -- COVERAGE (T26 GREEN): the edges the criteria name -------------------------------


@requires_db
async def test_v27_t26_cov_c2_a_turn_at_exactly_its_budget_stops(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C2 says spent >= the budget: two rounds of 102,000 under 204,000 reach it
    exactly, so round 2 is the last tool round. Under a strict `>` the script's
    3rd round would be her plain answer and nothing would stop."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    gateway = ScriptedGateway(
        rounds=(
            _probe_round(1, "a", 100_000, 2_000),
            _probe_round(2, "b", 100_000, 2_000),
            _answer(PROSE),
            _probe_round(4, "c", 100_000, 2_000),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, 204_000)

    await _say(owner_client, "find it")

    assert ran == ["a", "b"]
    await _narration_held(pool, gateway, tool_rounds=2)
    stop = _token_stop(_stops(await _spans_of(pool)), rounds=2, budget=204_000)
    assert stop["spent_tokens"] == 204_000, stop
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{_budget_note(stored, rounds=2, budget=204_000, spent=204_000)}"


@requires_db
async def test_v27_t26_cov_c6_a_round_reporting_only_its_prompt_estimates_only_its_completion(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C6 per count: round 1 reports its prompt (budget - 1) but a null
    completion. The prompt is taken as reported, never re-estimated; the
    completion is core's estimate of what the round wrote — its tool call's
    arguments — at the ratio that round's own prompt taught; the round counts as
    estimated. Counted as 0, the turn would sit 1 token under the budget and
    round 2 (her plain answer) would be the reply with no stop."""
    _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    budget = 30_000
    arguments = {"q": "a fairly long query so the call writes a few tokens"}
    gateway = _RatioWatch(
        rounds=(
            (whole_call("c1", PROBE, arguments), _usage(budget - 1, None)),
            _answer(PROSE),
            _probe_round(3, "later", 1_000, 10),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, budget)

    await _say(owner_client, "find it")

    await _narration_held(pool, gateway, tool_rounds=1)
    ratio = gateway.ratios[1]
    assert ratio != context_fit.DEFAULT_CHARS_PER_TOKEN, "round 1's prompt calibrated nothing"
    written = len(json.dumps(arguments))
    stop = _token_stop(_stops(await _spans_of(pool)), rounds=1, budget=budget)
    assert stop["prompt_tokens"] == budget - 1, stop
    assert stop["completion_tokens"] == math.ceil(written / ratio), (stop, written, ratio)
    assert stop["estimated_rounds"] == 1, stop
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=1, budget=budget, spent=stop["spent_tokens"])
    assert "estimated" in note, note


@requires_db
async def test_v27_t26_cov_c3_a_partly_reported_round_is_not_said_to_have_reported_nothing(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C3: every string the stop emits is true. A round that reported one count
    and not the other (ollama leaves prompt_eval_count out on a cached prompt;
    here the completion is null) did report usage, and only part of its tokens
    is estimated — the note must not say it reported none."""
    _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    budget = 30_000
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", PROBE, {"q": "a"}), _usage(budget - 1, None)),
            _answer(PROSE),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, budget)

    await _say(owner_client, "find it")

    stop = _token_stop(_stops(await _spans_of(pool)), rounds=1, budget=budget)
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=1, budget=budget, spent=stop["spent_tokens"])
    assert "estimated" in note, note
    assert "reported no usage" not in note, note


async def test_v27_t26_cov_an_unreadable_budget_falls_back_to_its_default(monkeypatch, caplog):
    """The setting is read once at the turn's start; a read that raises bounds
    the turn by the def's default (logged), never by nothing."""

    async def broken(pool, key):
        raise RuntimeError("settings table unreachable")

    monkeypatch.setattr(settings_store, "read_value", broken)
    for key in (settings_store.TURN_TOKEN_BUDGET, settings_store.TURN_TIME_BUDGET):
        caplog.clear()
        got = await chat._turn_budget(None, key, "t26-cov")
        assert got == settings_store.DEFS_BY_KEY[key].default, (key, got)
        assert any(key in r.getMessage() and "default" in r.getMessage() for r in caplog.records)
    assert DEFAULT_BUDGET == settings_store.DEFS_BY_KEY[settings_store.TURN_TOKEN_BUDGET].default


# -- COVERAGE (T26 VERIFY gaps): the count the note states; time over tokens -------


@requires_db
async def test_v27_t26_cov_c6_the_note_states_how_many_rounds_were_estimated(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C6: the note states HOW MANY rounds were estimated. Rounds 1-3 are served
    with no usage chunk (each estimated, far under 200,000 together); round 4
    reports its prompt (200,000) and a null completion, so it is estimated too
    and crosses the budget. Four rounds were estimated: the round_stop says 4
    and the note states 4, in the plural — not one more, not "1 round"."""
    _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    budget = 200_000
    gateway = ScriptedGateway(
        rounds=(
            _probe_round(1, "a"),
            _probe_round(2, "b"),
            _probe_round(3, "c"),
            (whole_call("c4", PROBE, {"q": "d"}), _usage(budget, None)),
            _answer(PROSE),
            _probe_round(6, "e"),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, budget)

    await _say(owner_client, "find it")

    await _narration_held(pool, gateway, tool_rounds=4)
    stop = _token_stop(_stops(await _spans_of(pool)), rounds=4, budget=budget)
    assert stop["estimated_rounds"] == 4, stop
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=4, budget=budget, spent=stop["spent_tokens"])
    assert "estimated" in note, note
    # Past the "[stopped after 4 tool rounds: " prefix, every number the note
    # states is the spent tokens, the budget or the estimated-round count.
    body = note.split(": ", 1)[1]
    stated = {int(n.replace(",", "")) for n in re.findall(r"\d[\d,]*", body)}
    assert stated <= {stop["spent_tokens"], budget, 4}, (stated, note)
    assert _stated(4, body), note
    assert re.search(r"(?<![\d,])4 rounds\b", body), note
    assert not re.search(r"(?<![\d,])1 round\b", body), note


@requires_db
async def test_v27_t26_cov_time_and_tokens_tripping_on_one_round_file_the_time_stop(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Assumptions: on the same round circling wins, then the time budget, then
    the token budget. Round 1's tool takes 1,000 s (past the default 900) AND
    the round reports 402,000 tokens (past a 300,000 budget): ONE round_stop,
    reason time_budget, and the note and the narration round's nudge name only
    the time budget."""
    from tests.test_turn_time_budget import (
        DEFAULT_BUDGET as TIME_DEFAULT,
    )
    from tests.test_turn_time_budget import (
        _arm_timed_probe,
        _budget_stop_held,
        _Clock,
        _install_clock,
    )
    from tests.test_turn_time_budget import _budget_note as _time_note

    clock = _install_clock(monkeypatch, _Clock())
    ran = _arm_timed_probe(monkeypatch, clock, 1_000)
    gateway = ScriptedGateway(
        rounds=(
            (whole_call("c1", PROBE, {"q": "a"}), _usage(400_000, 2_000)),
            _answer(PROSE),
            _probe_round(3, "b", 1_000, 10),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    await _put_budget(owner_client, 300_000)

    await _say(owner_client, "find it")

    assert ran == ["a"]
    await _narration_held(pool, gateway, tool_rounds=1)
    _budget_stop_held(_stops(await _spans_of(pool)), rounds=1, budget=TIME_DEFAULT, elapsed=1000)
    stored = await _stored(pool)
    note = _time_note(stored, rounds=1, budget=TIME_DEFAULT, elapsed=1000)
    assert stored == f"{PROSE}\n\n{note}"
    assert "token" not in note.lower() and BUDGET_KEY not in note, note
    nudge = json.dumps(gateway.payloads[-1]["messages"][-1]).lower()
    assert "time budget" in nudge and "token budget" not in nudge, nudge
