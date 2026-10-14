"""verification-2-7 T25: a turn past its wall-clock budget ends between rounds,
on a stated note.

The verification report (2026-10-13, item 2): a turn had no hard bound. The
worst real turn ran 1,331 s / 51 rounds; live chat p99 is 668 s. The owner
removed every ROUND ceiling (2026-10-08), so this is not a count: it is a
per-turn wall-clock budget, a setting (`turns.time_budget_s`, default 900),
checked where the circling stop is checked — after a round's tools have all
run — and ending the turn the same way: a `round_stop` span, one toolless
narration round, and a note that states why. It never cuts a tool or a model
mid-flight, never discards an answer, and never asks the owner anything
(no-approvals.md).

T13 left one loop only this closes: a live reading whose answer changes on
every call (a ticking uptime) is never a repeat and always news, so neither
circling stop ends it. C5 pins that the budget does.

Time is read from `chat.turn_clock` (monotonic seconds); every test injects a
fake clock that the tool executors advance, so nothing here sleeps.
"""

from __future__ import annotations

import dataclasses
import json
import re
import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app import chat, context_fit, scheduler, settings_store, timers, tools, traces
from app.identity import Person
from app.main import app
from app.tools.base import Tool, ToolContext
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
    _narration_held,
    _spans_of,
    _stops,
    _stored,
    _texts,
)

BUDGET_KEY = "turns.time_budget_s"
DEFAULT_BUDGET = 900
MIN_BUDGET, MAX_BUDGET = 60, 86400
TIME_BUDGET = "time_budget"
APPROVAL_WORDS = ("approve", "allow", "permission", "confirm", "would you like", "should i")


@pytest.fixture
def workspace(monkeypatch, tmp_path):
    root = tmp_path / "workspace"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


class _Clock:
    """Monotonic seconds that move only when a test moves them (or, with
    `tick`, by that much on every read)."""

    def __init__(self, start: float = 5_000.0, tick: float = 0.0) -> None:
        self.now = start
        self.tick = tick

    def __call__(self) -> float:
        value = self.now
        self.now += self.tick
        return value

    def advance(self, seconds: float) -> None:
        self.now += seconds


def _install_clock(monkeypatch, clock: _Clock) -> _Clock:
    # raising=False: the seam is what T25 adds; until then nothing reads it.
    monkeypatch.setattr(chat, "turn_clock", clock, raising=False)
    return clock


def _arm_timed_probe(
    monkeypatch, clock: _Clock, seconds: float, answer=None, *, live: bool = False, name=PROBE
) -> list[str]:
    """A registered read tool whose every run takes `seconds` on the fake
    clock and returns answer(q, n) (n 0-based). `live`: declared ephemeral
    too, i.e. a live reading (tools.live_reading_tool_names())."""
    ran: list[str] = []
    answer = answer or (lambda q, n: f"{q} result #{n}")

    async def probe(args: dict, ctx: ToolContext) -> str:
        ran.append(args["q"])
        clock.advance(seconds)
        return answer(args["q"], len(ran) - 1)

    monkeypatch.setitem(
        tools.REGISTRY,
        name,
        Tool(name, "d", PROBE_SCHEMA, probe, reads_only=True, ephemeral=live),
    )
    return ran


def _probe_rounds(*qs: str, start: int = 1) -> tuple:
    return tuple((whole_call(f"c{i}", PROBE, {"q": q}),) for i, q in enumerate(qs, start=start))


def _stated(n: int, text: str) -> bool:
    """The number stated in the text as a whole number, plain or comma-grouped,
    never as part of a longer number."""
    return any(
        re.search(rf"(?<![\d,.]){re.escape(form)}(?![\d,]|\.\d)", text)
        for form in {str(n), f"{n:,}"}
    )


