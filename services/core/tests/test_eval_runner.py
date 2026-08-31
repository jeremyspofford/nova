"""run_case / run_suite over the REAL turn path, against a ScriptedGateway.

The scorer is proven pure in test_eval_predicates.py; here the SAME predicates
read a trace a real chat._run_turn actually left — the whole point of the slice
(measure the model by replaying it through the production funnel). The gateway is
scripted only so the trace is deterministic in a test; the DoD walk drives the
same runner against a live model.

These pin the four properties the brief names: a met contract passes and an unmet
one fails; a turn that ERRORS is ungradeable (never a fake 0); an eval run leaves
the OWNER's memory/conversation/messages/Activity untouched (rail 17) and never
tells the model it is being evaluated; and eval_runs persists with suite_version,
read back only for reporting.
"""
from __future__ import annotations

import json
import uuid

import asyncpg
import pytest

from app import chat, tools
from app.evals import runner
from app.evals.cases import Case, PredicateSpec
from app.main import app
from app.tools import web
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

pytestmark = requires_db

MODEL = "qwen3:8b"
URL = "https://example.com/pricing"
FETCH_SCHEMA = next(t.parameters for t in web.TOOLS if t.name == "fetch_url")
CONSENT_ACTION = "consent_probe"


# -- gateway chunk helpers (mirror test_chat_consent.py) -------------------


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def _call(name: str, call_id: str, arguments: dict) -> dict:
    return {
        "choices": [
            {
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": json.dumps(arguments)},
                        }
                    ]
                }
            }
        ]
    }


class Spy:
    """A tool executor that records its calls and returns a fixed result."""

    def __init__(self, result: str = "Fetched it.") -> None:
        self.calls: list = []
        self.result = result

    async def __call__(self, args: dict, ctx: ToolContext) -> str:
        self.calls.append(args)
        return self.result


def _spy_fetch(monkeypatch) -> Spy:
    """fetch_url as a spy (auto disposition per migration 008 → runs directly,
    ok=True), ephemeral like the real one."""
    spy = Spy()
    monkeypatch.setitem(
        tools.REGISTRY, "fetch_url", Tool("fetch_url", "d", FETCH_SCHEMA, spy, ephemeral=True)
    )
    return spy


async def _arm_consent_tool(pool, monkeypatch) -> Spy:
    """A private consent-tier tool + its action_classes row, so a real approval
    card is raised. Mirrors test_chat_consent.py."""
    spy = Spy()
    monkeypatch.setitem(
        tools.REGISTRY, CONSENT_ACTION, Tool(CONSENT_ACTION, "d", FETCH_SCHEMA, spy)
    )
    await pool.execute(
        "INSERT INTO action_classes (action_class, risk_tier, disposition, earned, "
        "consecutive_successes) VALUES ($1, 'outward', 'consent', false, 0) "
        "ON CONFLICT (action_class) DO UPDATE SET disposition = 'consent', "
        "earned = false, consecutive_successes = 0, updated_at = now()",
        CONSENT_ACTION,
    )
    return spy


def _case(contract, *, message="what's the latest?", suite="corpus", version=1, cid="c") -> Case:
    return Case(
        id=cid,
        suite=suite,
        suite_version=version,
        message=message,
        contract=tuple(contract),
    )


# -- a met contract passes, an unmet one fails (over a REAL trace) ----------


