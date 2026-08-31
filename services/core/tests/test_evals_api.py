"""The authed evals API — the AI Quality page's backend (S4-T3).

GET /suites lists the git corpus (the T2 `agent_quality` suite among them);
POST /run drives the REAL funnel per case against a ScriptedGateway, persists
each run, and streams one NDJSON line per finished case then a summary; GET
/runs returns the latest persisted run per case for a suite's CURRENT version
and never blends versions. Every route refuses an unauthenticated caller, and
no fake number is ever produced (pass_rate is null on an empty set, not 0).

The run route loads its cases from the git corpus, which a test cannot hand an
explicit list — so these monkeypatch `cases.load_suite` to a tiny deterministic
suite, exactly the seam the route reads through. The scoring/persistence path
underneath is the same one test_eval_runner.py already proves against a real
trace; here the concern is the ROUTE (auth, streaming shape, the summary, the
latest-per-case read), not the scorer.
"""
from __future__ import annotations

import json

from app.evals import cases as cases_mod
from app.evals.cases import Case, PredicateSpec
from tests.conftest import requires_db
from tests.fakes import FakeMemory, Refusal, ScriptedGateway

pytestmark = requires_db

MODEL = "qwen3:8b"


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


def _lines(raw: str) -> list[dict]:
    """The NDJSON stream, parsed. httpx's ASGITransport buffers the whole
    response, so the test sees every line at once — the framing is still the
    real one the browser reads incrementally."""
    return [json.loads(line) for line in raw.splitlines() if line.strip()]


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


# -- POST /run: streams per-case results + a final summary, persisted -------


async def test_run_streams_scores_and_persists_then_summarizes(
    owner_client, pool, mount_peers, monkeypatch
):
    """A two-case suite: one that answers (passes) and one whose turn errors
    (ungradeable). The route streams a line per case then a summary, persists
    both, and the pass rate's denominator is the gradeable case only — the
    errored run is never counted as a fake 0."""
    suite_cases = [
        _case("ok", [PredicateSpec("reply_matches", "VRAM")], message="what is kv offloading?"),
        _case("err", [PredicateSpec("reply_matches", "whatever")], message="a question"),
    ]
    monkeypatch.setattr(cases_mod, "load_suite", lambda suite, cases_dir=None: suite_cases)

    gateway = ScriptedGateway(
        rounds=(
            (text("VRAM is freed by offloading the KV cache."),),  # case ok: the reply
            Refusal(status=500, body={"error": {"message": "down"}}),  # case err: turn errors
        )
    )
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.post("/api/v1/evals/run", json={"suite": "probe", "model": MODEL})
    assert resp.status_code == 200
    lines = _lines(resp.text)

    cases = [ln["case"] for ln in lines if "case" in ln]
    assert [(c["case_id"], c["passed"], c["ungradeable"]) for c in cases] == [
        ("ok", True, False),
        ("err", None, True),  # ungradeable — passed is None, NOT False
    ]
    assert cases[0]["message"] == "what is kv offloading?"
    assert cases[0]["turn_id"] is not None
    assert "reason" in cases[1]["detail"]  # the turn's stated error, carried through

    summary_line = next(ln for ln in lines if "summary" in ln)
    assert summary_line["summary"] == {
        "total": 2,
        "gradeable": 1,
        "ungradeable": 1,
        "passed": 1,
        "pass_rate": 1.0,  # 1/1 gradeable — the ungradeable run is out of the denominator
    }
    assert summary_line["suite_version"] == 1
    assert summary_line["model"] == MODEL

    # Both runs persisted through the runner (its CHECK would refuse a fake 0).
    assert await pool.fetchval("SELECT count(*) FROM eval_runs") == 2


async def test_run_on_an_empty_suite_never_fabricates_a_zero(
    owner_client, pool, mount_peers, monkeypatch
):
    """A suite with no gradeable outcome must report pass_rate null, never 0."""
    monkeypatch.setattr(cases_mod, "load_suite", lambda suite, cases_dir=None: [
        _case("err", [PredicateSpec("reply_matches", "x")], message="q"),
    ])
    gateway = ScriptedGateway(rounds=(Refusal(status=500, body={"error": {"message": "down"}}),))
    mount_peers(gateway=gateway, memory=FakeMemory())

    resp = await owner_client.post("/api/v1/evals/run", json={"suite": "probe", "model": MODEL})
    summary = next(ln for ln in _lines(resp.text) if "summary" in ln)["summary"]
    assert summary["gradeable"] == 0
    assert summary["pass_rate"] is None  # not 0 — nothing gradeable to rate


