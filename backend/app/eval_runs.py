"""Running an agent's own tasks against a candidate model, on demand.

The harness in app/evals does the hard part: it runs the agent's real tasks
in an isolated scratch memory store and grades the result against a
mechanical contract — which tools were called, what was written, what tags
landed. It was CLI-only, so a verdict lived in a terminal and died there.

This makes it pressable and makes the answer persist, and it is deliberately
NOT automatic on model selection. A suite is minutes of wall clock and real
tokens; running it when someone opens a dropdown either blocks the UI or
finishes after the model is already live, and both read as broken. The
instant tier is model_fitness, which invokes nothing.

THE COST ESTIMATE IS MEASURED, NOT GUESSED. Every run records its own tokens
and duration, and the next operator to press the button is shown the median
of what this suite has actually cost. Before there is any history it says so
and reports the task count instead of inventing a figure — the same rule the
grounding gate follows, for the same reason.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import tempfile
from pathlib import Path
from typing import Optional

from app import db

log = logging.getLogger(__name__)

# One eval at a time. The harness runs real agent turns against the live
# Postgres, and two concurrent suites would interleave their turn traces and
# compete for the same provider rate limit.
_lock = asyncio.Lock()
_running: Optional[str] = None


async def reconcile_orphans() -> int:
    """Close out runs that a restart killed mid-flight.

    A run executes in-process (asyncio.create_task), and the dev server runs
    with --reload, so ANY source edit kills it. Without this the row stays
    `running` forever and reads as "still going" — the same silent-limbo
    shape the ingest queue already fixed by requeuing orphaned rows at
    startup. Marked `error`, never `failed`: the harness died, which is not a
    verdict on the model, and recording it as one would be a lie that later
    shows up in a picker.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "UPDATE eval_runs SET status='error', finished_at=now(), "
            "       error='interrupted by a backend restart' "
            " WHERE status='running' RETURNING id")
    if rows:
        log.warning("eval: %d run(s) were interrupted by a restart", len(rows))
    return len(rows)


async def estimate(suite: str) -> dict:
    """What this suite has cost before — the basis for the operator warning.

    Returns `measured: False` and no figures when it has never been run.
    Saying "unknown" is worth more than a fabricated number in a dialog whose
    whole job is telling someone what they are about to spend.
    """
    from app.evals import suites as suite_mod
    try:
        loaded = suite_mod.load_suite(suite)
        tasks = len(loaded.task_ids)
    except Exception:  # noqa: BLE001
        tasks = 0
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_s) AS secs,"
        "       percentile_cont(0.5) WITHIN GROUP (ORDER BY tokens_in) AS tin,"
        "       percentile_cont(0.5) WITHIN GROUP (ORDER BY tokens_out) AS tout,"
        "       count(*) AS runs "
            "  FROM eval_runs WHERE suite = $1 AND status IN ('passed','failed')",
            suite)
    if not row or not row["runs"]:
        return {"suite": suite, "tasks": tasks, "measured": False,
                "note": f"{tasks} tasks, each a full agent turn with real tool "
                        f"calls. This suite has not been run before, so there "
                        f"is no measured cost yet."}
    return {"suite": suite, "tasks": tasks, "measured": True,
            "runs_measured": int(row["runs"]),
            "median_seconds": round(float(row["secs"] or 0), 1),
            "median_tokens_in": int(row["tin"] or 0),
            "median_tokens_out": int(row["tout"] or 0),
            "note": f"Median of {int(row['runs'])} previous run(s) of this "
                    f"suite: about {round(float(row['secs'] or 0) / 60, 1)} "
                    f"minutes and "
                    f"{int((row['tin'] or 0) + (row['tout'] or 0)):,} tokens."}


