"""GET/POST /api/v1/evals — the AI Quality page's window onto the evals harness.

Three routes, all authed the same way every route in core is
(identity.require_person — a session cookie or the service bearer; there is no
separate operator-role gate anywhere in this service yet, see consents_api.py's
docstring on why that is named, not silently assumed):

  * GET  /api/v1/evals/suites             — every suite the git corpus defines
    (id, suite_version, case count), derived straight from app/evals/cases/ —
    a suite exists because JSON files say so, never a maintained list.

  * POST /api/v1/evals/run {suite, model} — runs the REAL funnel for that suite
    against that model and STREAMS the outcome: one newline-delimited JSON
    object per case as it finishes, then a final {"summary": ...} object.
    Persists every run through the runner (never inline SQL). Each case makes a
    real turn (loading the model, running tools) so a multi-case suite takes
    MINUTES — longer than nginx's 60s cap on the general /api/ location — hence
    it streams (buffering off, long read timeout), the same treatment
    /models/pull gets in the web nginx.conf. The progress is REAL: a line means
    a case genuinely finished, never a fabricated percentage.

  * GET  /api/v1/evals/runs?suite=&model= — the latest persisted run per case
    for that suite's CURRENT version, so the page shows prior results without
    re-running AND only ever compares within one suite_version (change a
    suite's cases, bump its version, and old-version rows fall out of view
    instead of blending into a fresh score).

Reads eval_runs; WRITES only through the runner (run_case + persist_run, whose
CHECK constraint refuses a fabricated 0 for an errored turn). No fake numbers —
`runner.summarize` returns pass_rate=None on an empty/all-ungradeable set, never
0. Touches no live chat/memory: the runner's scratch isolation (rail 17) stands
unchanged. This is read by no decision path — the score MEASURES a model, it
never gates a turn (fitness measures, never declares).
"""
from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app import db, identity
from app.evals import cases as cases_mod
from app.evals import runner
from app.identity import Person

router = APIRouter(prefix="/api/v1/evals", tags=["evals"])
logger = logging.getLogger("core")


class RunRequest(BaseModel):
    suite: str
    model: str


def _suite_entry(suite: str, suite_cases: list[cases_mod.Case]) -> dict:
    # load_suite guarantees a single suite_version (it raises on a mix), so the
    # first case's version speaks for the suite.
    return {
        "suite": suite,
        "suite_version": suite_cases[0].suite_version,
        "case_count": len(suite_cases),
    }


def _case_result(case: cases_mod.Case, run: runner.EvalRun) -> dict:
    """A finished case as the stream carries it: the message that was replayed,
    the verdict (passed | ungradeable), the detail (predicates + reply excerpt,
    or the ungradeable reason), and the eval turn's trace id."""
    return {
        "case_id": run.case_id,
        "message": case.message,
        "passed": run.passed,
        "ungradeable": run.ungradeable,
        "detail": run.detail,
        "turn_id": str(run.turn_id) if run.turn_id else None,
    }


def _row_result(row: dict, message: str | None) -> dict:
    """A persisted eval_runs row as the runs API carries it. `message` is joined
    from the current suite's cases by case_id (None if the case no longer
    exists at this version) — eval_runs stores the case_id, not its prose."""
    return {
        "case_id": row["case_id"],
        "message": message,
        "passed": row["passed"],
        "ungradeable": row["ungradeable"],
        "detail": row["detail"],
        "turn_id": str(row["turn_id"]) if row["turn_id"] else None,
        "created_at": row["created_at"].isoformat(),
    }


def _load_suite_or_404(suite: str) -> list[cases_mod.Case]:
    try:
        suite_cases = cases_mod.load_suite(suite)
    except cases_mod.CaseError as exc:
        # A corpus that mixes versions for this suite is a fixture bug, not a
        # client one — but the client asked for a suite that cannot be scored
        # comparably, so it gets the stated reason rather than a 500.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not suite_cases:
        raise HTTPException(
            status_code=404, detail=f"no suite {suite!r} in the corpus — nothing to score"
        )
    return suite_cases


@router.get("/suites")
async def list_suites(_person: Person = Depends(identity.require_person)) -> dict:
    all_cases = cases_mod.load_cases()
    entries = []
    for suite in sorted({c.suite for c in all_cases}):
        suite_cases = cases_mod.load_suite(suite)  # sorted, single-version (raises on a mix)
        if suite_cases:
            entries.append(_suite_entry(suite, suite_cases))
    return {"suites": entries}


@router.post("/run")
async def run_suite_stream(
    body: RunRequest,
    request: Request,
    _person: Person = Depends(identity.require_person),
) -> StreamingResponse:
    pool = await db.get_pool()
    suite_cases = _load_suite_or_404(body.suite)
    model = body.model.strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is empty — nothing to run against")

    app = request.app
    suite_version = suite_cases[0].suite_version

    async def stream():
        # One case at a time through the REAL funnel, persisted as it lands, its
        # result flushed immediately — so the page fills the per-case table live
        # and a client that disconnects never leaves a half-written run looking
        # finished. Persistence goes through the runner (its CHECK refuses a fake
        # 0 for an errored turn), never inline SQL here.
        runs: list[runner.EvalRun] = []
        try:
            for case in suite_cases:
                run = await runner.run_case(app, pool, case, model)
                await runner.persist_run(pool, run)
                runs.append(run)
                yield json.dumps({"case": _case_result(case, run)}).encode() + b"\n"
        except Exception as exc:
            # run_case is built never to raise (it turns an escaped error into an
            # UNGRADEABLE run); if something still escaped, that is an
            # infra/harness failure. Say so in the stream rather than letting a
            # truncated run read as a finished score.
            logger.exception("evals run stream failed for suite %s", body.suite)
            yield json.dumps(
                {"error": f"the eval run failed — {type(exc).__name__}: {exc}"}
            ).encode() + b"\n"
            return
        yield json.dumps(
            {
                "summary": runner.score_summary(runs),
                "suite": body.suite,
                "suite_version": suite_version,
                "model": model,
            }
        ).encode() + b"\n"

    # application/x-ndjson, buffering off at nginx (see the web nginx.conf
    # location block for this path) so each case's line reaches the browser the
    # moment the case finishes.
    return StreamingResponse(stream(), media_type="application/x-ndjson")


@router.get("/runs")
async def latest_runs(
    suite: str,
    model: str,
    _person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    suite_cases = _load_suite_or_404(suite)
    suite_version = suite_cases[0].suite_version
    messages = {c.id: c.message for c in suite_cases}
    order = {c.id: i for i, c in enumerate(suite_cases)}

    # runs_for is scoped to exactly this (suite, suite_version, model) and comes
    # back newest-first, so the FIRST row seen per case_id is that case's latest
    # run — never a blend of versions (runs_for never crosses one) and never a
    # stale earlier attempt shadowing a fresh one.
    rows = await runner.runs_for(pool, suite, suite_version, model)
    latest: dict[str, dict] = {}
    for row in rows:
        latest.setdefault(row["case_id"], row)

    cases = sorted(
        (_row_result(row, messages.get(case_id)) for case_id, row in latest.items()),
        key=lambda c: order.get(c["case_id"], len(order)),
    )
    summary = runner.summarize([(row["passed"], row["ungradeable"]) for row in latest.values()])
    return {
        "suite": suite,
        "suite_version": suite_version,
        "model": model,
        "cases": cases,
        "summary": summary,
    }
