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


def busy() -> Optional[str]:
    """The run holding the slot, or None — the SAME fact `start` gates on.

    Callers that queue runs need this rather than the row's status. The two
    are not interchangeable: `reconcile_orphans` can mark a row terminal from
    a different process than the one whose `_execute` would clear this global,
    so a row can read finished while the slot is still held. Watching the row
    and then starting the next run is how the tournament came to skip five of
    six models in a single burst on 2026-08-04.
    """
    return _running


# A run says it is alive by touching detail->heartbeat. STALE_AFTER must be
# several beats, so one slow database moment never reads as a dead run.
HEARTBEAT_EVERY_S = 20.0
STALE_AFTER_S = 90


async def _heartbeat(run_id: str) -> None:
    """Say this run is still alive, until cancelled.

    Without it a run cannot be distinguished from its own corpse, and
    `reconcile_orphans` has to guess — see the docstring there for what that
    cost.
    """
    while True:
        await asyncio.sleep(HEARTBEAT_EVERY_S)
        try:
            async with db.acquire() as conn:
                await conn.execute(
                    "UPDATE eval_runs "
                    "   SET detail = jsonb_set(detail, '{heartbeat}', "
                    "                          to_jsonb(now())) "
                    " WHERE id = $1::uuid AND status = 'running'", run_id)
        except Exception:  # noqa: BLE001 — a missed beat is not a dead run
            log.debug("eval heartbeat failed for %s", run_id, exc_info=True)


async def reconcile_orphans(delay_s: float = 0.0) -> int:
    """Close out runs that really did die — and ONLY those.

    A run executes in-process (asyncio.create_task), and the dev server runs
    with --reload, so ANY source edit kills it. Without this the row stays
    `running` forever and reads as "still going". Marked `error`, never
    `failed`: the harness died, which is not a verdict on the model, and
    recording it as one would be a lie that later shows up in a picker.

    IT USED TO REAP EVERY `running` ROW, unconditionally, at startup. That is
    wrong the moment a second process exists, and one always does — a test
    run, `python -m app.evals`, another container. Measured 2026-08-04: a
    live tournament run was marked "interrupted by a backend restart" while
    it was still executing, by some other process booting the app. No restart
    had happened. The row went terminal, the tournament's `_await_run` saw a
    finished row and moved on while the in-process slot was still genuinely
    held, and the night ended having measured one model of six. The run then
    finished normally and recorded `failed (2/6)` — a verdict that, for three
    minutes, sat underneath a row claiming it had been interrupted.

    So death is now PROVEN rather than assumed: a live run touches
    `detail->heartbeat` every 20s, and only a row that has missed several
    beats is reaped. `delay_s` lets startup schedule this in the background
    past the staleness window, so a run this process actually did kill is
    still caught, without blocking the boot and without libelling anyone
    else's.
    """
    if delay_s:
        await asyncio.sleep(delay_s)
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "UPDATE eval_runs SET status='error', finished_at=now(), "
            "       error='the run stopped reporting and was declared dead' "
            " WHERE status='running' "
            "   AND COALESCE((detail->>'heartbeat')::timestamptz, started_at) "
            f"       < now() - interval '{STALE_AFTER_S} seconds' "
            " RETURNING id")
    if rows:
        log.warning("eval: %d run(s) stopped reporting and were closed out",
                    len(rows))
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
           "       tokens_out, duration_s, error, repeat_count, suite_version "
           "  FROM eval_runs")
    args: list = []
    if agent_name:
        sql += " WHERE agent_name = $1"
        args.append(agent_name)
    sql += " ORDER BY started_at DESC LIMIT " + str(int(limit))
    async with db.acquire() as conn:
        return [dict(r) for r in await conn.fetch(sql, *args)]


async def latest_verdicts() -> list[dict]:
    """The newest finished verdict per (agent, model) — what a picker shows.

    `repeat_count` and `suite_version` ride along because a bare "2/7" in a
    picker is the exact over-reading migration 086 exists to stop: one draw
    against a suite that has since moved looks identical to a repeated run
    against the current one.
    """
    async with db.acquire() as conn:
        return [dict(r) for r in await conn.fetch(
            "SELECT DISTINCT ON (agent_name, model) agent_name, model, status, "
            "       tasks_passed, tasks_total, started_at, repeat_count, "
            "       suite_version, suite "
            "  FROM eval_runs WHERE status IN ('passed','failed') "
            " ORDER BY agent_name, model, started_at DESC")]


