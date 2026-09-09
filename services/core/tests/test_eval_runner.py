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

import asyncio
import json
import uuid
from datetime import UTC, datetime

import anyio
import asyncpg
import pytest

from app import chat, tools
from app.evals import cases as cases_mod
from app.evals import runner
from app.evals.cases import Case, CaseError, FixtureAgent, PredicateSpec
from app.main import MIGRATIONS_DIR, app
from app.migrations_runner import discover_migrations
from app.tools import web
from app.tools.base import Tool, ToolContext
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

pytestmark = requires_db

MODEL = "qwen3:8b"
URL = "https://example.com/pricing"
FETCH_SCHEMA = next(t.parameters for t in web.TOOLS if t.name == "fetch_url")


# -- gateway chunk helpers (mirror test_chat_pending_claim.py) -------------


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
    """fetch_url as a spy (every registered tool runs: ok=True), ephemeral like
    the real one."""
    spy = Spy()
    monkeypatch.setitem(
        tools.REGISTRY, "fetch_url", Tool("fetch_url", "d", FETCH_SCHEMA, spy, ephemeral=True)
    )
    return spy


def _case(
    contract, *, message="what's the latest?", suite="corpus", version=1, cid="c", agents=()
) -> Case:
    return Case(
        id=cid,
        suite=suite,
        suite_version=version,
        message=message,
        contract=tuple(contract),
        agents=tuple(agents),
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
    gateway = ScriptedGateway(rounds=((_call("fetch_url", "c1", {"url": URL}),), (text("Done."),)))
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


# -- the trace-derived predicates over a REAL guard --------------------------


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
    assert (
        await pool.fetchval("SELECT count(*) FROM conversations WHERE person_id = $1", owner_id)
        == 0
    )
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id "
            "WHERE c.person_id = $1",
            owner_id,
        )
        == 0
    )
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
    assert any(r["path"] == expected_path and r["status"] == 200 for r in memory.forget_results), (
        memory.forget_results
    )

    # And that scratch identity was torn down once the case was scored — a
    # suite must not accumulate one `people` row per case run forever.
    assert (
        await pool.fetchval("SELECT count(*) FROM people WHERE id = $1", uuid.UUID(scratch_id)) == 0
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


async def test_scratch_person_cleanup_forgets_its_journal_and_deletes_the_row(pool, mount_peers):
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
        await pool.fetchval("SELECT count(*) FROM people WHERE id = $1", uuid.UUID(scratch_id)) == 0
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


# -- a suite run is a job with a row (migration 016) ------------------------


def test_migration_016_is_discovered_after_the_eval_ledger_it_extends():
    """016 adds eval_runs.run_id and the suite-run table it references, so it
    can only ever run after 010 created eval_runs. Ordering, not position: a
    later migration may follow."""
    names = [p.name for p in discover_migrations(MIGRATIONS_DIR)]
    assert "016_eval_suite_runs.sql" in names
    assert names.index("010_eval_runs.sql") < names.index("016_eval_suite_runs.sql")


async def test_run_suite_records_the_run_and_stamps_every_row_with_it(pool, mount_peers):
    """run_suite is ONE recorded run: a 'running' row opened before the first
    case, closed 'done' with an ended_at after the last, and every eval_runs
    row it persisted carries that run's id — so the page can read a run as a
    unit, never as latest-per-case across runs."""
    gateway = ScriptedGateway(rounds=((text("VRAM answer."),), (text("second"),)))
    mount_peers(gateway=gateway, memory=FakeMemory())

    cases = [
        _case([PredicateSpec("reply_matches", "VRAM")], cid="kv"),
        _case([PredicateSpec("reply_matches", "second")], cid="two"),
    ]
    runs = await runner.run_suite(app, pool, "corpus", MODEL, cases=cases)

    row = await pool.fetchrow("SELECT * FROM eval_suite_runs")
    assert row["status"] == "done"
    assert row["suite"] == "corpus" and row["suite_version"] == 1 and row["model"] == MODEL
    assert row["case_count"] == 2
    assert row["ended_at"] is not None and row["error"] is None
    assert [r.run_id for r in runs] == [row["id"], row["id"]]
    assert await pool.fetchval("SELECT count(*) FROM eval_runs WHERE run_id = $1", row["id"]) == 2
    assert [r["case_id"] for r in await runner.runs_in(pool, row["id"])] == ["kv", "two"]
    assert runner.RUNNING == set()  # released at the close


async def test_a_second_suite_run_is_refused_by_the_database_while_one_runs(pool, mount_peers):
    """One at a time is postgres's invariant (eval_suite_runs_one_running), not
    a flag: with a 'running' row present, open_suite_run raises SuiteRunActive
    naming it — for ANY model, the GPU being shared."""
    mount_peers(gateway=ScriptedGateway(rounds=()), memory=FakeMemory())
    held = await runner.open_suite_run(pool, "corpus", 1, MODEL, 1)

    with pytest.raises(runner.SuiteRunActive) as refused:
        await runner.open_suite_run(pool, "corpus", 1, "other:1b", 1)
    assert refused.value.active["id"] == held["id"]
    assert MODEL in str(refused.value) and str(held["id"]) in str(refused.value)
    assert await pool.fetchval("SELECT count(*) FROM eval_suite_runs") == 1

    await runner.close_suite_run(pool, held["id"], runner.SUITE_RUN_DONE, None)
    after = await runner.open_suite_run(pool, "corpus", 1, "other:1b", 1)  # the slot is free
    assert after["id"] != held["id"]
    await runner.close_suite_run(pool, after["id"], runner.SUITE_RUN_DONE, None)


async def test_a_harness_failure_closes_the_run_error_with_the_reason(
    pool, mount_peers, monkeypatch
):
    """A case failure is never masked as success: when something escapes
    run_case (a harness failure — here the scratch conversation create), the
    row closes 'error' with the exception stated, the rows already persisted
    stand, and nothing reads 'done'."""
    gateway = ScriptedGateway(rounds=((text("VRAM answer."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    real_create = runner._scratch_conversation
    calls = 0

    async def _second_case_explodes(pool, person):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("scratch conversation create exploded")
        return await real_create(pool, person)

    monkeypatch.setattr(runner, "_scratch_conversation", _second_case_explodes)
    cases = [
        _case([PredicateSpec("reply_matches", "VRAM")], cid="ok"),
        _case([PredicateSpec("reply_matches", "never")], cid="boom"),
    ]
    row = await runner.open_suite_run(pool, "corpus", 1, MODEL, len(cases))
    runs = await runner.run_suite_job(app, pool, row["id"], cases, MODEL)

    assert [r.case_id for r in runs] == ["ok"]  # the first landed, the second never scored
    after = await pool.fetchrow("SELECT status, error, ended_at FROM eval_suite_runs")
    assert after["status"] == "error"
    assert "scratch conversation create exploded" in after["error"]
    assert after["ended_at"] is not None
    assert await pool.fetchval("SELECT count(*) FROM eval_runs") == 1
    assert runner.RUNNING == set()


async def _until(predicate, *, what: str, timeout: float = 10.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"timed out after {timeout}s waiting for {what}")
        await asyncio.sleep(0.02)


async def _scratch_count(pool) -> int:
    return await pool.fetchval(
        "SELECT count(*) FROM people WHERE role = $1 AND starts_with(name, $2)",
        runner.SCRATCH_PERSON_ROLE,
        runner.SCRATCH_PERSON_NAME,
    )


async def test_a_cancellation_mid_turn_still_deletes_the_scratch_person(pool, mount_peers):
    """The live leak: starlette/anyio cancellation re-raises CancelledError at
    EVERY await of the cancelled task, so run_case's cleanup used to die at
    its first await (the /forget call) before DELETE FROM people — two
    orphaned scratch rows were found in the running stack. The cleanup is now
    its own shielded task: the case is cancelled mid-LLM-call here (an anyio
    cancel scope, the exact delivery shape), the CancelledError still
    propagates, and once the detached work has drained NO scratch person
    remains — a plain task.cancel() would not exercise this (it delivers
    once, so an unshielded finally would run anyway)."""
    hold = asyncio.Event()
    gateway = ScriptedGateway(rounds=((text("never delivered"),),), hold=hold, hold_before=0)
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = _case([PredicateSpec("reply_matches", r"anything")], cid="cancelled")

    async with anyio.create_task_group() as tg:
        tg.start_soon(runner.run_case, app, pool, case, MODEL)
        await _until(lambda: gateway.calls >= 1, what="the turn to reach the gateway")
        assert await _scratch_count(pool) == 1  # mid-turn: the scratch person exists
        tg.cancel_scope.cancel()

    await asyncio.wait_for(chat.drain_background(), timeout=10)
    assert await _scratch_count(pool) == 0
    hold.set()


async def test_a_cancelled_suite_job_closes_its_row_interrupted_and_cleans_up(pool, mount_peers):
    """Same delivery shape at the JOB level: a cancelled run_suite_job still
    closes its row — 'interrupted', with the count of cases that had landed
    stated — and leaves no scratch person and no 'running' row behind."""
    hold = asyncio.Event()
    gateway = ScriptedGateway(
        rounds=((text("one"),), (text("never delivered"),)), hold=hold, hold_before=1
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    cases = [
        _case([PredicateSpec("reply_matches", "one")], cid="first"),
        _case([PredicateSpec("reply_matches", "two")], cid="second"),
    ]
    row = await runner.open_suite_run(pool, "corpus", 1, MODEL, len(cases))

    async with anyio.create_task_group() as tg:
        tg.start_soon(runner.run_suite_job, app, pool, row["id"], cases, MODEL)
        await _until(lambda: gateway.calls >= 2, what="the second case to reach the gateway")
        tg.cancel_scope.cancel()

    await asyncio.wait_for(chat.drain_background(), timeout=10)
    after = await pool.fetchrow("SELECT status, error, ended_at FROM eval_suite_runs")
    assert after["status"] == "interrupted"
    assert "1 of 2" in after["error"]
    assert after["ended_at"] is not None
    assert await pool.fetchval("SELECT count(*) FROM eval_runs WHERE run_id = $1", row["id"]) == 1
    assert await _scratch_count(pool) == 0
    assert runner.RUNNING == set()
    hold.set()


class _Halt(BaseException):
    """Not an Exception and not a cancellation — the KeyboardInterrupt /
    SystemExit shape, without pytest's own handling of those two."""


async def test_a_base_exception_in_the_job_still_closes_the_row_error_with_the_type(
    pool, mount_peers, monkeypatch
):
    """A BaseException that is neither Exception nor CancelledError propagates
    out of run_suite_job — but the row must still close, and close 'error'
    WITH a reason: the table refuses a silent 'error'
    (eval_suite_runs_error_states_why), so a close with error=NULL would trip
    the CHECK, be logged as "could not close", and leave the row 'running'
    until the next startup sweep."""
    gateway = ScriptedGateway(rounds=((text("VRAM answer."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    async def _halt(pool, person):
        raise _Halt("the process is going down")

    monkeypatch.setattr(runner, "_scratch_conversation", _halt)
    cases = [_case([PredicateSpec("reply_matches", "VRAM")], cid="never")]
    row = await runner.open_suite_run(pool, "corpus", 1, MODEL, len(cases))

    with pytest.raises(_Halt):
        await runner.run_suite_job(app, pool, row["id"], cases, MODEL)
    await asyncio.wait_for(chat.drain_background(), timeout=10)

    after = await pool.fetchrow("SELECT status, error, ended_at FROM eval_suite_runs")
    assert after["status"] == "error"
    assert "_Halt" in after["error"] and "0 of 1" in after["error"]
    assert after["ended_at"] is not None
    assert await _scratch_count(pool) == 0
    assert runner.RUNNING == set()


class _HeldIngestMemory(FakeMemory):
    """FakeMemory whose /ingest parks until released — so a test can place a
    cancellation BETWEEN the reply and the ingest landing."""

    def __post_init__(self) -> None:
        super().__post_init__()
        self.ingest_reached = asyncio.Event()
        self.release_ingest = asyncio.Event()

    async def _ingest(self, request):
        self.ingest_reached.set()
        await self.release_ingest.wait()
        return await super()._ingest(request)


async def test_a_cancellation_between_the_reply_and_its_ingest_still_forgets_the_journal(
    pool, mount_peers
):
    """The scored path settles the turn's queued ingest before cleanup; a
    cancellation landing after the reply but before that settle skipped it,
    so cleanup's /forget could run BEFORE the ingest wrote the journal — a
    404 from /forget, then the write, and the scratch journal outlived its
    person. The cleanup task now settles first itself, on every path: here
    the ingest is parked, the case is cancelled, and /forget is not attempted
    until the ingest has landed — then it finds the file (200) and no journal
    remains."""
    memory = _HeldIngestMemory()
    gateway = ScriptedGateway(rounds=((text("VRAM answer."),),))
    mount_peers(gateway=gateway, memory=memory)
    case = _case([PredicateSpec("reply_matches", "VRAM")], cid="between")

    async with anyio.create_task_group() as tg:
        tg.start_soon(runner.run_case, app, pool, case, MODEL)
        await asyncio.wait_for(memory.ingest_reached.wait(), timeout=10)
        tg.cancel_scope.cancel()

    # The cleanup is detached now; give an unsettled one time to reach /forget.
    await asyncio.sleep(0.2)
    assert memory.forgets == []  # nothing forgotten while the ingest is still in flight

    memory.release_ingest.set()
    await asyncio.wait_for(chat.drain_background(), timeout=10)
    assert [f["status"] for f in memory.forget_results] == [200]
    assert memory.journal_paths == set()  # the journal did not outlive its person
    assert await _scratch_count(pool) == 0


# -- THE DECLARED WORLD: a case's fixture agents (2026-09-09) ---------------
#
# Why the hook exists at all: guards.delegation_claim_check is derived from
# the LIVE roster (chat._agent_names -> agents.names) and returns None by
# construction when it is empty, and agents.delegate refuses a name no row
# has. In a scratch world with no agents rows, every agent case would score
# green with the checked thing unable to happen — the vacuous pass that kept
# the delegation case deferred. These pin the mechanism: the world is built
# through the PRODUCT's writer, it is really there for the turn, it never
# outlives the case however the case ends, a world that cannot be built is
# UNGRADEABLE rather than a fail, and a case that declares nothing behaves
# exactly as it did before the hook existed.


@pytest.fixture
async def world(pool, monkeypatch, tmp_path):
    """The installed state agents.create needs: a workspace root on disk (it
    makes agents/<name>/ and refuses to report a create whose folder it
    cannot read back) and the owner row an agent's log conversation belongs
    to. Nothing eval-specific — a live instance already has both."""
    monkeypatch.setenv("WORKSPACE_ROOT", str(tmp_path / "ws"))
    await pool.execute("INSERT INTO people (name, role) VALUES ('jeremy', 'owner')")


def _fixture_agent(name="eval_probe", **over) -> FixtureAgent:
    return FixtureAgent(
        name=name,
        purpose=over.pop("purpose", "answers eval probes"),
        instructions=over.pop("instructions", "Do the small thing you are asked for."),
        tools=over.pop("tools", ("workspace_read_file",)),
        max_tool_rounds=over.pop("max_tool_rounds", 2),
    )


def _system_text(gateway: ScriptedGateway) -> str:
    return "\n".join(m["content"] for m in gateway.payloads[0]["messages"] if m["role"] == "system")


async def test_a_case_that_declares_no_agents_makes_no_agent_query_at_all(
    pool, mount_peers, monkeypatch
):
    """The pinned no-op. A case with no `agents` must behave EXACTLY as it did
    before the hook: not "creates nothing" (which a read-then-skip would also
    satisfy) but touches app.agents not once — so the hook can never cost a
    round trip, a ledger event, or a lock on a corpus that declares nothing."""

    def _never(*args, **kwargs):
        raise AssertionError("a case that declares no agents must not reach app.agents")

    for name in ("by_name", "create", "delete"):
        monkeypatch.setattr(runner.agents, name, _never)

    mount_peers(gateway=ScriptedGateway(rounds=((text("A plain answer."),),)), memory=FakeMemory())
    case = _case([PredicateSpec("reply_matches", "plain")], cid="no-agents")
    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True, run.detail
    assert "warnings" not in run.detail
    assert await pool.fetchval("SELECT count(*) FROM agents") == 0


async def test_a_declared_agent_is_in_the_live_roster_for_the_turn_and_gone_after(
    pool, world, mount_peers
):
    """The whole hook end to end. The row is built by app/agents.py's own
    writer before the turn — so the roster line the prompt carries (read from
    the TABLE every turn by agents.roster_line) names it, which is the fact
    the guard and the delegate tool both read — and afterwards nothing of it
    is left: not the row, not the log conversation agents.create made for it,
    and the governance ledger says who did both."""
    gateway = ScriptedGateway(rounds=((text("Noted."),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = _case(
        [PredicateSpec("reply_matches", "noted")], cid="declared", agents=[_fixture_agent()]
    )

    conversations_before = await pool.fetchval("SELECT count(*) FROM conversations")
    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True, run.detail
    assert "warnings" not in run.detail
    # DURING the turn: the agent was in the roster the model was shown.
    assert "eval_probe" in _system_text(gateway)
    # AFTER: the row, and the conversation the writer created with it, are gone.
    assert await runner.agents.by_name(pool, "eval_probe") is None
    assert await pool.fetchval("SELECT count(*) FROM conversations") == conversations_before
    # The ledger records BOTH writes, and names the harness — never the owner.
    events = await pool.fetch("SELECT kind, actor FROM governance_events ORDER BY created_at, id")
    assert [row["kind"] for row in events] == ["agent.created", "agent.deleted"]
    assert {row["actor"] for row in events} == {"eval harness (case declared)"}


async def test_a_declared_world_that_cannot_be_built_is_ungradeable_not_a_fail(
    pool, world, mount_peers
):
    """A spec the product's validator refuses (a tool no registry entry has)
    is a HARNESS failure: the model was never asked anything, so scoring it 0
    would be a fabricated verdict. It is ungradeable with the writer's own
    words, the turn never runs, and nothing is left behind."""
    gateway = ScriptedGateway(rounds=((text("unreached"),),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = _case(
        [PredicateSpec("reply_matches", "anything")],
        cid="unbuildable",
        agents=[_fixture_agent(tools=("no_such_tool",))],
    )

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.ungradeable is True
    assert run.passed is None
    assert "no tool named 'no_such_tool'" in run.detail["reason"]
    assert run.turn_id is None
    assert gateway.calls == 0  # no model round was ever asked for
    assert await pool.fetchval("SELECT count(*) FROM agents") == 0
    assert await _scratch_count(pool) == 0


async def test_a_half_built_world_is_still_fully_torn_down(pool, world, mount_peers):
    """Two agents declared, the SECOND refused: the first one really landed,
    and the teardown has to take it with it. _create_fixture_agents appends
    into the caller's list as each row lands precisely so a build that fails
    halfway still hands the finally everything that exists."""
    mount_peers(gateway=ScriptedGateway(rounds=((text("unreached"),),)), memory=FakeMemory())
    case = _case(
        [PredicateSpec("reply_matches", "anything")],
        cid="half-built",
        agents=[
            _fixture_agent(name="eval_first"),
            _fixture_agent(name="eval_second", tools=("nope",)),
        ],
    )

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.ungradeable is True
    assert await pool.fetchval("SELECT count(*) FROM agents") == 0


async def test_the_declared_world_is_torn_down_even_when_the_turn_errors(pool, world, mount_peers):
    """Same rule as the scratch person's: teardown never depends on the run
    having succeeded. The gateway refuses, the run is ungradeable, and the
    agent is still gone."""
    gateway = ScriptedGateway(rounds=(Refusal(status=500, body={"error": {"message": "down"}}),))
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = _case(
        [PredicateSpec("reply_matches", "anything")], cid="errored", agents=[_fixture_agent()]
    )

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.ungradeable is True
    assert await pool.fetchval("SELECT count(*) FROM agents") == 0


async def test_an_orphan_from_a_killed_run_is_replaced_not_reused(pool, world, mount_peers):
    """A process killed mid-case leaves its fixture agent behind. The next run
    of that case deletes the orphan and builds a fresh row rather than reusing
    a row whose state nobody knows — and only ever for a name the case itself
    declared, every one of which carries cases.FIXTURE_AGENT_PREFIX."""
    mount_peers(gateway=ScriptedGateway(rounds=((text("Noted."),),)), memory=FakeMemory())
    orphan = await runner.agents.create(
        pool,
        app,
        runner.agents.AgentSpec(
            name="eval_probe",
            purpose="left behind by a killed run",
            instructions="stale",
            tools=("workspace_read_file",),
            max_tool_rounds=2,
        ),
        created_via="page",
        created_turn_id=None,
        actor="a run that died",
        # The same door the runner's own writer call uses: only the harness
        # can make a reserved-prefix name, so an orphan of a killed run is
        # made the way the killed run would have made it. (2026-09-09)
        allow_reserved_prefix=True,
    )
    case = _case([PredicateSpec("reply_matches", "noted")], cid="orphan", agents=[_fixture_agent()])

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True, run.detail
    assert await pool.fetchval("SELECT count(*) FROM agents") == 0
    # The orphan's own log conversation went with it, not just the fresh one.
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM conversations WHERE id = $1", orphan.agent.log_conversation_id
        )
        == 0
    )


# -- a failure the model under test did not cause (2026-09-09) --------------


async def test_a_contract_that_fails_for_its_own_reason_stays_false_beside_a_child_error(
    pool, world, mount_peers
):
    """The cut is DERIVED from the FAILING PREDICATE'S OWN ARG, not from "a
    delegation went wrong somewhere in this turn".

    Here a child turn really did error, but the predicate that failed is
    about a different tool she simply never called — that failure is hers,
    and excusing it because something else in the same turn broke would hand
    a model a free pass on a check it flunked. So: FALSE, with the reason
    field absent, while the very same trace scored against a delegation
    contract is UNGRADEABLE (test_eval_corpus.py drives that half).
    """
    gateway = ScriptedGateway(
        rounds=(
            (_call("delegate_to_agent", "c1", {"agent": "eval_probe", "task": "do the thing"}),),
            Refusal(status=500, body={"error": {"message": "the chain is down"}}),
            (text("eval_probe's turn errored — nothing came back."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = _case(
        [PredicateSpec("tool_succeeded", "list_agents")],
        cid="own-reason",
        agents=[_fixture_agent()],
    )

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.ungradeable is False
    assert run.passed is False
    assert "reason" not in run.detail
    # The child really did error — this is not a trace where nothing happened.
    assert (
        await pool.fetchval("SELECT count(*) FROM turns WHERE kind = 'agent' AND status = 'error'")
        == 1
    )


async def test_a_reply_predicate_naming_the_same_tool_is_not_excused_by_a_child_error(
    pool, world, mount_peers
):
    """The coincidence the counterfactual closes. A reply predicate's arg is a
    REGEX, not a tool name — reply_absent('delegate_to_agent') is a reasonable
    contract ("don't recite the tool's name at me") — and it must not be
    excused just because a delegate span in the same turn happens to carry
    that text. The predicate is re-run with the span's ok flipped; it still
    fails, because the reply is unchanged, so the FALSE stands."""
    gateway = ScriptedGateway(
        rounds=(
            (_call("delegate_to_agent", "c1", {"agent": "eval_probe", "task": "do the thing"}),),
            Refusal(status=500, body={"error": {"message": "the chain is down"}}),
            (text("I called delegate_to_agent and its turn errored."),),
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())
    case = _case(
        [PredicateSpec("reply_absent", "delegate_to_agent")],
        cid="regex-arg",
        agents=[_fixture_agent()],
    )

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.ungradeable is False
    assert run.passed is False
    assert "reason" not in run.detail


# -- what a fixture leaves on DISK, and the orphan sweep (2026-09-09) -------
#
# The review's two smaller findings, both about state that outlived its case.
# The docstring used to call the leftover folder empty and harmless; it is
# neither, because delegates-the-write-to-an-agent exists to make an agent
# really write a file into it, under the same WORKSPACE_ROOT Nova's own
# workspace tools read. And a process killed mid-case reaches no teardown at
# all, so its row sat in the roster forever — on the Agents page, in every
# chat prompt's roster line, arming the delegation guard for a name that will
# never do anything.


async def _delete_through_the_deleter(pool, agent):
    return await runner._delete_fixture_agent(app, pool, agent, "a test")


async def _make_fixture_agent(pool, name="eval_probe"):
    """A fixture row made the way the runner makes one — through the
    product's writer, with the harness's keyword door onto the reserved
    prefix."""
    result = await runner.agents.create(
        pool,
        app,
        runner.agents.AgentSpec(
            name=name,
            purpose="p",
            instructions="i",
            tools=("workspace_read_file",),
            max_tool_rounds=2,
        ),
        created_via="page",
        created_turn_id=None,
        actor="a test",
        allow_reserved_prefix=True,
    )
    return result.agent


async def test_a_fixture_agents_folder_and_the_files_in_it_go_with_it(pool, world):
    """The stated remainder was wrong. agents.delete keeps an agent's folder
    by DESIGN (an operator's agent has files worth reading afterwards), so
    the file the delegation case exists to have written was surviving every
    suite run inside the world the NEXT case is scored in — cross-case
    contamination wearing a filesystem instead of a memory partition."""
    agent = await _make_fixture_agent(pool)
    folder = runner.agents.folder_for(agent)
    assert folder.is_dir()  # agents.create made it and read it back
    (folder / "hello.md").write_text("hello from nova", encoding="utf-8")

    warnings = await _delete_through_the_deleter(pool, agent)

    assert warnings == []
    assert not folder.exists()
    assert await runner.agents.by_name(pool, agent.name) is None


async def test_removing_a_folder_is_refused_for_a_name_outside_the_reserved_prefix(pool, world):
    """The line that refuses. This is the one place in the harness that
    deletes a directory tree, and the ONLY thing standing between it and an
    agent the owner made is the prefix — so the prefix is checked here, not
    assumed from the callers. A refusal, and a stated one: the folder stays
    and the caller is told, never a silent skip."""
    owner_agent = await runner.agents.create(
        pool,
        app,
        runner.agents.AgentSpec(
            name="coder", purpose="p", instructions="i", tools=("workspace_read_file",)
        ),
        created_via="page",
        created_turn_id=None,
        actor="jeremy",
    )
    folder = runner.agents.folder_for(owner_agent.agent)
    (folder / "notes.md").write_text("the owner's own file", encoding="utf-8")

    warnings = runner._remove_fixture_folder(owner_agent.agent)

    assert len(warnings) == 1
    assert "refused to remove the folder" in warnings[0]
    assert folder.is_dir()
    assert (folder / "notes.md").read_text(encoding="utf-8") == "the owner's own file"


async def test_a_scored_case_leaves_no_fixture_folder_behind(pool, world, mount_peers):
    """End to end, through run_case's own finally: nothing of the declared
    world is on disk once the case is scored."""
    mount_peers(gateway=ScriptedGateway(rounds=((text("Noted."),),)), memory=FakeMemory())
    case = _case([PredicateSpec("reply_matches", "noted")], cid="disk", agents=[_fixture_agent()])

    run = await runner.run_case(app, pool, case, MODEL)

    assert run.passed is True, run.detail
    assert "warnings" not in run.detail
    assert not (runner.agents.root_from_env() / "agents" / "eval_probe").exists()


async def test_a_suite_job_sweeps_orphaned_fixture_agents_before_it_scores(
    pool, world, mount_peers
):
    """The leak run_case's finally cannot close: a process KILLED mid-case
    never reaches a finally, and unlike an orphaned scratch person the row it
    leaves is live state — the Agents page lists it, agents.roster_line puts
    it in every chat prompt, and guards.delegation_claim_check is armed for a
    name that will never do anything.

    Safe to sweep by PREFIX for two mechanical reasons, and this pins the
    second: ONE suite runs at a time (so no live case's world is reachable),
    and app/agents.py RESERVES the prefix, so a row carrying it can only have
    come from this harness. An agent the owner made — a name the roster CAN
    hold — is untouched, and that assertion is the one that would go red if
    the sweep ever widened."""
    orphan = await _make_fixture_agent(pool, name="eval_left_behind")
    orphan_folder = runner.agents.folder_for(orphan)
    (orphan_folder / "stale.md").write_text("from a run that died", encoding="utf-8")
    owner_agent = await runner.agents.create(
        pool,
        app,
        runner.agents.AgentSpec(
            name="coder", purpose="p", instructions="i", tools=("workspace_read_file",)
        ),
        created_via="page",
        created_turn_id=None,
        actor="jeremy",
    )

    mount_peers(gateway=ScriptedGateway(rounds=((text("Swept."),),)), memory=FakeMemory())
    case = _case([PredicateSpec("reply_matches", "swept")], cid="sweep-agents")
    await runner.run_suite(app, pool, "corpus", MODEL, cases=[case])

    # The orphan is gone — row, log conversation and folder.
    assert await runner.agents.by_name(pool, "eval_left_behind") is None
    assert not orphan_folder.exists()
    assert (
        await pool.fetchval(
            "SELECT count(*) FROM conversations WHERE id = $1", orphan.log_conversation_id
        )
        == 0
    )
    # The owner's agent is untouched — row AND folder.
    assert await runner.agents.by_name(pool, "coder") is not None
    assert runner.agents.folder_for(owner_agent.agent).is_dir()


def test_a_declared_agent_name_must_carry_the_reserved_prefix():
    """The load-time rule that makes the teardown safe to run at all: the
    runner deletes rows by name, so a name a case may declare must be one the
    owner's roster can never hold. Refused at LOAD, by the loader, not by a
    convention someone remembers."""
    with pytest.raises(CaseError, match="must start with 'eval_'"):
        FixtureAgent(name="coder", purpose="p", instructions="i", tools=("get_time",))
    with pytest.raises(CaseError, match="must start with 'eval_'"):
        cases_mod.agent_from_dict(
            {"name": "coder", "purpose": "p", "instructions": "i", "tools": ["get_time"]}
        )
    # ... and the ordinary declaration parses, with the optional field absent.
    parsed = cases_mod.agent_from_dict(
        {"name": "eval_coder", "purpose": "p", "instructions": "i", "tools": ["get_time"]}
    )
    assert parsed == FixtureAgent(
        name="eval_coder", purpose="p", instructions="i", tools=("get_time",)
    )
    assert parsed.max_tool_rounds is None
