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
from datetime import UTC, datetime

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
    a FRESH scratch person's partition and conversation — never the owner's
    memory, conversation, messages, or Activity feed. run_case creates its own
    scratch person internally (never a pre-existing shared one — see
    test_each_case_gets_its_own_fresh_scratch_person below), so this recovers
    which identity was actually used from what the memory fake recorded."""
    gateway = ScriptedGateway(rounds=((text("KV offloading frees VRAM by moving the cache."),),))
    memory = FakeMemory()
    mount_peers(gateway=gateway, memory=memory)

    owner_id = await _owner_id(pool)

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
    # ...but the drill-in still resolves, so eval_runs can link to the trace (T3)
    # — even after cleanup has deleted the scratch conversation this turn ran in
    # (turns.conversation_id is ON DELETE SET NULL, so the trace survives it).
    drill = await owner_client.get(f"/api/v1/activity/{run.turn_id}")
    assert drill.status_code == 200
    assert drill.json()["turn"]["kind"] == "eval"

    # Memory: every recall/ingest carried the SAME scratch person id, and it is
    # not the owner's.
    await chat.drain_background()
    assert memory.recalls, "every turn recalls, even one with nothing to find"
    scratch_id = memory.recalls[-1]["person_id"]
    assert scratch_id != str(owner_id)
    assert memory.ingests, "an ordinary turn should ingest — to the scratch partition"
    assert all(i["person_id"] == scratch_id for i in memory.ingests)
    assert all(r["person_id"] == scratch_id for r in memory.recalls)

    # Cleanup's /forget hit the REAL path FakeMemory's /ingest actually
    # recorded, and got a genuine 200 back for it -- not the runner's own
    # reconstructed string compared against itself.
    ingest_day = datetime.now(UTC).date().isoformat()
    expected_path = f"people/{scratch_id}/journals/{ingest_day}.md"
    assert any(
        r["path"] == expected_path and r["status"] == 200 for r in memory.forget_results
    ), memory.forget_results

    # And that scratch identity was torn down once the case was scored — a
    # suite must not accumulate one `people` row per case run forever.
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM people WHERE id = $1", uuid.UUID(scratch_id)
        )
        == 0
    )


async def test_each_case_gets_its_own_fresh_scratch_person(owner_client, pool, mount_peers):
    """S4 carry fix (docs/plans/rebuild/slice-04-carries.md, "cross-case memory
    within the scratch person"): a scratch person REUSED across cases let one
    case's ingested exchange surface in a LATER case's recall and change that
    case's result — measured live against a real model. Two cases run in
    sequence here must never share a scratch identity: FakeMemory records the
    person_id on every recall/ingest call, so the second case's calls carrying
    a DIFFERENT person_id than the first's is the mechanical proof that,
    against the REAL memory service (which partitions recall by person_id —
    services/memory/app/api.py's /recall scopes to people/<person_id>/), case
    2's recall could never read anything case 1 ingested — the isolation
    boundary (rail 17) holds ACROSS cases, not only against the owner.
    Needs `owner_client` (unused directly) so a real owner row exists — the
    two owner-collision checks below would otherwise compare against
    str(None), proving nothing."""
    memory = FakeMemory()
    gateway = ScriptedGateway(
        rounds=(
            (text("The first case's answer."),),
            (text("The second case's answer."),),
        )
    )
    mount_peers(gateway=gateway, memory=memory)

    case1 = _case([PredicateSpec("reply_matches", r"first")], message="first question", cid="c1")
    case2 = _case([PredicateSpec("reply_matches", r"second")], message="second question", cid="c2")

    run1 = await runner.run_case(app, pool, case1, MODEL)
    run2 = await runner.run_case(app, pool, case2, MODEL)
    assert run1.passed is True
    assert run2.passed is True

    await chat.drain_background()
    assert len(memory.recalls) == 2
    person_1, person_2 = memory.recalls[0]["person_id"], memory.recalls[1]["person_id"]
    assert person_1 != person_2  # never the same scratch identity twice

    owner_id = await _owner_id(pool)
    assert person_1 != str(owner_id)
    assert person_2 != str(owner_id)

    # Each case's own ingest carried ITS OWN person_id, never the other's.
    assert len(memory.ingests) == 2
    assert memory.ingests[0]["person_id"] == person_1
    assert memory.ingests[1]["person_id"] == person_2

    # Both scratch persons were cleaned up, not left to pile up.
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM people WHERE id = ANY($1::uuid[])",
            [uuid.UUID(person_1), uuid.UUID(person_2)],
        )
        == 0
    )


async def test_scratch_person_cleanup_forgets_its_journal_and_deletes_the_row(
    pool, mount_peers
):
    """_cleanup_scratch_person's two mechanical actions, verified directly: it
    asks the memory service to forget the scratch person's own journal path
    for today (a fresh, single-use identity can only ever have written that
    one file), and it deletes the `people` row — which cascades to the
    scratch conversation and message (migration 002), so a suite does not
    litter the database. Also proves cleanup runs even on the UNGRADEABLE
    path (the gateway refused, so this case never even reached the point of
    deciding whether to ingest) — a cleanup step must never depend on the run
    having succeeded. FakeMemory's /forget answers 404 here because no path
    was ever recorded (nothing ingested) — exactly the real memory service's
    honest answer for a case that never ingested, and NOT the "ingested but
    unconfirmed" shape (see test_cleanup_surfaces_a_warning_... below), so no
    warning should land on the result."""
    memory = FakeMemory()
    gateway = ScriptedGateway(rounds=(Refusal(status=500, body={"error": {"message": "down"}}),))
    mount_peers(gateway=gateway, memory=memory)

    case = _case([PredicateSpec("reply_matches", r"anything")], message="whatever", cid="fc")
    run = await runner.run_case(app, pool, case, MODEL)
    assert run.ungradeable is True  # the gateway refused; cleanup must still run
    assert "warnings" not in run.detail  # nothing was ingested, so a 404 is unremarkable

    assert len(memory.forgets) == 1
    forgotten_person = memory.forgets[0]["person_id"]
    today = datetime.now(UTC).date().isoformat()
    assert memory.forgets[0]["path"] == f"people/{forgotten_person}/journals/{today}.md"
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM people WHERE id = $1", uuid.UUID(forgotten_person)
        )
        == 0
    )


async def test_cleanup_surfaces_a_warning_when_an_ingested_journal_cannot_be_confirmed_forgotten(
    pool, mount_peers
):
    """Item 2b: chat.py's memory_ingest span only ever records whether an
    ingest was QUEUED (meta["queued"]), never the path the memory service
    actually wrote, so cleanup's /forget target is a reconstruction. If the
    span says an ingest was queued and /forget still can't find it (a real
    outage, or the reconstruction turning out wrong), that must NOT read as
    silent success: it is surfaced on the case's own result (never masked)
    and never raises inside run_case's finally — the case's own verdict and
    the scratch person's teardown both proceed regardless.

    FakeMemory here is forced (forget_status=404) to refuse every /forget
    regardless of what it actually holds, so the queued ingest's journal
    genuinely cannot be confirmed removed — the exact shape this guards."""
    memory = FakeMemory(forget_status=404)
    gateway = ScriptedGateway(rounds=((text("An ordinary, ingesting reply."),),))
    mount_peers(gateway=gateway, memory=memory)

    case = _case(
        [PredicateSpec("reply_matches", r"ordinary")], message="a plain question", cid="warn"
    )
    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True  # the case's own verdict is untouched by cleanup trouble
    assert memory.ingests, "this case should have ingested"
    assert "warnings" in run.detail
    assert len(run.detail["warnings"]) == 1
    assert "forget" in run.detail["warnings"][0].lower()

    # Cleanup still ran to completion despite the unconfirmed forget: the
    # scratch person row is gone all the same.
    scratch_id = memory.recalls[-1]["person_id"]
    assert (
        await pool.fetchval("SELECT count(*) FROM people WHERE id = $1", uuid.UUID(scratch_id))
        == 0
    )


async def test_a_setup_phase_exception_still_deletes_the_scratch_person(
    pool, mount_peers, monkeypatch
):
    """Item 1: before this fix, the scratch person leaked if anything BETWEEN
    scratch_person() and the old inner `try` raised — the scratch conversation
    create, the seed message insert, the settings read, or traces.open_turn.
    run_case's try/finally now covers the whole body starting right after
    person creation, so a setup-phase failure still tears the person down
    before the exception propagates (there is no turn yet to score, so this
    is a harness failure the caller must see, not an ungradeable EvalRun)."""
    mount_peers(gateway=ScriptedGateway(rounds=((text("unreached"),),)), memory=FakeMemory())

    async def _boom(pool, person):
        raise RuntimeError("scratch conversation create exploded")

    monkeypatch.setattr(runner, "_scratch_conversation", _boom)

    case = _case([PredicateSpec("reply_matches", r"anything")], message="whatever", cid="boom")

    before = await pool.fetchval("SELECT count(*) FROM people WHERE role = 'guest'")
    with pytest.raises(RuntimeError, match="scratch conversation create exploded"):
        await runner.run_case(app, pool, case, MODEL)
    after = await pool.fetchval("SELECT count(*) FROM people WHERE role = 'guest'")

    assert after == before  # the scratch person THIS call created did not survive it


async def test_run_suite_sweeps_orphaned_scratch_people_first(owner_client, pool, mount_peers):
    """Item 4: a process killed mid-case (between scratch_person() and its
    finally) leaves an orphaned scratch person _cleanup_scratch_person never
    got to run for; a legacy pre-fresh-identity deployment can also still
    carry the single shared `__eval_scratch__` row (no per-case suffix) from
    before this session's fix. run_suite sweeps every guest person whose name
    starts with SCRATCH_PERSON_NAME before running any case — seeded here as
    two orphans of those exact shapes — so both are gone once the suite has
    run, while the owner (a real registered one, via `owner_client`) is
    untouched by the sweep."""
    crash_orphan_id = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, 'guest') RETURNING id",
        f"{runner.SCRATCH_PERSON_NAME}orphan-from-a-crash",
    )
    legacy_shared_id = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, 'guest') RETURNING id",
        runner.SCRATCH_PERSON_NAME,  # the exact legacy shared name, no per-case suffix
    )
    owner_id = await _owner_id(pool)

    gateway = ScriptedGateway(rounds=((text("VRAM answer."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    case = _case([PredicateSpec("reply_matches", r"VRAM")], cid="sweep-case")
    await runner.run_suite(app, pool, "corpus", MODEL, cases=[case])

    assert (
        await pool.fetchval(
            "SELECT count(*) FROM people WHERE id = ANY($1::uuid[])",
            [crash_orphan_id, legacy_shared_id],
        )
        == 0
    )
    assert await pool.fetchval("SELECT count(*) FROM people WHERE id = $1", owner_id) == 1


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