async def test_run_unknown_suite_is_404(owner_client, monkeypatch):
    monkeypatch.setattr(cases_mod, "load_suite", lambda suite, cases_dir=None: [])
    resp = await owner_client.post("/api/v1/evals/run", json={"suite": "nope", "model": MODEL})
    assert resp.status_code == 404


async def test_run_requires_auth(client):
    resp = await client.post("/api/v1/evals/run", json={"suite": "probe", "model": MODEL})
    assert resp.status_code == 401


# -- GET /runs: latest per case, one version only --------------------------


async def _insert(pool, *, case_id, passed, ungradeable, version=1, ago_seconds=0, model=MODEL):
    """Arrange a persisted eval_runs row with a controlled created_at so
    'latest per case' is deterministic (persist_run's created_at defaults to
    now(), and the id tiebreak is a random uuid — not insertion order)."""
    await pool.execute(
        "INSERT INTO eval_runs (suite, suite_version, model, case_id, passed, ungradeable, "
        "detail, created_at) VALUES ('probe', $1, $2, $3, $4, $5, $6, "
        "now() - make_interval(secs => $7))",
        version,
        model,
        case_id,
        passed,
        ungradeable,
        {"note": f"{case_id}-{'u' if ungradeable else passed}"},
        ago_seconds,
    )


async def test_runs_returns_latest_per_case_never_blending_versions(
    owner_client, pool, monkeypatch
):
    suite_cases = [
        _case("a", [PredicateSpec("reply_matches", "x")], message="MA"),
        _case("b", [PredicateSpec("reply_matches", "y")], message="MB"),
    ]
    monkeypatch.setattr(cases_mod, "load_suite", lambda suite, cases_dir=None: suite_cases)

    # case a: an older passing run, then a newer failing one — the newer wins.
    await _insert(pool, case_id="a", passed=True, ungradeable=False, ago_seconds=120)
    await _insert(pool, case_id="a", passed=False, ungradeable=False, ago_seconds=10)
    # case b: an ungradeable run.
    await _insert(pool, case_id="b", passed=None, ungradeable=True, ago_seconds=30)
    # a v2 run for case a — a DIFFERENT version, must never leak into v1's view.
    await _insert(pool, case_id="a", passed=True, ungradeable=False, version=2, ago_seconds=1)

    body = (await owner_client.get(f"/api/v1/evals/runs?suite=probe&model={MODEL}")).json()
    assert body["suite_version"] == 1
    by_case = {c["case_id"]: c for c in body["cases"]}

    assert set(by_case) == {"a", "b"}
    assert by_case["a"]["passed"] is False  # the NEWER v1 run, not the older pass or the v2 pass
    assert by_case["a"]["message"] == "MA"
    assert by_case["b"]["ungradeable"] is True

    # gradeable = a(False) only; b is ungradeable. 0/1 is a REAL 0.0, not a fake.
    assert body["summary"] == {
        "total": 2,
        "gradeable": 1,
        "ungradeable": 1,
        "passed": 0,
        "pass_rate": 0.0,
    }


async def test_runs_with_no_history_is_an_empty_state_not_a_zero(
    owner_client, pool, monkeypatch
):
    monkeypatch.setattr(cases_mod, "load_suite", lambda suite, cases_dir=None: [
        _case("a", [PredicateSpec("reply_matches", "x")], message="MA"),
    ])
    body = (await owner_client.get(f"/api/v1/evals/runs?suite=probe&model={MODEL}")).json()
    assert body["cases"] == []
    assert body["summary"]["pass_rate"] is None  # never a fabricated 0/0 score
    assert body["summary"]["total"] == 0


async def test_runs_requires_auth(client):
    assert (
        await client.get(f"/api/v1/evals/runs?suite=probe&model={MODEL}")
    ).status_code == 401
