"""verification-2-7 T27: an agent past its monthly cap mid-turn ends between
rounds, on the cap's own sentence.

The verification report (2026-10-13, item 2): the agent's monthly cap
(agents.cap_problem, S12) was read once, before round 1 (chat.py, the
`agent_cap` span) — an agent turn that crossed it in round 2 ran on to round 51.
This re-reads it where the circling, time-budget and token-budget stops are
checked (after a round's tools have all run, before another round is asked),
records each read on its own `agent_cap` span, and, past the cap, ends the turn
through the pre-round cap's exit: what the tools found, then the cap's sentence,
verbatim. No narration round follows — that would be a spend past the limit the
owner set. It states the owner's own limit; it never asks him anything
(no-approvals.md).

The gateway's per-provider spend caps are not re-checked here: the gateway reads
them on every request (usage.over_cap at data_plane.py / routing.py), so every
round is already checked there (T27 Assumptions).
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass

import pytest
from starlette.applications import Starlette
from starlette.responses import JSONResponse
from starlette.routing import Route

from app import chat
from tests.conftest import requires_db
from tests.fakes import GATEWAY_TOKEN, FakeMemory, ScriptedGateway, _bearer_ok
from tests.test_chat_agents import SUBSET, _agent_turn, _calls, _create, _parsed, _reply
from tests.test_chat_agents import _owner as _agent_owner
from tests.test_chat_tools import text as text_delta
from tests.test_chat_tools import whole_call
from tests.test_turn_progress import PROBE, _arm_probe, _spans_of, _stops

pytestmark = requires_db

AGENT_CAP = "agent_cap"
ROLE = "agent_coder"
CAP = 20
OVER = (
    "agent coder is over its monthly cap ($21.40 of $20.00 this month) — raise it on the "
    "Agents page"
)
REACHED = (
    "agent coder has reached its monthly cap ($20.00 of $20.00 this month) — raise it on the "
    "Agents page"
)
APPROVAL_WORDS = ("approve", "allow", "permission", "confirm", "would you like", "should i")
# What the cap stop must never say: no model failed, it did not circle, and it is
# neither of the other budgets.
UNTRUE_WORDS = (
    "didn't get a response",
    "failed",
    "the model couldn",
    "try again",
    "circl",
    "repeated",
    "time budget",
    "token budget",
)


@pytest.fixture
def root(monkeypatch, tmp_path):
    """The WORKSPACE_ROOT every agent folder is made under."""
    root = tmp_path / "ws"
    monkeypatch.setenv("WORKSPACE_ROOT", str(root))
    return root


@pytest.fixture(autouse=True)
def fresh_link_facts(monkeypatch):
    """Served-link facts live in process memory; none leak in or out (T26 trap)."""
    monkeypatch.setattr(chat, "_SERVED_CHARS_PER_TOKEN", {})
    monkeypatch.setattr(chat, "_SERVED_WINDOWS", {})
    monkeypatch.setattr(chat, "_SERVED_LINK_BY_REQUEST", {})


@dataclass
class _LedgerGateway(ScriptedGateway):
    """ScriptedGateway plus the gateway's /admin/spend: `ledger(n)` is what the
    agent's role has spent this month once n completions have been served — a
    float (USD), or (status, body) for a ledger that refuses. `spend_reads`
    holds n at each read, so a test sees WHEN each check happened."""

    ledger: Callable[[int], object] | None = None

    def __post_init__(self) -> None:
        super().__post_init__()
        self.spend_reads: list[int] = []
        self.app = Starlette(
            routes=[
                *self.app.routes,
                Route("/admin/spend", self._spend, methods=["GET"]),
            ]
        )

    async def _spend(self, request):
        self.spend_reads.append(self.calls)
        if not _bearer_ok(request, GATEWAY_TOKEN):
            return JSONResponse({"error": "bad gateway bearer"}, status_code=401)
        assert self.ledger is not None, "this test's gateway has no ledger"
        spent = self.ledger(self.calls)
        if isinstance(spent, tuple):
            status, body = spent
            return JSONResponse(body, status_code=status)
        return JSONResponse(
            {
                "window": "month",
                "timezone": "UTC",
                "totals": {"usd": spent},
                "by_role": [{"key": ROLE, "local": False, "usd": spent, "calls": 3}],
            }
        )


def _probe(i: int, q: str) -> tuple:
    return (whole_call(f"c{i}", PROBE, {"q": q}),)


def _usage(prompt: int, completion: int) -> dict:
    return {
        "choices": [],
        "usage": {
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "local": True,
            "metered": True,
            "recorded": True,
        },
    }


def _cap_spans(spans) -> list:
    return [s for s in spans if s.kind == AGENT_CAP]


def _cap_stop(stops: list[dict], *, rounds: int, spent: float) -> dict:
    assert len(stops) == 1, stops
    stop = stops[0]
    assert stop.get("reason") == AGENT_CAP, stop
    assert type(stop.get("rounds")) is int and stop["rounds"] == rounds, stop
    assert stop.get("cap_usd") == float(CAP), stop
    assert stop.get("spent_usd") == spent, stop
    return stop


async def _status(pool, turn_id) -> str | None:
    return await pool.fetchval("SELECT status FROM turns WHERE id = $1", turn_id)


async def _capped_agent(pool, mount_peers, monkeypatch, **over):
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    agent = await _create(pool, mount_peers, tools=(*SUBSET, PROBE), **over)
    return ran, agent


# -- C1: each between-round check is read and recorded ------------------------------


async def test_v27_t27_c1_every_tool_round_rereads_the_cap_on_its_own_span(
    pool, mount_peers, root, monkeypatch
):
    """Under the cap the turn runs to her answer, and every tool round's check
    is on the trace: 1 + K agent_cap spans for K tool rounds, each between-round
    one after that round's tools and before the next model call, each a fresh
    ledger read. No check follows the round that answered."""
    owner = await _agent_owner(pool)
    ran, agent = await _capped_agent(pool, mount_peers, monkeypatch, monthly_cap_usd=CAP)
    gateway = _LedgerGateway(
        rounds=(_probe(1, "a"), _probe(2, "b"), _probe(3, "c"), (text_delta("done"),)),
        ledger=lambda n: 3.0,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "find them")

    assert ran == ["a", "b", "c"]
    assert await _reply(pool, turn.id) == "done"
    assert await _status(pool, turn.id) == "ok"
    spans = await _spans_of(pool, turn.id)
    assert _stops(spans) == []
    caps = _cap_spans(spans)
    assert [dict(s.meta) for s in caps] == [
        {"role": ROLE, "cap_usd": 20.0, "spent_usd": 3.0, "ledger": "read"},
        *(
            {"role": ROLE, "cap_usd": 20.0, "spent_usd": 3.0, "ledger": "read", "after_round": n}
            for n in (1, 2, 3)
        ),
    ]
    # One fresh read per check: before round 1, then after each tool round.
    assert gateway.spend_reads == [0, 1, 2, 3]
    # Between rounds: each check sits after that round's tool and before the
    # next model call.
    order = [s.kind for s in spans if s.kind in ("agent_cap", "llm_call", "tool")]
    assert order == [
        "agent_cap",
        "llm_call",
        "tool",
        "agent_cap",
        "llm_call",
        "tool",
        "agent_cap",
        "llm_call",
        "tool",
        "agent_cap",
        "llm_call",
    ]


async def test_v27_t27_c1_an_agent_with_no_cap_records_each_check_and_reads_no_ledger(
    pool, mount_peers, root, monkeypatch
):
    owner = await _agent_owner(pool)
    ran, agent = await _capped_agent(pool, mount_peers, monkeypatch)  # monthly_cap_usd NULL
    gateway = _LedgerGateway(
        rounds=(_probe(1, "a"), _probe(2, "b"), (text_delta("done"),)),
        ledger=lambda n: 999.0,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "find them")

    assert ran == ["a", "b"]
    assert await _reply(pool, turn.id) == "done"
    spans = await _spans_of(pool, turn.id)
    assert [dict(s.meta) for s in _cap_spans(spans)] == [
        {"role": ROLE, "cap_usd": None, "ledger": "skipped"},
        {"role": ROLE, "cap_usd": None, "ledger": "skipped", "after_round": 1},
        {"role": ROLE, "cap_usd": None, "ledger": "skipped", "after_round": 2},
    ]
    assert gateway.spend_reads == []


# -- C2: crossing it mid-turn ends the turn on the cap's sentence --------------------


@pytest.mark.parametrize(("spent", "sentence"), [(21.4, OVER), (20.0, REACHED)])
async def test_v27_t27_c2_crossing_the_cap_mid_turn_ends_on_the_caps_sentence(
    pool, mount_peers, root, monkeypatch, spent, sentence
):
    """The ledger crosses the cap while round 2 runs: both of round 2's calls
    run, no third round and no narration round is asked, one round_stop
    agent_cap, and the turn leaves through the pre-round cap's exit — what the
    tools found, then the cap's own sentence, stored and sent as the error
    frame. Round 2's streamed prose is not the record."""
    owner = await _agent_owner(pool)
    ran, agent = await _capped_agent(pool, mount_peers, monkeypatch, monthly_cap_usd=CAP)
    gateway = _LedgerGateway(
        rounds=(
            _probe(1, "a"),
            (
                text_delta("Checking both. "),
                _calls(("c2a", PROBE, {"q": "b1"}), ("c2b", PROBE, {"q": "b2"})),
            ),
            _probe(3, "c"),
            (text_delta("never asked"),),
        ),
        ledger=lambda n: 3.0 if n < 2 else spent,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, frames = await _agent_turn(pool, agent, owner, "find them")

    assert ran == ["a", "b1", "b2"]
    assert gateway.calls == 2
    assert gateway.spend_reads == [0, 1, 2]
    spans = await _spans_of(pool, turn.id)
    _cap_stop(_stops(spans), rounds=2, spent=spent)
    statement = chat.tool_results_statement(turn.spans)
    assert isinstance(statement, str)
    reply = await _reply(pool, turn.id)
    assert reply == f"{statement}\n\n{sentence}"
    assert "Checking both." not in reply
    # ci-event-gaps T2: the cap's own sentence, never the statement in front of it.
    assert [dict(s.meta) for s in spans if s.kind == "no_answer"] == [
        {"reason": chat.STOP_AGENT_CAP, "words": sentence}
    ]
    assert await _status(pool, turn.id) == "error"
    assert _parsed(frames)[-2:] == [{"error": reply}, "[DONE]"]
    caps = _cap_spans(spans)
    assert dict(caps[-1].meta) == {
        "role": ROLE,
        "cap_usd": 20.0,
        "spent_usd": spent,
        "ledger": "read",
        "after_round": 2,
    }


def test_v27_t27_c2_the_cap_is_its_own_named_stop_reason():
    assert getattr(chat, "STOP_AGENT_CAP", None) == AGENT_CAP
    assert chat.STOP_AGENT_CAP in chat.ROUND_STOP_REASONS
    assert chat.STOP_AGENT_CAP not in chat.CIRCLING_NOTE_WORDS


# -- C3: every word is true, and it asks nothing -------------------------------------


async def test_v27_t27_c3_the_cap_stop_states_and_asks_nothing(
    pool, mount_peers, root, monkeypatch
):
    owner = await _agent_owner(pool)
    ran, agent = await _capped_agent(pool, mount_peers, monkeypatch, monthly_cap_usd=CAP)
    gateway = _LedgerGateway(
        rounds=(_probe(1, "a"), _probe(2, "b"), (text_delta("never asked"),)),
        ledger=lambda n: 3.0 if n < 1 else 21.4,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, frames = await _agent_turn(pool, agent, owner, "find them")

    assert ran == ["a"]
    assert gateway.calls == 1
    reply = await _reply(pool, turn.id)
    assert isinstance(reply, str) and reply.endswith(OVER), reply
    assert chat.RETRY_HINT not in reply
    said = [reply, *(json.dumps(f) for f in _parsed(frames) if f != "[DONE]")]
    for text in said:
        assert "?" not in text, text
        lowered = text.lower()
        assert [w for w in APPROVAL_WORDS if w in lowered] == [], text
        assert [w for w in UNTRUE_WORDS if w in lowered] == [], text
        assert "consent" not in lowered, text
    # The stop is on the trace as the cap, not as a failure of a model call.
    spans = await _spans_of(pool, turn.id)
    _cap_stop(_stops(spans), rounds=1, spent=21.4)
    assert [s for s in spans if s.kind == "llm_call" and s.meta.get("round") == 0] == []


# -- C4: the cap wins a tie with a narrated stop -------------------------------------


async def test_v27_t27_c4_the_cap_wins_a_tie_with_the_circling_stop(
    pool, mount_peers, root, monkeypatch
):
    """Round 3 is the third identical call (repeated_call) AND the round the
    ledger crosses the cap: the one stop is the cap's, and no narration round
    is asked — that round would be spent past the cap."""
    owner = await _agent_owner(pool)
    ran, agent = await _capped_agent(pool, mount_peers, monkeypatch, monthly_cap_usd=CAP)
    gateway = _LedgerGateway(
        rounds=(_probe(1, "a"), _probe(2, "a"), _probe(3, "a"), (text_delta("narration"),)),
        ledger=lambda n: 3.0 if n < 3 else 21.4,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "find it")

    assert ran == ["a", "a", "a"]
    assert gateway.calls == 3
    _cap_stop(_stops(await _spans_of(pool, turn.id)), rounds=3, spent=21.4)
    reply = await _reply(pool, turn.id)
    assert isinstance(reply, str) and reply.endswith(f"\n\n{OVER}"), reply


async def test_v27_t27_c4_the_cap_wins_a_tie_with_the_token_budget(
    pool, mount_peers, root, monkeypatch
):
    owner = await _agent_owner(pool)
    ran, agent = await _capped_agent(pool, mount_peers, monkeypatch, monthly_cap_usd=CAP)
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ('turns.token_budget', '10000'::jsonb) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
    )
    gateway = _LedgerGateway(
        rounds=(
            (*_probe(1, "a"), _usage(20_000, 500)),
            (text_delta("narration"),),
        ),
        ledger=lambda n: 3.0 if n < 1 else 21.4,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "find it")

    assert ran == ["a"]
    assert gateway.calls == 1
    _cap_stop(_stops(await _spans_of(pool, turn.id)), rounds=1, spent=21.4)
    reply = await _reply(pool, turn.id)
    assert isinstance(reply, str) and reply.endswith(f"\n\n{OVER}"), reply
    assert "token" not in reply.rsplit("\n\n", 1)[-1].lower()


# -- C5: a ledger that cannot be read mid-turn runs the turn and says so --------------


async def test_v27_t27_c5_an_unreadable_ledger_mid_turn_runs_on_and_says_so(
    pool, mount_peers, root, monkeypatch
):
    owner = await _agent_owner(pool)
    ran, agent = await _capped_agent(pool, mount_peers, monkeypatch, monthly_cap_usd=CAP)
    gateway = _LedgerGateway(
        rounds=(_probe(1, "a"), _probe(2, "b"), (text_delta("done"),)),
        ledger=lambda n: (500, {"error": "ledger locked"}) if n == 1 else 3.0,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    turn, _frames = await _agent_turn(pool, agent, owner, "find them")

    assert ran == ["a", "b"]
    assert await _reply(pool, turn.id) == "done"
    assert await _status(pool, turn.id) == "ok"
    spans = await _spans_of(pool, turn.id)
    assert _stops(spans) == []
    assert [dict(s.meta) for s in _cap_spans(spans)] == [
        {"role": ROLE, "cap_usd": 20.0, "spent_usd": 3.0, "ledger": "read"},
        {
            "role": ROLE,
            "cap_usd": 20.0,
            "spent_usd": None,
            "ledger": "unreadable: ledger locked",
            "after_round": 1,
        },
        {"role": ROLE, "cap_usd": 20.0, "spent_usd": 3.0, "ledger": "read", "after_round": 2},
    ]


# -- C6: a plain chat turn is unaffected ---------------------------------------------


async def test_v27_t27_c6_a_plain_chat_turn_reads_no_agent_cap(
    owner_client, pool, mount_peers, monkeypatch
):
    """A non-regression pin (passes before GREEN by design): Nova's own turn has
    no agent and so no agent cap — however many tool rounds it runs, no
    agent_cap span and no ledger read, and it ends on her answer."""
    ran = _arm_probe(monkeypatch, lambda q, n: f"{q} result #{n}")
    gateway = _LedgerGateway(
        rounds=(_probe(1, "a"), _probe(2, "b"), (text_delta("done"),)),
        ledger=lambda n: 999.0,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.post("/api/v1/chat/stream", json={"message": "find it"})
    assert resp.status_code == 200, resp.text

    assert ran == ["a", "b"]
    spans = await _spans_of(pool)
    assert _cap_spans(spans) == []
    assert _stops(spans) == []
    assert gateway.spend_reads == []
    assert (
        await pool.fetchval(
            "SELECT content FROM messages WHERE role = 'assistant' ORDER BY created_at DESC LIMIT 1"
        )
        == "done"
    )