async def recent(agent_name: Optional[str] = None, limit: int = 20) -> list[dict]:
    sql = ("SELECT id, suite, agent_name, model, status, started_at, "
           "       finished_at, tasks_total, tasks_passed, tokens_in, "
           "       tokens_out, duration_s, error "
           "  FROM eval_runs")
    args: list = []
    if agent_name:
        sql += " WHERE agent_name = $1"
        args.append(agent_name)
    sql += " ORDER BY started_at DESC LIMIT " + str(int(limit))
    async with db.acquire() as conn:
        return [dict(r) for r in await conn.fetch(sql, *args)]


async def latest_verdicts() -> list[dict]:
    """The newest finished verdict per (agent, model) — what a picker shows."""
    async with db.acquire() as conn:
        return [dict(r) for r in await conn.fetch(
            "SELECT DISTINCT ON (agent_name, model) agent_name, model, status, "
            "       tasks_passed, tasks_total, started_at "
            "  FROM eval_runs WHERE status IN ('passed','failed') "
            " ORDER BY agent_name, model, started_at DESC")]


async def _execute(run_id: str, suite_name: str, model: str) -> None:
    """Run every task in a suite against one model and record the verdict."""
    global _running
    from app.evals import checks, runner as eval_runner, suites as suite_mod

    scratch = Path(tempfile.mkdtemp(prefix="nova-eval-"))
    total = passed = 0
    tin = tout = 0
    details: list[dict] = []
    status, error = "passed", None
    started = asyncio.get_event_loop().time()
    try:
        suite = suite_mod.load_suite(suite_name)
        for task in suite_mod.load_tasks(suite):
            total += 1
            result = await eval_runner.run_task(
                task, model, label="candidate", scratch_root=scratch)
            report = checks.evaluate(task.contract, result)
            usage = result.usage or {}
            tin += int(usage.get("prompt_tokens") or 0)
            tout += int(usage.get("completion_tokens") or 0)
            ok = bool(report.passed) and result.gradeable
            passed += 1 if ok else 0
            details.append({
                "task": task.ref, "passed": ok,
                "gradeable": result.gradeable,
                "contract_failures": [str(f) for f in report.failures][:8],
                "errors": result.errors[:3],
                "duration_s": round(result.duration_s, 1)})
        status = "passed" if passed == total and total else "failed"
    except Exception as exc:  # noqa: BLE001 — a harness failure is not a verdict
        log.exception("eval run %s failed", run_id)
        status, error = "error", f"{type(exc).__name__}: {exc}"[:500]
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE eval_runs SET status=$2, finished_at=now(), "
                "tasks_total=$3, tasks_passed=$4, tokens_in=$5, tokens_out=$6, "
                "duration_s=$7, detail=$8::jsonb, error=$9 WHERE id=$1::uuid",
                run_id, status, total, passed, tin, tout,
                round(asyncio.get_event_loop().time() - started, 1),
                json.dumps({"tasks": details}), error)
        _running = None
        log.info("eval run %s: %s (%d/%d)", run_id, status, passed, total)


async def start(suite_name: str, model: str) -> dict:
    """Begin a run. Returns immediately with the row id."""
    global _running
    from app.evals import suites as suite_mod
    from app.llm import router as llm_router

    if _running:
        raise ValueError(f"an eval is already running ({_running})")
    # The harness refuses this too, but failing here means the operator is
    # told before a row exists rather than finding an 'error' verdict later.
    effective = llm_router.effective_model(model)
    if effective != model:
        raise ValueError(
            f"{model} resolves to {effective} — its provider is not "
            f"configured, so this would grade the fallback instead.")
    suite = suite_mod.load_suite(suite_name)
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO eval_runs (suite, agent_name, model) "
            "VALUES ($1,$2,$3) RETURNING id", suite_name, suite.agent, model)
    run_id = str(row["id"])
    _running = run_id
    asyncio.create_task(_execute(run_id, suite_name, model))
    return {"id": run_id, "suite": suite_name, "agent": suite.agent,
            "model": model, "status": "running"}