def _budget_note(stored: str, *, rounds: int, budget: int, elapsed: int) -> str:
    """The backend note the stopped reply ends with, checked for what it must
    state; returned so the caller can pin the reply around it."""
    note = stored.rsplit("\n\n", 1)[-1]
    assert note.startswith(f"[stopped after {rounds} tool rounds: "), stored
    assert note.endswith("]"), stored
    assert _stated(budget, note), f"the note does not state the budget {budget}: {note!r}"
    assert _stated(elapsed, note), f"the note does not state the elapsed {elapsed}: {note!r}"
    assert BUDGET_KEY in note, f"the note does not name {BUDGET_KEY}: {note!r}"
    return note


def _budget_stop_held(stops: list[dict], *, rounds: int, budget: int, elapsed: int) -> None:
    assert len(stops) == 1, stops
    stop = stops[0]
    assert stop.get("reason") == TIME_BUDGET, stop
    assert stop.get("rounds") == rounds and type(stop.get("rounds")) is int, stop
    assert stop.get("budget_s") == budget and type(stop.get("budget_s")) is int, stop
    assert stop.get("elapsed_s") == elapsed and type(stop.get("elapsed_s")) is int, stop


def _asks_nothing(reply: str) -> None:
    assert "?" not in reply, reply
    lowered = reply.lower()
    assert [w for w in APPROVAL_WORDS if w in lowered] == [], reply


async def _put_budget(client, value) -> None:
    resp = await client.put("/api/v1/settings", json={"key": BUDGET_KEY, "value": value})
    assert resp.status_code == 200, resp.text


# -- C1: a setting, listed and bounded; a named stop reason ------------------------


@requires_db
async def test_v27_t25_c1_the_budget_is_a_listed_setting_with_its_default(owner_client):
    resp = await owner_client.get("/api/v1/settings")
    assert resp.status_code == 200, resp.text
    items = {item["key"]: item for item in resp.json()["settings"]}
    assert BUDGET_KEY in items, sorted(items)
    item = items[BUDGET_KEY]
    assert item["type"] == "int"
    assert item["default"] == DEFAULT_BUDGET
    assert item["value"] == DEFAULT_BUDGET
    described = item["description"].lower()
    assert "second" in described, item["description"]
    assert "between rounds" in described, item["description"]
    assert settings_store.DEFS_BY_KEY[BUDGET_KEY].validate is not None


@requires_db
async def test_v27_t25_c1_the_budget_is_bounded_at_the_write(owner_client, pool):
    await _put_budget(owner_client, 300)
    assert await pool.fetchval("SELECT value FROM settings WHERE key = $1", BUDGET_KEY) == 300

    for bad, named in ((MIN_BUDGET - 1, str(MIN_BUDGET)), (MAX_BUDGET + 1, str(MAX_BUDGET))):
        resp = await owner_client.put("/api/v1/settings", json={"key": BUDGET_KEY, "value": bad})
        assert resp.status_code == 400, resp.text
        assert named in resp.json()["error"], resp.text
    resp = await owner_client.put("/api/v1/settings", json={"key": BUDGET_KEY, "value": True})
    assert resp.status_code == 400, resp.text
    assert await pool.fetchval("SELECT value FROM settings WHERE key = $1", BUDGET_KEY) == 300


def test_v27_t25_c1_the_stop_has_its_own_reason_and_is_not_a_circling_one():
    assert chat.STOP_TIME_BUDGET == TIME_BUDGET
    assert chat.STOP_TIME_BUDGET in chat.ROUND_STOP_REASONS
    assert chat.STOP_TIME_BUDGET not in chat.CIRCLING_NOTE_WORDS
    turn = traces.Turn(id=uuid.uuid4(), started_at=datetime.now(UTC))
    chat._file_round_stop(turn, chat.STOP_TIME_BUDGET, 3, budget_s=900, elapsed_s=960)
    (span,) = turn.spans
    assert span.kind == "round_stop"
    assert span.meta == {"reason": TIME_BUDGET, "rounds": 3, "budget_s": 900, "elapsed_s": 960}


# -- C2: past the budget, the turn ends after that round's tools, on a note ----------


