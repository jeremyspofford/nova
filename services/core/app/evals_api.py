"""GET/POST /api/v1/evals — the AI Quality page's window onto the evals harness.

A suite run is a SERVER-SIDE JOB whose truth lives in the database (migration
016, eval_suite_runs), detached from any HTTP connection; at most one runs at
a time (a database invariant, not a check here); the page is a VIEWER of the
record. Before this, the run happened inside a streaming response body and a
page reload / tab close / backgrounded PWA cancelled it mid-LLM-call — the turn
closed 'error', nothing recorded the cut-off, the scratch person leaked, and a
second click interleaved a second suite on the same GPU.

Every route is authed the same way every route in core is
(identity.require_person — a session cookie or the service bearer; there is no
separate operator-role gate anywhere in this service yet, see consents_api.py's
docstring on why that is named, not silently assumed).

  * GET  /api/v1/evals/suites             — every suite the git corpus defines
    (id, suite_version, case count), derived straight from app/evals/cases/ —
    a suite exists because JSON files say so, never a maintained list.
    Shape: {"suites": [{suite, suite_version, case_count}]}.

  * POST /api/v1/evals/run {suite, model} — opens the run's row (INSERT; the
    partial unique index refuses a second while one is 'running'), spawns
    runner.run_suite_job detached (chat._spawn, the set main.py drains at
    shutdown), and answers 202 IMMEDIATELY:
      {"run_id", "status": "running", "case_count", "suite", "suite_version",
       "model"}
    409 while a run is active — {"error": <plain sentence>, "active": <run>}
    (the running row, or null in the narrow window where it finished between
    the refusal and the read). 400 on an empty model, 404 on an unknown suite.

  * GET  /api/v1/evals/runs/active        — the 'running' row (see <run>
    below) or null, read from the database: what the page attaches to on
    mount, so navigating away and back re-attaches to the same run.

  * GET  /api/v1/evals/runs/{run_id}      — {"run": <run>, "cases": [...],
    "summary": ...}: the row, the cases persisted so far (suite case order),
    and a summary ONLY when status is 'done' — null otherwise, so a partial
    run is never dressed as a score. 404 for an unknown id.

  * GET  /api/v1/evals/runs?suite=&model= — the latest COMPLETE ('done') run
    for that suite's CURRENT version and that model: {"suite",
    "suite_version", "model", "run": <run> | null, "cases", "summary"}. Never
    latest-per-case across runs (that blended an interrupted run's fresh rows
    with an older complete run's), never across versions (change a suite's
    cases, bump its version, and old-version runs fall out of view). Rows
    persisted before migration 016 belong to no run and are not shown here.

  <run> is {"id", "suite", "suite_version", "model", "status": running | done
  | error | interrupted, "case_count", "error": str | null, "started_at",
  "ended_at": str | null}. A case is {"case_id", "message" (joined from the
  suite by case_id; null if the case no longer exists at that version),
  "passed" (null EXACTLY when ungradeable), "ungradeable", "detail",
  "turn_id", "created_at"}.

Reads eval_runs / eval_suite_runs; WRITES only through the runner (open_suite_run,
run_suite_job → run_case + persist_run, whose CHECK refuses a fabricated 0 for
an errored turn). No fake numbers — `runner.summarize` returns pass_rate=None on
an empty/all-ungradeable set, never 0. Touches no live chat/memory: the runner's
scratch isolation (rail 17) stands unchanged. This is read by no decision path
— the score MEASURES a model, it never gates a turn (fitness measures, never
declares).
"""
from __future__ import annotations

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from app import chat, db, identity
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


def _suite_run(row: dict) -> dict:
    """An eval_suite_runs row as the API carries it (<run> in the docstring)."""
    return {
        "id": str(row["id"]),
        "suite": row["suite"],
        "suite_version": row["suite_version"],
        "model": row["model"],
        "status": row["status"],
        "case_count": row["case_count"],
        "error": row["error"],
        "started_at": row["started_at"].isoformat(),
        "ended_at": row["ended_at"].isoformat() if row["ended_at"] else None,
    }


def _row_result(row: dict, message: str | None) -> dict:
    """A persisted eval_runs row as the runs API carries it. `message` is joined
    from the suite's cases by case_id (None if the case no longer exists at
    that version) — eval_runs stores the case_id, not its prose."""
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


def _cases_at_version(suite: str, suite_version: int) -> list[cases_mod.Case]:
    """The suite's cases IF the corpus still carries exactly that version —
    for joining a stored run's rows back to their messages and order. A run
    of a version the corpus no longer has (or a suite that vanished) is still
    a record worth reading: it just comes back without messages, in landed
    order, never a 404."""
    try:
        suite_cases = cases_mod.load_suite(suite)
    except cases_mod.CaseError:
        return []
    if not suite_cases or suite_cases[0].suite_version != suite_version:
        return []
    return suite_cases