async def _execute(run_id: str, suite_name: str, model: str,
                   repeat: int = 1) -> None:
    """Run every task in a suite against one model and record the verdict.

    `repeat` runs each task N times. A task counts as passed only if it passed
    EVERY repeat, which is the honest reading when the thing being measured is
    stochastic: two runs of this suite scored 2/7 and 3/7 hours apart, and the
    task that flipped was one nothing had touched. Strictness is the point —
    "passed once out of three" is not a property you can route work on.
    """
    global _running
    from app.evals import checks, runner as eval_runner, suites as suite_mod

    # Starts BEFORE any work, so a run that dies in its first seconds is
    # still distinguishable from one that never reported at all.
    beat = asyncio.create_task(_heartbeat(run_id))
    scratch = Path(tempfile.mkdtemp(prefix="nova-eval-"))
    total = passed = graded = 0
    tin = tout = 0
    details: list[dict] = []
    status, error = "passed", None
    started = asyncio.get_event_loop().time()
    try:
        suite = suite_mod.load_suite(suite_name)
        for task in suite_mod.load_tasks(suite):
            total += 1
            runs_passed = 0
            failures: list[str] = []
            errors: list[str] = []
            gradeable_any = False
            duration = 0.0
            for attempt in range(repeat):
                result = await eval_runner.run_task(
                    task, model, label="candidate", scratch_root=scratch)
                report = checks.evaluate(task.contract, result)
                usage = result.usage or {}
                tin += int(usage.get("prompt_tokens") or 0)
                tout += int(usage.get("completion_tokens") or 0)
                duration += result.duration_s
                gradeable_any = gradeable_any or result.gradeable
                if bool(report.passed) and result.gradeable:
                    runs_passed += 1
                else:
                    # Keep the FIRST failure of each kind rather than the last:
                    # a flaky task's interesting run is the one that failed,
                    # and a later clean run must not erase why.
                    failures.extend(str(f) for f in report.failures)
                    errors.extend(result.errors)
            ok = runs_passed == repeat and gradeable_any
            passed += 1 if ok else 0
            entry = {
                "task": task.ref, "passed": ok,
                "gradeable": gradeable_any,
                "contract_failures": failures[:8],
                "errors": errors[:3],
                "duration_s": round(duration, 1)}
            if repeat > 1:
                # The flaky middle ground is invisible in a pass/fail column,
                # and it is the most useful thing a repeated run learns.
                entry["runs_passed"] = runs_passed
                entry["runs"] = repeat
            details.append(entry)
        # Tasks the model was actually ASKED. A call refused before it reaches
        # the model — a prompt over the VRAM-sized window, an unservable tool
        # — is not a wrong answer, and counting it as one turns a fact about
        # the machine into a verdict about the model.
        graded = sum(1 for e in details if e.get("gradeable"))
        if total and not graded:
            # Nothing was measured, so there is nothing to report as a score.
            # `failed 0/7` here is the lie: it reads identically to a model
            # that answered every question wrongly.
            why = next((e for d in details for e in (d.get("errors") or [])),
                       "no reason recorded")
            status = "error"
            error = f"no task could be graded — the model was never reached. {why}"[:500]
        else:
            status = "passed" if passed == total and total else "failed"
    except Exception as exc:  # noqa: BLE001 — a harness failure is not a verdict
        log.exception("eval run %s failed", run_id)
        status, error = "error", f"{type(exc).__name__}: {exc}"[:500]
    finally:
        beat.cancel()
        shutil.rmtree(scratch, ignore_errors=True)
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE eval_runs SET status=$2, finished_at=now(), "
                "tasks_total=$3, tasks_passed=$4, tokens_in=$5, tokens_out=$6, "
                "duration_s=$7, detail=$8::jsonb, error=$9, "
                "tasks_gradeable=$10 WHERE id=$1::uuid",
                run_id, status, total, passed, tin, tout,
                round(asyncio.get_event_loop().time() - started, 1),
                json.dumps({"tasks": details}), error, graded)
        _running = None
        log.info("eval run %s: %s (%d/%d)", run_id, status, passed, total)


MAX_REPEAT = 10


async def start(suite_name: str, model: str, repeat: int = 1) -> dict:
    """Begin a run. Returns immediately with the row id."""
    global _running
    from app.evals import suites as suite_mod
    from app.llm import router as llm_router

    if _running:
        raise ValueError(f"an eval is already running ({_running})")
    # `repeat or 1` would turn an explicit 0 into 1 — a caller asking for zero
    # runs gets one and is told nothing. Missing means default; provided means
    # meant, including when it is nonsense.
    repeat = 1 if repeat is None else int(repeat)
    if not 1 <= repeat <= MAX_REPEAT:
        raise ValueError(f"repeat must be between 1 and {MAX_REPEAT}")
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
            "INSERT INTO eval_runs (suite, agent_name, model, suite_version, "
            "                       repeat_count) "
            "VALUES ($1,$2,$3,$4,$5) RETURNING id",
            suite_name, suite.agent, model, suite.version, repeat)
    run_id = str(row["id"])
    _running = run_id
    asyncio.create_task(_execute(run_id, suite_name, model, repeat))
    return {"id": run_id, "suite": suite_name, "agent": suite.agent,
            "model": model, "suite_version": suite.version,
            "repeat": repeat, "status": "running"}