async def test_run_case_passes_when_the_contract_is_met(pool, mount_peers, monkeypatch):
    spy = _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=((_call("fetch_url", "c1", {"url": URL}),), (text("Here are the latest updates."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    case = _case(
        [
            PredicateSpec("tool_called", "fetch_url"),
            PredicateSpec("tool_succeeded", "fetch_url"),
            PredicateSpec("reply_matches", r"latest"),
        ]
    )
    run = await runner.run_case(app, pool, case, MODEL)

    assert spy.calls == [{"url": URL}]  # the real tool ran through the funnel
    assert run.ungradeable is False
    assert run.passed is True
    assert [p["passed"] for p in run.detail["predicates"]] == [True, True, True]
    assert run.turn_id is not None


async def test_run_case_fails_when_the_contract_is_unmet(pool, mount_peers, monkeypatch):
    """Same real trace (fetch_url WAS called), but a contract that forbids it —
    the known-bad case. passed=False, still gradeable, never faked."""
    _spy_fetch(monkeypatch)
    gateway = ScriptedGateway(
        rounds=((_call("fetch_url", "c1", {"url": URL}),), (text("Done."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    case = _case([PredicateSpec("tool_not_called", "fetch_url")])
    run = await runner.run_case(app, pool, case, MODEL)

    assert run.ungradeable is False
    assert run.passed is False
    assert run.detail["predicates"][0]["passed"] is False


# -- a turn that errors is UNGRADEABLE, never scored 0 ---------------------


async def test_a_turn_that_errors_is_ungradeable_not_a_fake_zero(pool, mount_peers):
    """Gateway refuses → the turn closes 'error'. The run is UNGRADEABLE:
    passed is None (excluded from the denominator), NEVER passed=False. The
    stated gateway reason is carried in the detail."""
    gateway = ScriptedGateway(rounds=(Refusal(status=500, body={"error": {"message": "down"}}),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    case = _case([PredicateSpec("reply_matches", r"anything")])
    run = await runner.run_case(app, pool, case, MODEL)

    assert run.ungradeable is True
    assert run.passed is None  # not False — the whole point
    assert "reason" in run.detail
    assert await pool.fetchval("SELECT status FROM turns WHERE id = $1", run.turn_id) == "error"


# -- the trace-derived predicates over a REAL card and a REAL guard ---------


async def test_consent_card_raised_over_a_real_card(pool, mount_peers, monkeypatch):
    await _arm_consent_tool(pool, monkeypatch)
    gateway = ScriptedGateway(
        rounds=((_call(CONSENT_ACTION, "c1", {"url": URL}),), (text("Awaiting your approval."),))
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    case = _case([PredicateSpec("consent_card_raised")])
    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True  # the tool span carried consent_pending=True


async def test_guard_fired_over_a_real_capability_guard(pool, mount_peers):
    """A false capability denial fires the capability_claim guard and REPLACES the
    denial in the durable reply — so guard_fired passes AND reply_absent passes."""
    denial = "I cannot access external websites or real-time data."
    gateway = ScriptedGateway(rounds=((text(denial),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    case = _case(
        [
            PredicateSpec("guard_fired", "capability_claim"),
            PredicateSpec("reply_absent", r"I cannot access"),
        ]
    )
    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True


# -- SCRATCH ISOLATION (rail 17) + NO TEST-AWARENESS LEAKAGE ----------------


async def _owner_id(pool) -> uuid.UUID:
    return await pool.fetchval("SELECT id FROM people WHERE role = 'owner'")


async def test_an_eval_run_leaves_the_owner_untouched(owner_client, pool, mount_peers):
    """rail 17, end to end. An ordinary eval turn (one that DOES ingest) writes
    the SCRATCH person's partition and conversation — never the owner's memory,
    conversation, messages, or Activity feed."""
    gateway = ScriptedGateway(rounds=((text("KV offloading frees VRAM by moving the cache."),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    owner_id = await _owner_id(pool)
    scratch = await runner.scratch_person(pool)
    assert scratch.id != owner_id  # a distinct, non-owner identity

    case = _case([PredicateSpec("reply_matches", r"VRAM")], message="what is kv offloading?")
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.passed is True

    # The owner's live state is untouched: no conversation, no message, no chat turn.
    assert await pool.fetchval(
        "SELECT count(*) FROM conversations WHERE person_id = $1", owner_id
    ) == 0
    assert await pool.fetchval(
        "SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id "
        "WHERE c.person_id = $1",
        owner_id,
    ) == 0
    assert await pool.fetchval("SELECT count(*) FROM turns WHERE kind = 'chat'") == 0
    assert await pool.fetchval("SELECT count(*) FROM turns WHERE kind = 'eval'") == 1

    # The eval turn does NOT surface in the operator's Activity feed...
    listed = (await owner_client.get("/api/v1/activity")).json()["turns"]
    assert [t["id"] for t in listed] == []
    # ...but the drill-in still resolves, so eval_runs can link to the trace (T3).
    drill = await owner_client.get(f"/api/v1/activity/{run.turn_id}")
    assert drill.status_code == 200
    assert drill.json()["turn"]["kind"] == "eval"

    # Memory: every recall/ingest carried the SCRATCH person id, never the owner's.
    await chat.drain_background()
    assert memory.ingests, "an ordinary turn should ingest — to the scratch partition"
    assert all(i["person_id"] == str(scratch.id) for i in memory.ingests)
    assert all(r["person_id"] == str(scratch.id) for r in memory.recalls)
    assert all(i["person_id"] != str(owner_id) for i in memory.ingests)


async def test_the_model_is_never_told_it_is_being_evaluated(pool, mount_peers):
    """NO TEST-AWARENESS LEAKAGE: the prompt the gateway receives is byte-identical
    to a normal turn's — the stable system prompt then the user message, nothing
    else, and no 'eval' string anywhere. The only eval-ness (kind='eval', scratch
    person) never reaches the model."""
    gateway = ScriptedGateway(rounds=((text("An answer."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    case = _case([PredicateSpec("reply_matches", r"answer")], message="a plain question")
    await runner.run_case(app, pool, case, MODEL)

    messages = gateway.payloads[0]["messages"]
    assert messages == [
        {"role": "system", "content": chat.stable_system_prompt(MODEL, tools.tool_names())},
        {"role": "user", "content": "a plain question"},
    ]
    assert "eval" not in json.dumps(messages).lower()
    assert gateway.payloads[0]["model"] == MODEL  # the chosen model is what was served


# -- persistence: suite_version stored, read back only for reporting --------


async def test_eval_runs_persisted_with_suite_version_and_read_back(pool, mount_peers):
    gateway = ScriptedGateway(rounds=((text("VRAM answer."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    case = _case([PredicateSpec("reply_matches", r"VRAM")], version=3, cid="kv")
    runs = await runner.run_suite(app, pool, "corpus", MODEL, cases=[case])
    assert len(runs) == 1 and runs[0].id is not None

    row = await pool.fetchrow("SELECT * FROM eval_runs WHERE id = $1", runs[0].id)
    assert row["suite"] == "corpus"
    assert row["suite_version"] == 3
    assert row["model"] == MODEL
    assert row["case_id"] == "kv"
    assert row["passed"] is True
    assert row["ungradeable"] is False
    assert row["turn_id"] == runs[0].turn_id

    read = await runner.runs_for(pool, "corpus", 3, MODEL)
    assert [r["id"] for r in read] == [runs[0].id]


async def test_suite_version_comparability_never_mixes_versions(pool, mount_peers):
    """A score is only comparable within a version: two runs of the same case at
    v1 and v2 do not blend — runs_for(v1) returns only the v1 row."""
    gateway = ScriptedGateway(rounds=((text("one"),), (text("two"),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    case_v1 = _case([PredicateSpec("reply_matches", "one")], version=1)
    case_v2 = _case([PredicateSpec("reply_matches", "two")], version=2)
    v1 = await runner.run_suite(app, pool, "corpus", MODEL, cases=[case_v1])
    v2 = await runner.run_suite(app, pool, "corpus", MODEL, cases=[case_v2])

    at_v1 = await runner.runs_for(pool, "corpus", 1, MODEL)
    at_v2 = await runner.runs_for(pool, "corpus", 2, MODEL)
    assert [r["id"] for r in at_v1] == [v1[0].id]
    assert [r["id"] for r in at_v2] == [v2[0].id]


async def test_persist_refuses_a_fake_zero_for_an_ungradeable_run(pool):
    """The DB CHECK makes 'ungradeable != 0' an invariant, not a convention: a row
    that says ungradeable yet carries a pass/fail (or vice versa) is refused by
    postgres, so a fabricated number can never be stored even by a buggy caller."""
    bad_pass = runner.EvalRun(
        case_id="x", suite="s", suite_version=1, model=MODEL, passed=True, ungradeable=True
    )
    with pytest.raises(asyncpg.exceptions.CheckViolationError):
        await runner.persist_run(pool, bad_pass)

    bad_none = runner.EvalRun(
        case_id="x", suite="s", suite_version=1, model=MODEL, passed=None, ungradeable=False
    )
    with pytest.raises(asyncpg.exceptions.CheckViolationError):
        await runner.persist_run(pool, bad_none)


async def test_run_suite_persists_all_and_score_summary_excludes_ungradeable(pool, mount_peers):
    """A suite with a passing case and an errored (ungradeable) case: both persist,
    but the pass rate's denominator is the gradeable one only — never scored as
    1/2 by counting the ungradeable run as a 0."""
    gateway = ScriptedGateway(
        rounds=(
            (text("VRAM answer."),),  # case 1: the reply
            Refusal(status=500, body={"error": {"message": "down"}}),  # case 2: errors
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    cases = [
        _case([PredicateSpec("reply_matches", "VRAM")], cid="ok"),
        _case([PredicateSpec("reply_matches", "whatever")], cid="err"),
    ]
    runs = await runner.run_suite(app, pool, "corpus", MODEL, cases=cases)

    assert [(r.case_id, r.passed, r.ungradeable) for r in runs] == [
        ("ok", True, False),
        ("err", None, True),
    ]
    assert await pool.fetchval("SELECT count(*) FROM eval_runs") == 2

    summary = runner.score_summary(runs)
    assert summary == {
        "total": 2,
        "gradeable": 1,
        "ungradeable": 1,
        "passed": 1,
        "pass_rate": 1.0,
    }