def _cases_of(rows: list[dict], suite_cases: list[cases_mod.Case]) -> list[dict]:
    """The run's rows as API cases, in the suite's case order (rows land in that
    order anyway — the job is sequential — so an unknown case sorts last, in
    landed order)."""
    messages = {c.id: c.message for c in suite_cases}
    order = {c.id: i for i, c in enumerate(suite_cases)}
    return sorted(
        (_row_result(row, messages.get(row["case_id"])) for row in rows),
        key=lambda c: order.get(c["case_id"], len(order)),
    )


@router.get("/suites")
async def list_suites(_person: Person = Depends(identity.require_person)) -> dict:
    all_cases = cases_mod.load_cases()
    entries = []
    for suite in sorted({c.suite for c in all_cases}):
        suite_cases = cases_mod.load_suite(suite)  # sorted, single-version (raises on a mix)
        if suite_cases:
            entries.append(_suite_entry(suite, suite_cases))
    return {"suites": entries}


@router.post("/run", status_code=202)
async def start_suite_run(
    body: RunRequest,
    request: Request,
    _person: Person = Depends(identity.require_person),
):
    pool = await db.get_pool()
    suite_cases = _load_suite_or_404(body.suite)
    model = body.model.strip()
    if not model:
        raise HTTPException(status_code=400, detail="model is empty — nothing to run against")
    suite_version = suite_cases[0].suite_version

    try:
        row = await runner.open_suite_run(
            pool, body.suite, suite_version, model, len(suite_cases)
        )
    except runner.SuiteRunActive as exc:
        # Refused by the database's one-at-a-time index, not by a flag: the
        # answer names the run that holds the slot so the page can attach to
        # it instead of showing an error.
        return JSONResponse(
            {"error": str(exc), "active": _suite_run(exc.active) if exc.active else None},
            status_code=409,
        )

    # The job is its own detached task — in chat._BACKGROUND exactly like a
    # chat turn's, so main.py's shutdown drains it and no client's fate ever
    # reaches it. Answer now: the row IS the run, and the page polls it.
    chat._spawn(runner.run_suite_job(request.app, pool, row["id"], suite_cases, model))
    logger.info(
        "eval suite run %s started: %s v%s on %s (%d cases)",
        row["id"],
        body.suite,
        suite_version,
        model,
        len(suite_cases),
    )
    return {
        "run_id": str(row["id"]),
        "status": row["status"],
        "case_count": len(suite_cases),
        "suite": body.suite,
        "suite_version": suite_version,
        "model": model,
    }


@router.get("/runs")
async def latest_complete_run(
    suite: str,
    model: str,
    _person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    suite_cases = _load_suite_or_404(suite)
    suite_version = suite_cases[0].suite_version

    run = await runner.latest_complete_suite_run(pool, suite, suite_version, model)
    rows = await runner.runs_in(pool, run["id"]) if run else []
    return {
        "suite": suite,
        "suite_version": suite_version,
        "model": model,
        "run": _suite_run(run) if run else None,
        "cases": _cases_of(rows, suite_cases),
        "summary": runner.summarize([(row["passed"], row["ungradeable"]) for row in rows]),
    }


# Declared before /runs/{run_id}: "active" is a word, not an id, and must
# never fall through to the id route as a 422.
@router.get("/runs/active")
async def active_run(_person: Person = Depends(identity.require_person)) -> dict | None:
    pool = await db.get_pool()
    row = await runner.active_suite_run(pool)
    return _suite_run(row) if row else None


@router.get("/runs/{run_id}")
async def suite_run_record(
    run_id: uuid.UUID,
    _person: Person = Depends(identity.require_person),
) -> dict:
    pool = await db.get_pool()
    row = await runner.suite_run(pool, run_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"no eval suite run {run_id}")
    rows = await runner.runs_in(pool, run_id)
    suite_cases = _cases_at_version(row["suite"], row["suite_version"])
    # A summary exists only for a finished run. While running (or after an
    # error/interruption) the cases so far are shown as what they are — a
    # partial — and never rolled up into a rate.
    summary = (
        runner.summarize([(r["passed"], r["ungradeable"]) for r in rows])
        if row["status"] == runner.SUITE_RUN_DONE
        else None
    )
    return {"run": _suite_run(row), "cases": _cases_of(rows, suite_cases), "summary": summary}
