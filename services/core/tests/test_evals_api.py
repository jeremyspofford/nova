"""The authed evals API — the AI Quality page's backend (S4-T3), as a JOB.

GET /suites lists the git corpus (the T2 `agent_quality` suite among them).
POST /run opens an eval_suite_runs row, spawns the run DETACHED and answers 202
before any case lands; the run's truth is the row (GET /runs/active, GET
/runs/{id}), never the HTTP connection — a client that hangs up never stops
it, and a second POST while one is running is a 409 naming the active run,
refused by the database's one-at-a-time index. GET /runs returns the latest
COMPLETE run for a suite's CURRENT version and never blends it with a partial
(interrupted) one or another version. Every route refuses an unauthenticated
caller, and no fake number is ever produced (a summary exists only for a
'done' run; pass_rate is null on an empty set, not 0).

The run route loads its cases from the git corpus, which a test cannot hand an
explicit list — so these monkeypatch `cases.load_suite` to a tiny deterministic
suite, exactly the seam the route reads through. The scoring/persistence path
underneath is the same one test_eval_runner.py already proves against a real
trace; here the concern is the ROUTE and the RECORD (auth, 202-then-poll, the
409, the sweep, the latest-complete read), not the scorer.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid

from app import chat
from app.evals import cases as cases_mod
from app.evals import runner
from app.evals.cases import Case, PredicateSpec
from app.main import app, lifespan
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

pytestmark = requires_db

MODEL = "qwen3:8b"
RUN = "/api/v1/evals/run"
ACTIVE = "/api/v1/evals/runs/active"


def text(piece: str) -> dict:
    return {"choices": [{"delta": {"content": piece}}]}


def _case(cid: str, contract, *, message: str, suite: str = "probe", version: int = 1) -> Case:
    return Case(
        id=cid,
        suite=suite,
        suite_version=version,
        message=message,
        contract=tuple(contract),
    )


def _use_suite(monkeypatch, suite_cases: list[Case]) -> None:
    monkeypatch.setattr(cases_mod, "load_suite", lambda suite, cases_dir=None: suite_cases)


async def _until(predicate, *, what: str, timeout: float = 10.0) -> None:
    """Wait for a REAL fact (a row landing, a call arriving) with a bound —
    never a sleep of a guessed length. `predicate` may be sync or async."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        value = predicate()
        if asyncio.iscoroutine(value):
            value = await value
        if value:
            return
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError(f"timed out after {timeout}s waiting for {what}")
        await asyncio.sleep(0.02)


async def _scratch_count(pool) -> int:
    return await pool.fetchval(
        "SELECT count(*) FROM people WHERE role = $1 AND starts_with(name, $2)",
        runner.SCRATCH_PERSON_ROLE,
        runner.SCRATCH_PERSON_NAME,
    )


async def _drain() -> None:
    await asyncio.wait_for(chat.drain_background(), timeout=15)


# -- GET /suites -----------------------------------------------------------


async def test_suites_lists_the_real_agent_quality_corpus(owner_client):
    """The git corpus is served as-is: the T2 suite appears with its real
    version and case count, derived from the fixtures, never a maintained list."""
    body = (await owner_client.get("/api/v1/evals/suites")).json()
    by_id = {s["suite"]: s for s in body["suites"]}

    assert "agent_quality" in by_id
    real = cases_mod.load_suite("agent_quality")
    assert by_id["agent_quality"]["suite_version"] == real[0].suite_version
    assert by_id["agent_quality"]["case_count"] == len(real)


async def test_suites_requires_auth(client):
    assert (await client.get("/api/v1/evals/suites")).status_code == 401


# -- POST /run: a detached job, answered 202, read back from its row --------