@requires_db
async def test_v27_t25_c2_a_turn_past_its_budget_ends_after_that_rounds_tools_with_a_note(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Each tool run takes 400 s; under the default 900 the turn has spent
    1,200 s when round 3's tool returns, so round 3 is the last tool round:
    one round_stop, one toolless narration round, her narration then the
    note, stored exactly as streamed. Without the budget the script's 4th
    round would be her plain answer and nothing would stop."""
    clock = _install_clock(monkeypatch, _Clock())
    ran = _arm_timed_probe(monkeypatch, clock, 400)
    gateway = ScriptedGateway(
        rounds=(*_probe_rounds("a", "b", "c"), (text_delta(PROSE),), *_probe_rounds("d", "e"))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    sent = await _say(owner_client, "find it")

    assert ran == ["a", "b", "c"]
    await _narration_held(pool, gateway, tool_rounds=3)
    _budget_stop_held(_stops(await _spans_of(pool)), rounds=3, budget=DEFAULT_BUDGET, elapsed=1200)
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=3, budget=DEFAULT_BUDGET, elapsed=1200)
    assert stored == f"{PROSE}\n\n{note}"
    assert "".join(_texts(sent)) == stored


# -- C3: never mid-tool; the circling shape when narration does not answer; asks nothing


@requires_db
async def test_v27_t25_c3_a_call_in_flight_when_the_budget_passes_runs_and_so_does_its_round(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """Round 1 asks for two calls; the FIRST alone takes 1,000 s, past the
    900 s budget. The second still runs, both results are kept and reach the
    narration request, and the turn stops after round 1."""
    clock = _install_clock(monkeypatch, _Clock())
    durations = iter([1000, 50])
    ran: list[str] = []

    async def probe(args: dict, ctx: ToolContext) -> str:
        ran.append(args["q"])
        clock.advance(next(durations))
        return f"{args['q']} finished"

    monkeypatch.setitem(
        tools.REGISTRY, PROBE, Tool(PROBE, "d", PROBE_SCHEMA, probe, reads_only=True)
    )
    gateway = ScriptedGateway(
        rounds=(
            (_calls(("c1", PROBE, {"q": "slow"}), ("c2", PROBE, {"q": "quick"})),),
            (text_delta(PROSE),),
            *_probe_rounds("later", start=3),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "do both")

    assert ran == ["slow", "quick"]
    await _narration_held(pool, gateway, tool_rounds=1)
    narration = gateway.payloads[1]["messages"]
    results = [m["content"] for m in narration if m.get("role") == "tool"]
    assert results == ["slow finished", "quick finished"]
    _budget_stop_held(_stops(await _spans_of(pool)), rounds=1, budget=DEFAULT_BUDGET, elapsed=1050)
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{_budget_note(stored, rounds=1, budget=900, elapsed=1050)}"


@requires_db
async def test_v27_t25_c3_a_silent_narration_gets_the_statement_then_the_note_and_asks_nothing(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    clock = _install_clock(monkeypatch, _Clock())
    _arm_timed_probe(monkeypatch, clock, 400)
    gateway = ScriptedGateway(rounds=(*_probe_rounds("a", "b", "c"), ()))
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "find it"})
    assert resp.status_code == 200, resp.text

    assert gateway.calls == 4, "a gateway call followed the narration round"
    assert gateway.payloads[3].get("tools") in (None, [])
    spans = await _spans_of(pool)
    _budget_stop_held(_stops(spans), rounds=3, budget=DEFAULT_BUDGET, elapsed=1200)
    statement = chat.tool_results_statement(spans)
    assert isinstance(statement, str)
    stored = await _stored(pool)
    note = _budget_note(stored, rounds=3, budget=DEFAULT_BUDGET, elapsed=1200)
    assert stored == f"{statement}\n\n{note}"
    _asks_nothing(note)
    assert "consent" not in resp.text.lower()
    assert await pool.fetchval("SELECT status FROM turns ORDER BY started_at DESC LIMIT 1") == "ok"


# -- C4: never discards an answer; read live per turn ------------------------------


@requires_db
async def test_v27_t25_c4_an_answer_is_kept_however_long_the_turn_took(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """A clock that jumps 10,000 s on every read: a turn whose model answers
    with no tool calls keeps that answer (the budget never decides whether a
    round is sent or kept). The next turn, one tool round deep, is past its
    budget after that round and stops."""
    _install_clock(monkeypatch, _Clock(tick=10_000.0))
    ran = _arm_timed_probe(monkeypatch, _Clock(), 0)
    gateway = ScriptedGateway(
        rounds=(
            (text_delta("It is done."),),
            *_probe_rounds("a"),
            (text_delta(PROSE),),
            *_probe_rounds("b", start=2),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "answer straight away")
    first = await pool.fetchval("SELECT id FROM turns ORDER BY started_at DESC LIMIT 1")
    assert await _stored(pool) == "It is done."
    assert _stops(await _spans_of(pool, first)) == []

    await _say(owner_client, "now look it up")
    assert ran == ["a"]
    assert gateway.calls == 3
    stops = _stops(await _spans_of(pool))
    assert [(s.get("reason"), s.get("rounds")) for s in stops] == [(TIME_BUDGET, 1)]
    assert (await _stored(pool)).startswith(f"{PROSE}\n\n[stopped after 1 tool rounds: ")


@requires_db
async def test_v27_t25_c4_the_budget_is_read_at_each_turns_start(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """200 s per tool run. Under 300 the turn stops after round 2 (400 s);
    with 900 written, the next turn's four rounds (800 s) run to her answer
    with no stop. Derived from the stored setting, never a constant."""
    clock = _install_clock(monkeypatch, _Clock())
    ran = _arm_timed_probe(monkeypatch, clock, 200)
    gateway = ScriptedGateway(
        rounds=(
            *_probe_rounds("a", "b"),
            (text_delta(PROSE),),
            *_probe_rounds("c", "d", "e", "f", start=3),
            (text_delta("All four checked."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _put_budget(owner_client, 300)
    await _say(owner_client, "check two")
    first = await pool.fetchval("SELECT id FROM turns ORDER BY started_at DESC LIMIT 1")
    assert ran == ["a", "b"]
    _budget_stop_held(_stops(await _spans_of(pool, first)), rounds=2, budget=300, elapsed=400)
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{_budget_note(stored, rounds=2, budget=300, elapsed=400)}"

    await _put_budget(owner_client, DEFAULT_BUDGET)
    await _say(owner_client, "check four")
    assert ran == ["a", "b", "c", "d", "e", "f"]
    assert await _stored(pool) == "All four checked."
    assert _stops(await _spans_of(pool)) == []


# -- C5: the loop T13 left open ----------------------------------------------------

LIVE_PROBE = "t25_uptime"
POLL_S = 120
NARRATION = "Uptime keeps rising; the machine is up."


@dataclasses.dataclass
class _PollForever(ScriptedGateway):
    """A model that polls the live reading every round it is offered tools,
    and answers only when it is offered none (the narration round). A safety
    end after 60 polls keeps a missing budget from looping the test forever:
    then it answers, and nothing has stopped the turn."""

    def _next(self, body: dict) -> tuple:
        if not body.get("tools"):
            return (text_delta(NARRATION),)
        if self.calls >= 60:
            return (text_delta("I polled sixty times."),)
        return (whole_call(f"p{self.calls}", LIVE_PROBE, {"q": "uptime"}),)

    async def _completions(self, request):
        raw = await request.body()
        body = json.loads(raw) if raw else {}
        self.rounds = (*self.rounds[: self.calls], self._next(body or {}))
        return await super()._completions(request)


@requires_db
async def test_v27_t25_c5_a_live_reading_that_changes_every_call_is_stopped_by_the_budget(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """A live reading (ephemeral AND reads_only) whose answer ticks on every
    call: T13 restarts its repeat count each time and every text is new, so
    neither circling stop ends it — the RoundProgress check below proves that
    on these very results. 120 s per poll under the default 900: stopped
    after round 8 (960 s), never a 9th poll."""
    clock = _install_clock(monkeypatch, _Clock())
    ran = _arm_timed_probe(
        monkeypatch,
        clock,
        POLL_S,
        lambda q, n: f"up {3_600 + POLL_S * (n + 1)} s, load 0.{n % 10}",
        live=True,
        name=LIVE_PROBE,
    )
    assert LIVE_PROBE in tools.live_reading_tool_names()
    gateway = _PollForever()
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "watch the uptime")

    assert ran == ["uptime"] * 8
    stops = _stops(await _spans_of(pool))
    _budget_stop_held(stops, rounds=8, budget=DEFAULT_BUDGET, elapsed=960)
    stored = await _stored(pool)
    assert stored == f"{NARRATION}\n\n{_budget_note(stored, rounds=8, budget=900, elapsed=960)}"

    progress = chat.RoundProgress()
    outcomes = [
        progress.after_round(
            [chat.ToolCall(id=f"p{n}", name=LIVE_PROBE, arguments=json.dumps({"q": "uptime"}))],
            [f"up {3_600 + POLL_S * (n + 1)} s, load 0.{n % 10}"],
        )
        for n in range(60)
    ]
    assert outcomes == [None] * 60, "T13's circling stop ends this loop by itself"


# -- C6: background turns are held to the same setting ------------------------------


@requires_db
async def test_v27_t25_c6_an_agent_turn_past_its_budget_stops_the_same_way(
    pool, mount_peers, workspace, monkeypatch
):
    owner = await _agent_owner(pool)
    clock = _install_clock(monkeypatch, _Clock())
    ran = _arm_timed_probe(monkeypatch, clock, 400)
    agent = await _create(pool, mount_peers, tools=(*SUBSET, PROBE))
    gateway = ScriptedGateway(rounds=(*_probe_rounds("a", "b", "c"), (), *_probe_rounds("d")))
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "find them")

    assert ran == ["a", "b", "c"]
    assert gateway.calls == 4
    _budget_stop_held(_stops(turn.spans), rounds=3, budget=DEFAULT_BUDGET, elapsed=1200)
    statement = chat.tool_results_statement(turn.spans)
    assert isinstance(statement, str)
    reply = await _reply(pool, turn.id)
    assert reply == f"{statement}\n\n{_budget_note(reply, rounds=3, budget=900, elapsed=1200)}"
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn.id) == "ok"


@requires_db
async def test_v27_t25_c6_a_scheduled_firing_past_its_budget_stops_the_same_way(
    pool, mount_peers, workspace, monkeypatch
):
    pid = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ('jeremy', 'owner') RETURNING id"
    )
    conversation = await pool.fetchval(
        "INSERT INTO conversations (person_id) VALUES ($1) RETURNING id", pid
    )
    person = Person(id=pid, name="jeremy", role="owner")
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('chat.model', $1::jsonb)", "qwen3:8b"
    )
    clock = _install_clock(monkeypatch, _Clock())
    ran = _arm_timed_probe(monkeypatch, clock, 400)
    gateway = ScriptedGateway(
        rounds=(*_probe_rounds("a", "b", "c"), (text_delta(PROSE),), *_probe_rounds("d"))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    row = await timers.create(
        pool,
        person=person,
        kind="scheduled",
        title="sweep",
        payload={"instruction": "look everything up"},
        spec={"kind": "day", "at": "07:00"},
        tz="America/New_York",
        conversation_id=conversation,
        created_via="chat",
    )

    await scheduler.tick_once(app, pool, now=row["next_fire_at"] + timedelta(minutes=1))

    assert scheduler.firing_timeout_s("scheduled") is None
    assert ran == ["a", "b", "c"]
    firing = await pool.fetchrow(
        "SELECT status, reason, turn_id FROM timer_firings WHERE timer_id = $1", row["id"]
    )
    assert firing["status"] == "ok", firing["reason"]
    _budget_stop_held(
        _stops(await _spans_of(pool, firing["turn_id"])),
        rounds=3,
        budget=DEFAULT_BUDGET,
        elapsed=1200,
    )
    reply = await _reply(pool, firing["turn_id"])
    assert reply == f"{PROSE}\n\n{_budget_note(reply, rounds=3, budget=900, elapsed=1200)}"


@pytest.mark.parametrize("value", [MIN_BUDGET, DEFAULT_BUDGET, MAX_BUDGET])
def test_v27_t25_c1_the_bounds_and_default_are_accepted(value):
    definition = settings_store.validated(BUDGET_KEY, value)
    assert definition.default == DEFAULT_BUDGET


# -- COVERAGE (T25 GREEN): the edges the criteria name and the cases above leave open


@requires_db
async def test_v27_t25_cov_c2_a_turn_exactly_at_its_budget_stops(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C2 says elapsed >= the budget: 300 s per tool under 900 is exactly 900
    when round 3's tool returns, and that is past the budget — round 3 is the
    last tool round. (C2-C5 above all overshoot it, so `>` would pass them.)"""
    clock = _install_clock(monkeypatch, _Clock())
    ran = _arm_timed_probe(monkeypatch, clock, 300)
    gateway = ScriptedGateway(
        rounds=(*_probe_rounds("a", "b", "c"), (text_delta(PROSE),), *_probe_rounds("d"))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "find it")

    assert ran == ["a", "b", "c"]
    _budget_stop_held(_stops(await _spans_of(pool)), rounds=3, budget=DEFAULT_BUDGET, elapsed=900)
    stored = await _stored(pool)
    assert stored == f"{PROSE}\n\n{_budget_note(stored, rounds=3, budget=900, elapsed=900)}"


@dataclasses.dataclass
class _SlowRecall(FakeMemory):
    """A memory service whose recall takes `seconds` on the test's clock: the
    work before round 1 is part of the turn."""

    clock: _Clock | None = None
    seconds: float = 0.0

    async def _recall(self, request):
        assert self.clock is not None
        self.clock.advance(self.seconds)
        return await super()._recall(request)


@requires_db
async def test_v27_t25_cov_c2_the_clock_starts_at_the_turns_start_and_the_budget_is_read_once(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C2: elapsed is counted from the turn's start, not round 1 — a recall
    that takes 500 s counts — and the budget is the one read at the turn's
    start: round 1's tool writing 60 mid-turn moves the NEXT turn, not this
    one. 200 s per tool: 500 + 200 + 200 = 900 stops after round 2 under the
    900 read at the start (a clock started at round 1 would run a 3rd round;
    a budget re-read per round would stop after round 1)."""
    clock = _install_clock(monkeypatch, _Clock())
    ran: list[str] = []

    async def probe(args: dict, ctx: ToolContext) -> str:
        ran.append(args["q"])
        clock.advance(200)
        if len(ran) == 1:
            await pool.execute(
                "INSERT INTO settings (key, value) VALUES ($1, $2::jsonb) "
                "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
                BUDGET_KEY,
                MIN_BUDGET,
            )
        return f"{args['q']} result"

    monkeypatch.setitem(
        tools.REGISTRY, PROBE, Tool(PROBE, "d", PROBE_SCHEMA, probe, reads_only=True)
    )
    gateway = ScriptedGateway(
        rounds=(*_probe_rounds("a", "b", "c"), (text_delta(PROSE),), *_probe_rounds("d"))
    )
    mount_peers(gateway=gateway, memory=_SlowRecall(clock=clock, seconds=500))

    await _say(owner_client, "find it")

    assert ran == ["a", "b"]
    _budget_stop_held(_stops(await _spans_of(pool)), rounds=2, budget=DEFAULT_BUDGET, elapsed=900)
    assert await pool.fetchval("SELECT value FROM settings WHERE key = $1", BUDGET_KEY) == 60


@requires_db
async def test_v27_t25_cov_c3_the_narration_round_is_told_the_true_reason_and_its_call_is_refused(
    owner_client, pool, mount_peers, workspace, monkeypatch
):
    """C3 (the circling shape, stated truly): the narration round's nudge and
    the refusal of a call it asks for anyway say the turn ran past its time
    budget — never that it went in circles, which it did not. The call is not
    dispatched; the reply is the statement then the note."""
    clock = _install_clock(monkeypatch, _Clock())
    ran = _arm_timed_probe(monkeypatch, clock, 400)
    gateway = ScriptedGateway(
        rounds=(*_probe_rounds("a", "b", "c"), (whole_call("c9", PROBE, {"q": "more"}),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "find it")

    assert ran == ["a", "b", "c"]
    await _narration_held(pool, gateway, tool_rounds=3, refused=1)
    nudge = gateway.payloads[3]["messages"][-1]
    assert nudge["role"] == "system" and nudge["content"] == chat.TIME_BUDGET_NUDGE
    assert "circl" not in chat.TIME_BUDGET_NUDGE + chat.TIME_BUDGET_REFUSAL
    assert "repeated" not in chat.TIME_BUDGET_NUDGE
    spans = await _spans_of(pool)
    (refused,) = [s for s in spans if s.kind == "tool" and s.meta.get("refused_out_of_rounds")]
    assert refused.meta["result_head"] == chat.TIME_BUDGET_REFUSAL[: chat.SPAN_RESULT_HEAD_CHARS]
    assert chat.TIME_BUDGET_REFUSAL.startswith(tools.ERROR_PREFIX)
    stored = await _stored(pool)
    statement = chat.tool_results_statement(spans)
    assert stored == f"{statement}\n\n{_budget_note(stored, rounds=3, budget=900, elapsed=1200)}"
    _asks_nothing(chat.TIME_BUDGET_REFUSAL + chat.TIME_BUDGET_NUDGE)


# -- C3 (VERIFY gap): the log names the stop that happened -------------------------


def _unfittable_narration(monkeypatch) -> None:
    """The narration round (round 0) cannot fit: raised before any request,
    exactly as _gateway_round does when fit() says unfittable."""
    real = chat._gateway_round

    async def gateway_round(*args, round_number: int, **kwargs):
        if round_number == 0:
            report = context_fit.FitReport(
                window=64,
                budget=48,
                est_tokens=5000,
                fits=False,
                unfittable=True,
                tool_results_trimmed=0,
                rounds_dropped=0,
                chars_removed=0,
                overhead_tokens=4000,
            )
            raise chat.RequestUnfittable(report, "ollama:qwen3:8b")
        return await real(*args, round_number=round_number, **kwargs)

    monkeypatch.setattr(chat, "_gateway_round", gateway_round)


@requires_db
@pytest.mark.parametrize("narration", ["failed", "unfittable"])
async def test_v27_t25_c3_the_narration_rounds_log_lines_name_the_time_budget_stop(
    owner_client, pool, mount_peers, workspace, monkeypatch, caplog, narration
):
    """At a time-budget stop the narration round's log line (it failed: the
    script has no 4th round; or it could not fit and was not sent) names the
    time-budget stop. No log line calls it the circling stop — it did not
    circle."""
    clock = _install_clock(monkeypatch, _Clock())
    _arm_timed_probe(monkeypatch, clock, 400)
    if narration == "unfittable":
        _unfittable_narration(monkeypatch)
    gateway = ScriptedGateway(rounds=_probe_rounds("a", "b", "c"))
    mount_peers(gateway=gateway, memory=FakeMemory())

    await _say(owner_client, "find it")

    _budget_stop_held(_stops(await _spans_of(pool)), rounds=3, budget=DEFAULT_BUDGET, elapsed=1200)
    messages = [r.getMessage() for r in caplog.records]
    assert [m for m in messages if "circling" in m.lower()] == [], messages
    narration_lines = [m for m in messages if "narration round" in m]
    assert narration_lines, messages
    for line in narration_lines:
        assert re.search(r"time[- ]budget", line), line