async def test_run_answers_202_before_any_case_lands_and_the_job_finishes_detached(
    owner_client, pool, mount_peers, monkeypatch
):
    """A two-case suite: one that answers (passes) and one whose turn errors
    (ungradeable). The POST answers 202 with the run's id while the FIRST
    case is still gated at the gateway — nothing has landed — and the row is
    'running' with no summary. Once the gateway releases, the detached job
    scores both, persists both WITH run_id, and closes the row 'done'; the
    record's summary is then the runner's own, with the errored run out of
    the denominator, never a fake 0."""
    _use_suite(
        monkeypatch,
        [
            _case("ok", [PredicateSpec("reply_matches", "VRAM")], message="what is kv offloading?"),
            _case("err", [PredicateSpec("reply_matches", "whatever")], message="a question"),
        ],
    )
    hold = asyncio.Event()
    gateway = ScriptedGateway(
        rounds=(
            (text("VRAM is freed by offloading the KV cache."),),  # case ok
            Refusal(status=500, body={"error": {"message": "down"}}),  # case err: turn errors
        ),
        hold=hold,
        hold_before=0,  # the first case's turn stalls at the gateway until released
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.post(RUN, json={"suite": "probe", "model": MODEL})
    assert resp.status_code == 202, resp.text
    body = resp.json()
    run_id = uuid.UUID(body["run_id"])
    assert body["status"] == "running"
    assert body["case_count"] == 2
    assert body["suite_version"] == 1
    assert body["model"] == MODEL

    # Answered before a single case landed: the job is mid-turn, gated.
    assert await pool.fetchval("SELECT count(*) FROM eval_runs") == 0
    row = await pool.fetchrow(
        "SELECT status, ended_at FROM eval_suite_runs WHERE id = $1", run_id
    )
    assert row["status"] == "running" and row["ended_at"] is None

    # The page's attach point sees it, and a partial is never a score.
    active = (await owner_client.get(ACTIVE)).json()
    assert active["id"] == str(run_id) and active["status"] == "running"
    record = (await owner_client.get(f"/api/v1/evals/runs/{run_id}")).json()
    assert record["run"]["status"] == "running"
    assert record["cases"] == []
    assert record["summary"] is None

    hold.set()
    await _drain()

    row = await pool.fetchrow(
        "SELECT status, ended_at, error FROM eval_suite_runs WHERE id = $1", run_id
    )
    assert row["status"] == "done" and row["ended_at"] is not None and row["error"] is None
    rows = await pool.fetch(
        "SELECT case_id, run_id, passed, ungradeable FROM eval_runs ORDER BY created_at, id"
    )
    assert [(r["case_id"], r["run_id"], r["passed"], r["ungradeable"]) for r in rows] == [
        ("ok", run_id, True, False),
        ("err", run_id, None, True),  # ungradeable — passed is None, NOT False
    ]

    record = (await owner_client.get(f"/api/v1/evals/runs/{run_id}")).json()
    assert record["run"]["status"] == "done"
    cases = record["cases"]
    assert [c["case_id"] for c in cases] == ["ok", "err"]
    assert cases[0]["message"] == "what is kv offloading?"
    assert cases[0]["turn_id"] is not None
    assert "reason" in cases[1]["detail"]  # the turn's stated error, carried through
    assert record["summary"] == runner.summarize([(True, False), (None, True)])
    assert record["summary"] == {
        "total": 2,
        "gradeable": 1,
        "ungradeable": 1,
        "passed": 1,
        "pass_rate": 1.0,  # 1/1 gradeable — the ungradeable run is out of the denominator
    }
    assert (await owner_client.get(ACTIVE)).json() is None


async def test_run_record_shows_the_cases_so_far_and_no_summary_until_done(
    owner_client, pool, mount_peers, monkeypatch
):
    """Three cases; the SECOND stalls at the gateway. Once the first has
    landed, the record carries that one case (real progress: a row that
    genuinely persisted) and summary null — the partial is shown as what it
    is, never rolled into a rate. Released, the run finishes with all three
    in suite order and the summary over every row."""
    _use_suite(
        monkeypatch,
        [
            _case("first", [PredicateSpec("reply_matches", "one")], message="q1"),
            _case("second", [PredicateSpec("reply_matches", "two")], message="q2"),
            _case("third", [PredicateSpec("reply_matches", "x")], message="q3"),
        ],
    )
    hold = asyncio.Event()
    gateway = ScriptedGateway(
        rounds=(
            (text("one"),),
            (text("two"),),
            Refusal(status=500, body={"error": {"message": "down"}}),
        ),
        hold=hold,
        hold_before=1,
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.post(RUN, json={"suite": "probe", "model": MODEL})
    assert resp.status_code == 202, resp.text
    run_id = resp.json()["run_id"]

    await _until(
        lambda: pool.fetchval("SELECT count(*) FROM eval_runs"), what="the first case to land"
    )
    record = (await owner_client.get(f"/api/v1/evals/runs/{run_id}")).json()
    assert record["run"]["status"] == "running"
    assert [(c["case_id"], c["passed"]) for c in record["cases"]] == [("first", True)]
    assert record["summary"] is None

    hold.set()
    await _drain()

    record = (await owner_client.get(f"/api/v1/evals/runs/{run_id}")).json()
    assert record["run"]["status"] == "done"
    assert [(c["case_id"], c["passed"], c["ungradeable"]) for c in record["cases"]] == [
        ("first", True, False),
        ("second", True, False),
        ("third", None, True),
    ]
    assert record["summary"] == runner.summarize([(True, False), (True, False), (None, True)])


def _scope(cookie: str, content_length: int) -> dict:
    """A raw ASGI scope for POST /run, so a test can hang up the way a browser does."""
    return {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "path": RUN,
        "raw_path": RUN.encode(),
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


async def test_a_client_that_hangs_up_never_stops_the_run(
    owner_client, pool, mount_peers, monkeypatch
):
    """The defect this slice closes: the run used to live inside the response
    body, so a reload / tab close / backgrounded PWA cancelled it mid-LLM-call.
    Now the request is OVER (the client has hung up, the ASGI call has
    returned) while the first case is still gated at the gateway — and the
    run is still 'running', finishes when the gateway releases, and lands
    every case with run_id. No connection's fate reaches the job."""
    _use_suite(
        monkeypatch,
        [
            _case("a", [PredicateSpec("reply_matches", "one")], message="q1"),
            _case("b", [PredicateSpec("reply_matches", "two")], message="q2"),
        ],
    )
    hold = asyncio.Event()
    gateway = ScriptedGateway(
        rounds=((text("one"),), (text("two"),)), hold=hold, hold_before=0
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    body = json.dumps({"suite": "probe", "model": MODEL}).encode()
    cookie = owner_client.cookies["nova_session"]
    request_sent = False
    sent: list[dict] = []

    async def receive():
        nonlocal request_sent
        if not request_sent:
            request_sent = True
            return {"type": "http.request", "body": body, "more_body": False}
        return {"type": "http.disconnect"}  # the browser is gone

    async def send(message) -> None:
        sent.append(message)

    await asyncio.wait_for(app(_scope(cookie, len(body)), receive, send), timeout=10)
    # The request has completed and the client has hung up.
    assert sent[0]["type"] == "http.response.start" and sent[0]["status"] == 202, sent
    answer = json.loads(b"".join(m.get("body", b"") for m in sent[1:]))
    run_id = uuid.UUID(answer["run_id"])

    # ...and the run is still alive: it reaches the gateway AFTER the request
    # is over, stalls there (gated), and has landed nothing yet.
    await _until(lambda: gateway.calls >= 1, what="the first case to reach the gateway")
    assert await pool.fetchval(
        "SELECT status FROM eval_suite_runs WHERE id = $1", run_id
    ) == "running"
    assert await pool.fetchval("SELECT count(*) FROM eval_runs") == 0

    hold.set()
    await _drain()

    assert await pool.fetchval(
        "SELECT status FROM eval_suite_runs WHERE id = $1", run_id
    ) == "done"
    assert await pool.fetchval(
        "SELECT count(*) FROM eval_runs WHERE run_id = $1", run_id
    ) == 2
    assert await _scratch_count(pool) == 0  # every case's scratch person torn down


async def test_a_second_run_while_one_is_running_is_409_naming_the_active_run(
    owner_client, pool, mount_peers, monkeypatch
):
    """One at a time, GLOBALLY: the GPU is shared, so a second suite — even
    on a different model — is refused with a 409 that names the run holding
    the slot (id, suite, model) and a plain sentence. The refusal is the
    database's (exactly one 'running' row can exist), and no second job is
    started."""
    _use_suite(monkeypatch, [_case("a", [PredicateSpec("reply_matches", "x")], message="q")])
    hold = asyncio.Event()
    gateway = ScriptedGateway(rounds=((text("x"),),), hold=hold, hold_before=0)
    mount_peers(gateway=gateway, memory=FakeMemory())

    first = await owner_client.post(RUN, json={"suite": "probe", "model": MODEL})
    assert first.status_code == 202, first.text
    run_id = first.json()["run_id"]

    second = await owner_client.post(RUN, json={"suite": "probe", "model": "other:1b"})
    assert second.status_code == 409, second.text
    body = second.json()
    assert body["active"]["id"] == run_id
    assert body["active"]["suite"] == "probe"
    assert body["active"]["model"] == MODEL
    assert body["active"]["status"] == "running"
    assert "already running" in body["error"] and run_id in body["error"]

    assert await pool.fetchval("SELECT count(*) FROM eval_suite_runs") == 1
    assert await pool.fetchval(
        "SELECT count(*) FROM eval_suite_runs WHERE status = 'running'"
    ) == 1
    # The first suite reaches the model (and stalls there); the second never does.
    await _until(lambda: gateway.calls >= 1, what="the first run to reach the gateway")
    assert gateway.calls == 1

    hold.set()
    await _drain()
    assert await pool.fetchval(
        "SELECT status FROM eval_suite_runs WHERE id = $1", uuid.UUID(run_id)
    ) == "done"


async def test_run_sweeps_orphaned_scratch_people_before_running(
    owner_client, pool, mount_peers, monkeypatch
):
    """The API route never called run_suite, so its orphan sweep never ran on
    the page's path: two crash-orphaned scratch rows were found live. The job
    sweeps first — a legacy shared `__eval_scratch__` row and a crash orphan
    seeded here are both gone once the run has finished, the owner untouched."""
    legacy = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, 'guest') RETURNING id",
        runner.SCRATCH_PERSON_NAME,
    )
    orphan = await pool.fetchval(
        "INSERT INTO people (name, role) VALUES ($1, 'guest') RETURNING id",
        f"{runner.SCRATCH_PERSON_NAME}{uuid.uuid4().hex}",
    )
    owner_id = await pool.fetchval("SELECT id FROM people WHERE role = 'owner'")
    _use_suite(monkeypatch, [_case("a", [PredicateSpec("reply_matches", "x")], message="q")])
    mount_peers(gateway=ScriptedGateway(rounds=((text("x"),),)), memory=FakeMemory())

    resp = await owner_client.post(RUN, json={"suite": "probe", "model": MODEL})
    assert resp.status_code == 202, resp.text
    await _drain()

    assert await pool.fetchval(
        "SELECT count(*) FROM people WHERE id = ANY($1::uuid[])", [legacy, orphan]
    ) == 0
    assert await pool.fetchval("SELECT count(*) FROM people WHERE id = $1", owner_id) == 1
    assert await _scratch_count(pool) == 0


async def test_startup_marks_a_stale_running_row_interrupted_and_a_new_run_then_starts(
    owner_client, pool, mount_peers, monkeypatch, caplog
):
    """A process killed mid-suite leaves a 'running' row no job holds — which
    would refuse every new run forever. core's real startup (main.lifespan,
    beside the turns sweep) closes it 'interrupted' with an ended_at and the
    stated reason, one WARNING per row, and a POST that was a 409 before the
    sweep is a 202 after it. The interrupted run is never shown as the
    stored results."""
    stale = await pool.fetchval(
        "INSERT INTO eval_suite_runs (suite, suite_version, model, status, case_count, "
        "started_at) VALUES ('probe', 1, $1, 'running', 3, now() - interval '10 minutes') "
        "RETURNING id",
        MODEL,
    )
    _use_suite(monkeypatch, [_case("a", [PredicateSpec("reply_matches", "x")], message="q")])
    mount_peers(gateway=ScriptedGateway(rounds=((text("x"),),)), memory=FakeMemory())

    refused = await owner_client.post(RUN, json={"suite": "probe", "model": MODEL})
    assert refused.status_code == 409
    assert refused.json()["active"]["id"] == str(stale)

    with caplog.at_level(logging.WARNING, logger="core"):
        async with lifespan(app):
            row = await pool.fetchrow(
                "SELECT status, ended_at, error FROM eval_suite_runs WHERE id = $1", stale
            )
            assert row["status"] == "interrupted"
            assert row["ended_at"] is not None
            assert row["error"] == runner.INTERRUPTED_REASON
            warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
            (line,) = [w for w in warnings if str(stale) in w]
            assert "interrupted" in line and "probe" in line and MODEL in line

            started = await owner_client.post(RUN, json={"suite": "probe", "model": MODEL})
            assert started.status_code == 202, started.text
            new_id = started.json()["run_id"]
            await _drain()

            assert await pool.fetchval(
                "SELECT status FROM eval_suite_runs WHERE id = $1", uuid.UUID(new_id)
            ) == "done"
            stored = (
                await owner_client.get(f"/api/v1/evals/runs?suite=probe&model={MODEL}")
            ).json()
            assert stored["run"]["id"] == new_id  # the interrupted one never surfaces
            # Idempotent: a second sweep in the same process finds nothing.
            assert await runner.sweep_orphaned_suite_runs(pool) == []


async def test_run_unknown_suite_is_404(owner_client, monkeypatch):
    monkeypatch.setattr(cases_mod, "load_suite", lambda suite, cases_dir=None: [])
    resp = await owner_client.post(RUN, json={"suite": "nope", "model": MODEL})
    assert resp.status_code == 404


async def test_run_empty_model_is_400_and_opens_no_run(owner_client, pool, monkeypatch):
    _use_suite(monkeypatch, [_case("a", [PredicateSpec("reply_matches", "x")], message="q")])
    resp = await owner_client.post(RUN, json={"suite": "probe", "model": "   "})
    assert resp.status_code == 400
    assert await pool.fetchval("SELECT count(*) FROM eval_suite_runs") == 0


async def test_run_requires_auth(client):
    resp = await client.post(RUN, json={"suite": "probe", "model": MODEL})
    assert resp.status_code == 401


async def test_run_record_routes_require_auth(client):
    assert (await client.get(ACTIVE)).status_code == 401
    assert (await client.get(f"/api/v1/evals/runs/{uuid.uuid4()}")).status_code == 401


async def test_run_record_404s_an_unknown_id_and_active_is_null_when_idle(owner_client):
    assert (await owner_client.get(f"/api/v1/evals/runs/{uuid.uuid4()}")).status_code == 404
    assert (await owner_client.get(ACTIVE)).json() is None


# -- GET /runs: the latest COMPLETE run, one version only -------------------


async def _seed_run(
    pool,
    *,
    status: str,
    ago_seconds: int,
    version: int = 1,
    model: str = MODEL,
    case_count: int = 2,
) -> uuid.UUID:
    """Arrange an eval_suite_runs row with a controlled started_at, so
    'latest complete' is deterministic. A terminal row carries an ended_at
    (the CHECK requires it); an 'error' row carries a reason (the other CHECK)."""
    return await pool.fetchval(
        "INSERT INTO eval_suite_runs (suite, suite_version, model, status, case_count, error, "
        "started_at, ended_at) VALUES ('probe', $1, $2, $3, $4, $5, "
        "now() - make_interval(secs => $6), "
        "CASE WHEN $3 = 'running' THEN NULL ELSE now() - make_interval(secs => $6) END) "
        "RETURNING id",
        version,
        model,
        status,
        case_count,
        "seeded failure" if status == "error" else None,
        ago_seconds,
    )


async def _insert(
    pool,
    *,
    run_id: uuid.UUID | None,
    case_id: str,
    passed,
    ungradeable: bool,
    version: int = 1,
    ago_seconds: int = 0,
    model: str = MODEL,
) -> None:
    """Arrange a persisted eval_runs row under `run_id` (None = a legacy
    pre-016 row that belongs to no run)."""
    await pool.execute(
        "INSERT INTO eval_runs (suite, suite_version, model, case_id, passed, ungradeable, "
        "detail, created_at, run_id) VALUES ('probe', $1, $2, $3, $4, $5, $6, "
        "now() - make_interval(secs => $7), $8)",
        version,
        model,
        case_id,
        passed,
        ungradeable,
        {"note": f"{case_id}-{'u' if ungradeable else passed}"},
        ago_seconds,
        run_id,
    )


async def test_runs_shows_the_latest_complete_run_never_blending_a_partial_or_a_version(
    owner_client, pool, monkeypatch
):
    """Four runs of the same suite/model. The stored view is the NEWEST
    'done' run's rows — exactly that run's, in suite order — and never:
      * the interrupted run that is newer still (its fresh `a` pass would have
        shadowed the complete run's `a` fail under latest-per-case);
      * the older complete run (its `a` pass);
      * the v2 run (a different version, comparably scored only with v2).
    0/… here is a REAL 0 from the complete run, not a fabrication."""
    _use_suite(
        monkeypatch,
        [
            _case("a", [PredicateSpec("reply_matches", "x")], message="MA"),
            _case("b", [PredicateSpec("reply_matches", "y")], message="MB"),
        ],
    )
    older = await _seed_run(pool, status="done", ago_seconds=300)
    await _insert(pool, run_id=older, case_id="a", passed=True, ungradeable=False, ago_seconds=290)
    await _insert(pool, run_id=older, case_id="b", passed=True, ungradeable=False, ago_seconds=280)

    newest_done = await _seed_run(pool, status="done", ago_seconds=120)
    # Persisted b-then-a on purpose: the view is in SUITE order, not landed order.
    await _insert(
        pool, run_id=newest_done, case_id="b", passed=None, ungradeable=True, ago_seconds=115
    )
    await _insert(
        pool, run_id=newest_done, case_id="a", passed=False, ungradeable=False, ago_seconds=110
    )

    cut_off = await _seed_run(pool, status="interrupted", ago_seconds=60)
    await _insert(pool, run_id=cut_off, case_id="a", passed=True, ungradeable=False, ago_seconds=55)

    v2 = await _seed_run(pool, status="done", ago_seconds=10, version=2)
    await _insert(
        pool, run_id=v2, case_id="a", passed=True, ungradeable=False, version=2, ago_seconds=5
    )

    body = (await owner_client.get(f"/api/v1/evals/runs?suite=probe&model={MODEL}")).json()
    assert body["suite_version"] == 1
    assert body["run"]["id"] == str(newest_done)
    assert body["run"]["status"] == "done"
    assert [(c["case_id"], c["passed"], c["ungradeable"]) for c in body["cases"]] == [
        ("a", False, False),  # the complete run's verdict — not the interrupted run's pass
        ("b", None, True),
    ]
    assert body["cases"][0]["message"] == "MA"
    assert body["summary"] == {
        "total": 2,
        "gradeable": 1,
        "ungradeable": 1,
        "passed": 0,
        "pass_rate": 0.0,
    }


async def test_runs_with_no_complete_run_is_an_empty_state_not_a_zero(
    owner_client, pool, monkeypatch
):
    """Legacy rows that belong to no run, a run still running, and one that
    errored are not results: the view is empty with a null pass_rate — never
    a partial promoted to a score, never a 0/0."""
    _use_suite(monkeypatch, [_case("a", [PredicateSpec("reply_matches", "x")], message="MA")])
    await _insert(pool, run_id=None, case_id="a", passed=True, ungradeable=False, ago_seconds=500)
    failed = await _seed_run(pool, status="error", ago_seconds=100)
    await _insert(pool, run_id=failed, case_id="a", passed=True, ungradeable=False, ago_seconds=95)
    live = await _seed_run(pool, status="running", ago_seconds=10)
    await _insert(pool, run_id=live, case_id="a", passed=True, ungradeable=False, ago_seconds=5)

    body = (await owner_client.get(f"/api/v1/evals/runs?suite=probe&model={MODEL}")).json()
    assert body["run"] is None
    assert body["cases"] == []
    assert body["summary"]["pass_rate"] is None  # never a fabricated 0/0 score
    assert body["summary"]["total"] == 0


async def test_runs_requires_auth(client):
    assert (
        await client.get(f"/api/v1/evals/runs?suite=probe&model={MODEL}")
    ).status_code == 401
