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

A RUN SURVIVES THE BACKEND RESTARTING (migration 124). Jeremy, 2026-08-07:
*"I couldn't run a model eval loop on a model."* He was right, and the
failure was structural rather than unlucky. Measured over the whole table on
2026-08-07 — 250 rows, every eval ever recorded on this box:

    177 error / 73 failed / 0 passed
    175 of the 177 errors died to the PROCESS, not the model
        170 'the run stopped reporting and was declared dead'
          5 'interrupted by a backend restart' (the pre-heartbeat wording)
      only 2 were real: one NameError, one no_gradeable_tasks
    175 of them had tasks_total = 0 — `_execute`'s finally never ran, so
        nothing whatsoever was kept from up to 46 minutes of work

Seventy per cent of all eval history is the harness being killed. The cause
is that a run executed entirely in memory: `asyncio.create_task(_execute)`
inside a backend running under `--reload`, where any `.py` edit is a restart.
Nothing was written down until the very end, so a restart at minute 45 of 46
threw away the lot and left a row that reads, to a picker and to the
autonomous loop's eval floor, exactly like a model that could not be graded.

So a run is now DURABLE, on the pattern `action_worker` / `ingest_worker`
already use for this problem: a per-TASK cursor persisted as the run goes
(`task_index`), a claim taken with `FOR UPDATE SKIP LOCKED` so two backends
can never resume one run, orphan recovery at boot, and leader gating. A
restart resumes at the cursor. `reconcile_orphans` — which used to be a
mortician — now recovers first and only certifies death when continuing is
genuinely impossible, and says WHICH of those two things happened.

AND A FINISHED RUN REACHES THE OPERATOR (migration 127). Jeremy, 2026-08-07:
*"I ran a model eval test, haven't seen any update."* Run 585f78c7 had
completed successfully seven minutes earlier — all 7 tasks graded, the model
scored 2 — and the only place that number existed was this table. Two
defects, both fixed here:

* `outcome()` DERIVES the reading from what happened, because the status
  string cannot carry it. `failed` was worn both by that completed
  measurement and by aee6d5a7, which died at task 0 of 0 with "no heartbeat
  for 90s" — opposite outcomes rendering identically. The question the code
  asks is "how many of the suite's tasks were actually graded", so a 2/7 is a
  RESULT and a run the model was never reached for is not a verdict on
  anyone. No list of statuses is maintained anywhere.
* `_announce()` puts the result in the conversation through migration 125's
  path, and writes back onto the run what notify.send said about it. An eval
  is eight minutes; he starts one and walks away.

...AND EXACTLY ONCE (migration 128). 127 shipped with two claims that were
not enforced by anything, and both were measured false the day after:

* "the same run announced twice folds onto one notification" — it did not.
  `notify.send` reads `notifications.find_repeat` and then inserts, over a
  plain btree, so callers that read before either writes both publish. Three
  concurrent `_announce` calls on one terminal run: 3 pushes, 3 notification
  rows, 3 chat pointers, all reporting `deduped: False`. Serialized, they
  fold correctly — which is the case that dedupe was really for, and it
  stays. The race is refused by `_claim_announce`, a leased claim taken on
  the row BEFORE the send, because `_execute` announcing its own verdict and
  the leader's 60s backlog sweep are different coroutines and often
  different processes: only the database can gate that.
* "one definition of measured, two callers" — there were two. `MEASURED_WHERE`
  read the bare `tasks_gradeable` column while the SELECT lists fell back to
  counting `detail->tasks`, so 10 live rows were a MEASUREMENT to `outcome()`
  (and to the notification, and to `eval_results`) and invisible to
  `model_tournament.standings` and `estimate` — exactly the thing 127 says
  cannot happen. Both are now built from `_GRADED_EXPR`, one string.
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Optional

from app import db, notifications

log = logging.getLogger(__name__)

# One eval at a time. The harness runs real agent turns against the live
# Postgres, and two concurrent suites would interleave their turn traces and
# compete for the same provider rate limit.
#
# THE SLOT IS A GATE, NOT A NOTE. Migration 124's system_prompt, the run_eval
# tool description and the migration's own comment all name this slot as the
# mechanical limit backing the new grant, so it has to actually be one. It
# was not: `start` tested `_running` and then set it two awaits later, and
# `_lock` — declared for exactly this — was never acquired anywhere. Measured
# 2026-08-07, two `start()` calls on one event loop:
#
#     concurrent start() results: ['495cca02-…', '1a2ad0e8-…']
#     BOTH started: True
#
# Every acquisition now goes through `_reserve_slot`, which tests and sets
# under `_lock` with no await in between, and every release is a
# compare-and-clear rather than an unconditional `= None`.
_lock = asyncio.Lock()
_running: Optional[str] = None

# The reservation `_sweep` holds between "this process is free" and "this is
# the run I claimed". A claim bumps `resumes`, so the slot has to be taken
# BEFORE the row is, and the id is not known until after — see `_sweep`.
_SWEEP_TOKEN = "__recovery__"

# Run ids currently inside `_execute` IN THIS PROCESS. Deliberately a second
# fact rather than a reading of `_running`: the slot is reserved before a row
# is claimed, so "the slot names this run" cannot answer "is this run already
# executing". Asking the wrong one of those two is what let a live run whose
# heartbeat had merely lapsed be started a second time on top of itself —
# measured, RAN was ['fake/t0','fake/t1','fake/t2','fake/t2','fake/t3',
# 'fake/t3'], two coroutines racing one detail->tasks document.
_executing: set[str] = set()


async def _reserve_slot(token: str) -> bool:
    """Take the one-at-a-time slot for `token`. True iff it is now ours.

    The whole point is that the test and the set are one step. `_lock` is
    held across both so that stays true even if this body ever grows an
    await — which is precisely how `start` lost the property.
    """
    global _running
    async with _lock:
        if _running is not None:
            return False
        _running = token
        return True


async def _rebind_slot(old: str, new: str) -> bool:
    """Rename a reservation once the id it was taken for is known."""
    global _running
    async with _lock:
        if _running != old:
            return False
        _running = new
        return True


def _release_slot(token: str) -> None:
    """Free the slot IF `token` still holds it.

    Compare-and-clear, never a bare `_running = None`: an unconditional clear
    lets a finishing run free a reservation that is now somebody else's,
    which is the same hole one level down. Sync and lock-free on purpose — a
    compare-and-clear with no await between cannot be interleaved, and making
    it async would mean releases could not happen in a `finally` that also
    handles cancellation.
    """
    global _running
    if _running == token:
        _running = None


def busy() -> Optional[str]:
    """The run holding the slot, or None — the SAME fact `start` gates on.

    Callers that queue runs need this rather than the row's status. The two
    are not interchangeable: `reconcile_orphans` can mark a row terminal from
    a different process than the one whose `_execute` would clear this global,
    so a row can read finished while the slot is still held. Watching the row
    and then starting the next run is how the tournament came to skip five of
    six models in a single burst on 2026-08-04.

    For the moment between `_sweep` reserving and `_claim_stale` answering,
    this reads `_SWEEP_TOKEN` rather than a run id. That is honest — recovery
    IS holding the slot — and every caller only asks whether it is held.
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


# What counts as the MACHINE refusing, rather than the model failing or the
# harness breaking. The mechanical signal is the error CLASS off the llm_call
# span: `prompt_too_long` is the router's own refusal when a prompt exceeds
# the VRAM-sized window (llm/router.py _refuse_local_overflow) — on this box
# a 24GB card shared with whisper, where a 20GB model can be refused outright
# on a normal prompt. The string signatures are the shapes ollama itself uses
# for a model that cannot load; they arrive classed only as `http_status`,
# which alone cannot be told apart from a 404. Classes first, strings second.
_RESOURCE_ERROR_CLASSES = frozenset({"prompt_too_long"})
_RESOURCE_SIGNATURES = ("requires more system memory", "out of memory",
                        "insufficient memory", "not enough vram",
                        "cudamalloc failed")


def resource_refusal(error_classes, messages) -> bool:
    """Was this failure the machine refusing, not the model answering badly?"""
    if any(c in _RESOURCE_ERROR_CLASSES for c in (error_classes or ())):
        return True
    joined = " ".join(str(m) for m in (messages or ())).lower()
    return any(sig in joined for sig in _RESOURCE_SIGNATURES)


# ── what a run actually MEASURED, derived ────────────────────────────────
#
# THE STATUS STRING IS NOT THE READING, and migration 127 exists because it
# was being used as one. On 2026-08-07 these two rows both surfaced to the
# operator as failure:
#
#   585f78c7  status 'failed'  task_index 7/7  tasks_passed 2   7m47s of work
#   aee6d5a7  status 'error'   task_index 0/0  "no heartbeat for 90s"
#
# The first is a completed measurement — every task in the suite was put to
# the model and graded, and it scored 2 — and the second is the harness dying
# before the model was asked anything. Opposite outcomes.
#
# So the question asked here is the mechanical one: HOW MANY OF THE SUITE'S
# TASKS WERE GRADED. `tasks_gradeable` is written after every task by
# `_persist_progress` (and recomputed from `detail->tasks` in SQL for rows old
# enough to predate the column), so the answer is a fact about work that
# finished, not a word someone chose. Nothing here maintains a list of
# statuses, which is the point: a status added later cannot silently fall
# through into the wrong bucket, because no bucket is keyed on the status.
MEASURED = "measured"        # every task graded — the score is real, high or low
PARTIAL = "partial"          # some tasks graded; the run stopped early
UNMEASURED = "unmeasured"    # nothing was graded — not a verdict on the model
UNKNOWN = "unknown"          # predates per-task grading; unknowable, not zero
RUNNING = "running"

# ── the same reading in SQL — ONE expression, not two ────────────────────
#
# `tasks_gradeable` was added late (migration 087/088), so a row older than it
# carries NULL — and NULL read as 0 would call every historical run
# unmeasured. The per-task entries in `detail->tasks` are the same fact
# written the other way, so they are counted when the column cannot answer.
# NULLIF keeps "no per-task record at all" distinct from a genuine zero: only
# the column can say zero, and `outcome` treats the two differently.
#
# EVERY READER OF "HOW MANY TASKS WERE GRADED" USES THIS ONE EXPRESSION.
# It did not, and the divergence was the exact failure migration 127 says
# cannot happen ("a run cannot be announced as a score the board refuses to
# rank"): the SELECT list fell back to `detail->tasks` while MEASURED_WHERE
# read the bare column, so a row with a complete per-task record and a NULL
# column was MEASURED to `outcome()` and invisible to the ranking. Measured
# on the live table 2026-08-07, before this was one expression:
#
#     rows with a NULL column but a complete detail->tasks record: 18
#     rows where outcome() and MEASURED_WHERE disagreed:           10
#     e.g. ff34dcf7 (main, ollama:ornith:9b) — outcome 'measured', label
#          '3/7', announced as "Eval finished: 3/7 on main"... and dropped
#          by model_tournament.standings and by estimate().
#
# So the fallback is not a nicety of the SELECT list, it is part of the
# definition, and a filter that omits it is a second definition.
_GRADED_EXPR = (
    "COALESCE(tasks_gradeable, NULLIF((SELECT count(*) FROM "
    "  jsonb_array_elements(CASE WHEN jsonb_typeof(detail->'tasks') = 'array' "
    "                            THEN detail->'tasks' ELSE '[]'::jsonb END) e "
    "  WHERE (e->>'gradeable')::boolean), 0))")

# What a SELECT list asks for: the derived count, under the column's name, so
# `outcome()` reads the same number whichever query handed it the row.
_GRADED_SQL = f"{_GRADED_EXPR} AS tasks_gradeable"

# What a WHERE clause asks for. `model_tournament.standings` has enforced this
# predicate since 2026-08-04 — that is where the wording of the last clause
# comes from — and it is lifted here so the ranking and every other surface
# cannot drift: one definition of "this run measured the model", used by both.
# It is the SQL restatement of `outcome()[…]['measurement']`, and
# test_eval_announcement §2 now proves that against every row in the live
# table rather than against four hand-written ones.
MEASURED_WHERE = (f"({_GRADED_EXPR}) IS NOT NULL "
                  f"AND ({_GRADED_EXPR}) = tasks_total AND tasks_total > 0")


def _f(row, key, default=None):
    """One field off a dict or an asyncpg Record, absent or NULL alike."""
    try:
        value = row[key]
    except (KeyError, IndexError, TypeError):
        return default
    return default if value is None else value


def _as_dict(value) -> dict:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return {}
    return value if isinstance(value, dict) else {}


def outcome(row) -> dict:
    """The honest reading of one run: is this a measurement, and of what?

    Returns `code`, `measurement` (the one boolean anything downstream should
    branch on), a short `label` for a table cell, a `headline` sentence, and
    `basis` — WHAT the reading rests on, because "measured" asserted without
    saying from what is the shape of claim this repo keeps catching.

    Deliberately pure and row-shaped: the panel, the notification and
    `eval_results` all read the same function, so an operator watching a run
    and an agent reporting on it cannot come to different conclusions. A
    TypeScript restatement in the panel would start lying the day this grows a
    case — the same argument that moved `_grades` into the backend.
    """
    status = str(_f(row, "status", "") or "")
    total = int(_f(row, "tasks_total", 0) or 0)
    passed = int(_f(row, "tasks_passed", 0) or 0)
    index = int(_f(row, "task_index", 0) or 0)
    resumes = int(_f(row, "resumes", 0) or 0)
    raw_graded = _f(row, "tasks_gradeable", None)
    graded = None if raw_graded is None else int(raw_graded)
    failure = _as_dict(_f(row, "failure", None))
    model = str(_f(row, "model", "a model") or "a model")
    suite = str(_f(row, "suite", "a suite") or "a suite")

    if status == RUNNING:
        # The SAME staleness predicate `progress` and the reaper use, computed
        # once here so a run cannot read healthy in one surface and stuck in
        # another — the second definition is how they come to disagree.
        raw_stall = _f(row, "stalled_for_s", None)
        stalled = raw_stall is not None and float(raw_stall) > STALE_AFTER_S
        where = f"task {index} of {total}" if total else "starting up"
        bits = [where]
        if resumes:
            bits.append(f"interrupted {resumes}×, resumed")
        if stalled:
            bits.append(f"stopped reporting {int(float(raw_stall))}s ago")
        return {"code": RUNNING, "measurement": False, "stalled": stalled,
                "label": " · ".join(bits),
                "headline": f"{model} on {suite} — {' · '.join(bits)}",
                "basis": "the per-task cursor this run persists as it goes",
                "graded": graded, "total": total, "passed": passed}

    if graded is None and not total:
        # It never got as far as loading a suite — `_certify_dead` reaps rows
        # like this with tasks_total 0 and nothing in `detail->tasks`. That is
        # not an unknown measurement, it is the absence of one, and the
        # failure record says why. aee6d5a7, the row this lane was written
        # from, is exactly this shape.
        code = UNMEASURED
        basis = ("it recorded no tasks at all — it stopped before the suite "
                 "was put to the model")
    elif graded is None:
        # Old rows: a task count, but no per-task record in the column or in
        # `detail->tasks`. UNKNOWN and never MEASURED — "unknowable" and
        # "complete" are different, and standings has excluded these from the
        # ranking since 2026-08-04 for exactly that reason. Calling them
        # measured here would put a number in a notification that the board
        # refuses to rank.
        code = UNKNOWN
        basis = ("nothing was recorded about which of its tasks were graded "
                 "— this run predates per-task grading, so whether it "
                 "measured anything is unknowable, not zero")
    elif total and graded >= total:
        code, basis = MEASURED, f"all {total} tasks were graded"
    elif graded > 0:
        code = PARTIAL
        basis = (f"{graded} of {total} tasks were graded before it stopped"
                 if total else f"{graded} tasks were graded")
    else:
        code = UNMEASURED
        basis = "no task could be graded — the model was never reached"

    why = str(failure.get("message") or _f(row, "error", "") or "").strip()
    kind = str(failure.get("type") or "").strip()
    refused = bool(failure.get("resource_refusal"))
    if code == MEASURED:
        label = f"{passed}/{total}"
        headline = (f"{model} scored {passed} of {total} on the {suite} "
                    f"suite")
    elif code == PARTIAL:
        label = f"incomplete — {graded}/{total} graded"
        headline = (f"{model} on {suite} stopped after {graded} of {total} "
                    f"tasks — an incomplete run, not a score")
    elif code == UNKNOWN:
        label = f"{passed}/{total} — unverifiable"
        headline = (f"{model} on {suite} recorded {passed} of {total}, from "
                    f"before runs said which tasks they graded — the score "
                    f"cannot be verified and the ranking does not use it")
    else:
        label = "refused — out of resources" if refused else "no measurement"
        headline = (f"{model} on {suite} measured nothing"
                    + (" — the machine refused it, which is a fact about this "
                       "box and not about the model" if refused else
                       " — the harness stopped it before it could be graded"))
    return {"code": code, "measurement": code == MEASURED, "stalled": False,
            "label": label, "headline": headline, "basis": basis,
            "graded": graded, "total": total, "passed": passed,
            "resumes": resumes, "stopped_at_task": index,
            "failure_type": kind or None, "why": why or None,
            "resource_refusal": refused}


# How many times a run may be picked up again before the answer stops being
# "resume it". Same shape and the same reasoning as action_worker.MAX_ORPHANS:
# a run that dies three times running is not being interrupted by bad luck,
# it is killing the process, and requeueing it forever would burn the box.
MAX_RESUMES = 3

# The staleness clause, written once. `reconcile_orphans` and the claim both
# have to mean the SAME thing by "this run has stopped reporting", and the one
# time they would disagree is the one time it matters: a live run stolen from
# the process that is still executing it. COALESCE to started_at so a run that
# died before its first beat is still reachable.
_STALE = (" COALESCE((detail->>'heartbeat')::timestamptz, started_at) "
          f" < now() - interval '{STALE_AFTER_S} seconds' ")


def _load_state(row) -> dict:
    """Everything a resumed run needs to carry on, read off its own row.

    DERIVED FROM THE ROW, never from anything held in memory — the process
    that held it is the one that died. `detail->tasks` is the receipt of the
    tasks already graded, and the totals are recomputed from it rather than
    trusted from the columns, so a half-written row cannot inflate a score.
    """
    detail = row["detail"]
    detail = json.loads(detail) if isinstance(detail, str) else (detail or {})
    entries = list(detail.get("tasks") or [])
    classes: set[str] = set()
    errors: list[str] = []
    for e in entries:
        classes.update(e.get("error_classes") or ())
        errors.extend(e.get("errors") or ())
    return {
        "details": entries,
        "passed": sum(1 for e in entries if e.get("passed")),
        "classes": classes,
        "errors": errors,
        "tin": int(row["tokens_in"] or 0),
        "tout": int(row["tokens_out"] or 0),
        "duration": float(row["duration_s"] or 0.0),
    }


async def _persist_progress(run_id: str, *, index: int, total: int,
                            passed: int, graded: int, tin: int, tout: int,
                            duration: float, details: list[dict]) -> None:
    """Write the cursor and everything earned so far. Called after EVERY task.

    This is the whole fix. `_execute` used to write once, in its `finally`,
    which meant a restart at task 6 of 7 kept nothing — 175 rows in this
    table have tasks_total = 0 for exactly that reason, several of them after
    forty minutes of real work.

    `detail || {...}` rather than an assignment: the heartbeat writer and any
    recorded failure live in the same column, and clobbering the whole
    document here would erase the one timestamp that bounds a later death.
    """
    payload: dict = {"tasks": details}
    if notifications.test_context() is not None:
        # THE TEST STAMP, riding the write that every driven run makes —
        # including rows the suites INSERT with raw SQL, which `start`'s
        # stamp can never reach. A stamped row is one the announce path
        # closes silently and the backlog sweep skips: on 2026-08-08 the
        # live backend's 60s sweep found unannounced terminal rows a suite
        # had left for a moment and re-manufactured junk announcements into
        # the operator's conversation at 12:15Z.
        payload["test"] = True
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE eval_runs "
            "   SET task_index = $2, tasks_total = $3, tasks_passed = $4, "
            "       tasks_gradeable = $5, tokens_in = $6, tokens_out = $7, "
            "       duration_s = $8, detail = detail || $9::jsonb "
            " WHERE id = $1::uuid",
            run_id, index, total, passed, graded, tin, tout,
            round(duration, 1), json.dumps(payload))


async def _park(run_id: str, *, error: str, failure: dict) -> None:
    """End a run that cannot continue, WITH the reason attached.

    Deliberately `error` and never `failed`: every caller of this is the
    harness or the machine refusing, and recording that as a verdict on the
    model is the exact lie the whole failure-legibility pass exists to stop.
    """
    doc: dict = {"failure": failure}
    if notifications.test_context() is not None:
        doc["test"] = True     # same stamp `_persist_progress` writes, same why
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE eval_runs SET status = 'error', finished_at = now(), "
            "       error = $2, detail = detail || $3::jsonb "
            " WHERE id = $1::uuid AND status = 'running'",
            run_id, error[:500], json.dumps(doc))
    log.warning("eval run %s parked: %s", run_id, error)
    # A parked run is terminal, and the operator is owed it: he pressed a
    # button eight minutes ago and this is the answer, even when the answer
    # is "it could not be finished".
    await announce(run_id)


async def _claim_stale(instance: str,
                       only_run: Optional[str] = None) -> Optional[dict]:
    """Take ownership of ONE run that has stopped reporting, or None.

    `only_run` NARROWS the claim to a single id and exists because of a real
    incident, not for symmetry. `tests/test_eval_durability.py` drives this
    against the live database — the only way to prove a resume actually
    resumes — and it monkeypatches `suites.load_suite` to a four-task fake.
    On 2026-08-07 it ran while a genuine `skill-manager` run was in flight
    seconds old: the bare claim took the real row, `_resume` compared its
    recorded v3 against the fake suite's v1, and parked a healthy run as
    `suite_changed`. The test was right about everything it asserted and
    still corrupted a live measurement.
    The lesson is the one this repo keeps relearning (see
    `staged-tree-suite-mutates-live`): a suite that can reach live rows will,
    and the fix is a line of code that cannot, not a note telling the next
    author to be careful. Production passes nothing and claims the whole pool.

    `FOR UPDATE SKIP LOCKED` is the control, not the leader check above it:
    leadership is a soft fact that can be in flux for a few seconds during an
    election, and two processes both deciding to rescue one run would run its
    remaining tasks twice and append both sets of results. The row lock is
    what refuses.

    Claiming BUMPS `resumes` and stamps the heartbeat forward in the same
    statement. Both matter. The bump is what makes MAX_RESUMES terminate — a
    run that kills the process on task 4 would otherwise be picked up at every
    boot forever. The stamp is what stops the very next reconcile pass, in
    this process or another, seeing a still-stale row and claiming it again
    before the resumed run has had time to beat.

    Because the bump SPENDS one of the run's three lives, a caller must
    already hold the in-process slot before calling this — `_sweep` reserves
    it under `_SWEEP_TOKEN` first and rebinds it afterwards. Claiming and
    then discovering you cannot honour it is not free: three such claims
    exhaust MAX_RESUMES and get a healthy run certified dead having run
    nothing.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE eval_runs "
            "   SET resumes = resumes + 1, claimed_by = $1, "
            "       detail = jsonb_set(detail, '{heartbeat}', to_jsonb(now())) "
            " WHERE id = (SELECT id FROM eval_runs "
            "              WHERE status = 'running' "
            f"               AND resumes < {MAX_RESUMES} "
            f"               AND {_STALE} "
            "                AND ($2::uuid IS NULL OR id = $2::uuid) "
            "              ORDER BY started_at "
            "              FOR UPDATE SKIP LOCKED LIMIT 1) "
            " RETURNING *", instance, only_run)
    return dict(row) if row else None


async def _resume(row: dict) -> bool:
    """Carry one claimed run on from its cursor — or refuse, with the reason.

    Returns True only if `_execute` was actually entered. The caller counts
    resumes off this and not off the claim, because a claim that parks the row
    resumed nothing and reporting it as a resume is the "fallback that reads
    as success" this repo keeps finding.

    THE REFUSALS ARE THE POINT. "Resume it" is only the right answer while the
    thing being resumed is still the same measurement, and three ways it can
    stop being one are checked against LIVE state before a single task runs:

    * the suite no longer loads — there is nothing left to run;
    * the suite's version moved — the remaining tasks are not the tasks the
      first half was graded against, so finishing would produce one score
      describing two different suites. This is the same rule `standings` and
      `next_pairing` already enforce on recorded rows, applied at the one
      moment it can still be enforced honestly;
    * the model no longer resolves to itself — its provider went away, so
      carrying on would silently grade the fallback. `start` refuses this at
      the front door for the same reason.

    Each parks the row with a named failure type. None of them is 'failed'.
    """
    from app.evals import suites as suite_mod
    from app.llm import router as llm_router

    run_id = str(row["id"])
    cursor = int(row["task_index"] or 0)
    resumes = int(row["resumes"] or 0)
    base = {"resumes": resumes, "resumed_from_task": cursor,
            "resource_refusal": False}

    if run_id in _executing:
        # IT IS NOT DEAD, IT IS RIGHT HERE. A live run whose heartbeat lapsed
        # — a database blip, pool starvation, the loop blocked past
        # STALE_AFTER_S — looks exactly like a corpse to the claim. Resuming
        # it starts a second `_execute` on top of the first: the remaining
        # tasks run twice, double tokens and GPU, and two coroutines race
        # `_persist_progress` on one detail->tasks document so the loser's
        # terminal UPDATE overwrites the winner's. The heartbeat is what
        # usually prevents this; this is the line that refuses when it fails.
        # Nothing is parked — the run is fine, it is executing.
        log.warning("eval: refusing to resume %s — this process is already "
                    "executing it (its heartbeat lapsed, it did not die)",
                    run_id)
        return False

    try:
        suite = suite_mod.load_suite(row["suite"])
    except Exception as exc:  # noqa: BLE001
        await _park(run_id,
                    error=f"the suite {row['suite']!r} no longer loads, so this "
                          f"interrupted run cannot be finished: {exc}",
                    failure=dict(base, type="suite_gone", message=str(exc)[:500]))
        return False
    if row["suite_version"] is not None and suite.version != row["suite_version"]:
        msg = (f"this run was measuring {row['suite']} v{row['suite_version']} "
               f"and the suite is now v{suite.version} — the remaining tasks "
               f"are not the ones the finished half was graded against, so it "
               f"was stopped rather than mixed")
        await _park(run_id, error=msg,
                    failure=dict(base, type="suite_changed", message=msg))
        return False
    effective = llm_router.effective_model(row["model"])
    if effective != row["model"]:
        msg = (f"{row['model']} now resolves to {effective} — its provider is "
               f"no longer configured, so resuming would grade the fallback "
               f"instead of the model this run is recorded against")
        await _park(run_id, error=msg,
                    failure=dict(base, type="model_unresolvable", message=msg))
        return False

    # THE SLOT. `_sweep` reserves it before it claims anything and rebinds it
    # to this id, so the common path finds it already ours; a direct caller
    # (the durability suite) has not, so it is taken here. Either way nothing
    # below this line runs unless this run holds the slot.
    if _running != run_id and not await _reserve_slot(run_id):
        log.info("eval: not resuming %s yet, the slot is held by %s",
                 run_id, _running)
        return False
    prior = _load_state(row)
    log.warning("eval run %s: resuming at task %d (interrupted %d× so far)",
                run_id, cursor, resumes)
    try:
        await _execute(run_id, row["suite"], row["model"],
                       int(row["repeat_count"] or 1),
                       resume_from=cursor, prior=prior)
    finally:
        # `_execute` frees it on every path it reaches; this covers the one it
        # does not — its own refusal to run a run twice, which raises before
        # the try that owns the release.
        _release_slot(run_id)
    return True


# How often the recovery sweep re-asks. It can only ever claim a row that has
# been silent for STALE_AFTER_S, so sweeping faster than that window costs
# nothing and cannot take a live run.
SWEEP_EVERY_S = 60.0


async def reconcile_orphans(delay_s: float = 0.0) -> dict:
    """Boot recovery: resume what can be resumed, certify only what cannot.

    IT RE-ARMS ITSELF when called with a delay, which is how boot calls it,
    and that is not tidiness — a boot-only sweep is UNREACHABLE on this box.
    Boot schedules the first pass STALE_AFTER_S + 15 = 105s out, because a
    run this process did not kill may be alive elsewhere and the only proof
    is the heartbeat window passing. Measured 2026-08-07 while verifying this
    lane, from the backend's own log:

        22:04:09 ready   22:05:17 reload   (68s)
        22:05:18 ready   22:06:21 reload   (63s)
        22:06:22 ready   22:08:03 reload  (101s)

    Three consecutive uptimes, none of them 105 seconds. Every scheduled
    recovery was cancelled by the next reload before it ran, so a stalled run
    would have waited for a quiet two minutes that never came — the failure
    this lane exists to fix, reintroduced one level up. Re-arming means the
    sweep only needs the window to pass ONCE, whenever that happens.

    THIS IS THE BOOT HOOK, unchanged in name and signature because main.py's
    call site is the one place a restart is guaranteed to run something, and a
    recovery that needs a second wiring step is a recovery that is one missed
    line away from never happening. What changed is what it does when it finds
    a run that stopped reporting: since migration 124 the first answer is to
    carry it on from its cursor, and death is the answer only for a run that
    has already been carried on MAX_RESUMES times and kept dying.

    Order matters. `_certify_dead` runs FIRST, so the exhausted rows are out of
    the pool before the claim looks; the claim's own `resumes < MAX_RESUMES`
    means neither can take the other's row even if they raced.

    Drains, because only one eval executes at a time — "drain" is a queue of
    at most a handful by construction. Leader-gated like every other durable
    worker in this repo; the row lock inside `_claim_stale` is what actually
    enforces one owner, because leadership is a soft fact that can be in flux
    for a few seconds during an election.
    """
    if delay_s:
        await asyncio.sleep(delay_s)
    try:
        return await _sweep()
    finally:
        if delay_s:
            # RE-ARMED IN `finally`, so a sweep that raised does not silently
            # end the chain — a recovery that stops running is exactly as
            # useless as one that never ran, and it would leave no trace.
            # Cancelled with the loop at shutdown, which is a clean end.
            from app import bg
            bg.spawn(reconcile_orphans(delay_s=SWEEP_EVERY_S),
                     name="eval-recovery")


async def _sweep(only_run: Optional[str] = None) -> dict:
    """One pass. Split out so `reconcile_orphans` re-arms exactly one thing.

    `only_run` narrows the claim to a single id, for the same reason and with
    the same history as `_claim_stale`'s: `tests/test_eval_durability.py`
    drives this against the live database — the only way to prove the
    reserve-before-claim ordering actually holds — and an unscoped sweep
    reaches every live row. Production passes nothing and claims the pool.

    RESERVE, THEN CLAIM — never the other way round. A claim is destructive:
    it bumps `resumes` and stamps the heartbeat forward. Taking one this
    process cannot honour is therefore not a harmless no-op, it SPENDS a
    life. The old order claimed first and asked the in-process slot second,
    inside `_resume`, so a recoverable run that happened to be stale while
    some other eval held the slot was charged a resume by every 60s sweep
    without a single task being attempted, and `_certify_dead` reaped it at
    the ceiling. Measured 2026-08-07 against the live database:

        sweep 1..3  claimed=True  resumes=1/2/3
        after 3 sweeps: {'status':'running','resumes':3,'task_index':2}
        tasks actually run: []
        _certify_dead would reap it: True

    — a fully recoverable run destroyed, and the row left claiming it had
    been resumed three times, in the table this lane exists to make
    trustworthy.
    """
    from app import instances
    parked = await _certify_dead()
    resumed = refused = 0
    held: Optional[str] = None
    if not instances.is_leader():
        return {"resumed": 0, "parked": parked, "refused": 0, "announced": 0,
                "slot_held_by": None, "leader": False}
    instance = await _instance_id()
    while True:
        if not await _reserve_slot(_SWEEP_TOKEN):
            held = _running
            log.info("eval recovery: claimed nothing, the slot is held by %s",
                     held)
            break
        row = await _claim_stale(instance, only_run)
        if row is None:
            _release_slot(_SWEEP_TOKEN)
            break
        run_id = str(row["id"])
        await _rebind_slot(_SWEEP_TOKEN, run_id)
        try:
            if await _resume(row):
                resumed += 1
            else:
                refused += 1
        except Exception:  # noqa: BLE001 — one bad row is not the fleet
            refused += 1
            log.exception("eval: resuming run %s failed", run_id)
        finally:
            _release_slot(run_id)
    # OVERDUE RESULTS, on the same 60s pass. A run whose own process was
    # killed between writing its verdict and telling anyone is the exact case
    # this lane exists for, and nothing else would ever pick it up. Scoped
    # off for `only_run` for the reason `_claim_stale` documents at length:
    # the durability suite drives this against the LIVE database, and an
    # unscoped pass reaches every real row — including, on 2026-08-07, a
    # healthy run it corrupted.
    announced = 0 if only_run else await _announce_backlog()
    if resumed or parked or refused or announced:
        log.warning("eval recovery: resumed %d, refused %d, closed out %d, "
                    "announced %d overdue", resumed, refused, parked, announced)
    return {"resumed": resumed, "parked": parked, "refused": refused,
            "announced": announced, "slot_held_by": held, "leader": True}


async def _instance_id() -> str:
    from app import instances
    try:
        return await instances.ensure_id()
    except Exception:  # noqa: BLE001 — an unnameable claimant still claims
        return "unknown"


async def _certify_dead() -> int:
    """Close out runs that really did die AND cannot be carried on.

    A run executes in-process (asyncio.create_task), and the dev server runs
    with --reload, so ANY source edit kills it. Without this the row stays
    `running` forever and reads as "still going". Marked `error`, never
    `failed`: the harness died, which is not a verdict on the model, and
    recording it as one would be a lie that later shows up in a picker.

    IT NO LONGER REAPS EVERY DEAD RUN. Since migration 124 a run persists a
    per-task cursor, so the first answer to "this one stopped reporting" is
    `recover()` picking it up where it left off. This is the second answer,
    for the runs that have already been picked up MAX_RESUMES times and kept
    dying — at which point the honest record is that the harness could not
    complete it, and how many attempts that took.

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
    beats is reaped. The caller schedules this past the staleness window, so a
    run this process actually did kill is still caught, without blocking the
    boot and without libelling anyone else's.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "UPDATE eval_runs SET status='error', finished_at=now(), "
            "       error='the run stopped reporting ' || (resumes + 1)::text "
            "               || '× and was declared dead', "
            # Say WHY in detail->failure, in the same shape _execute records.
            # These rows used to carry an empty detail (or a bare heartbeat)
            # and tasks_gradeable NULL, so a night the process died under was
            # indistinguishable from a model that is bad — gemma4:12b wore
            # that ambiguity for weeks. What was OBSERVED is silence, so
            # that is all the record claims; the last heartbeat rides along
            # because it is the one timestamp that bounds the death.
            #
            # `resumes` and `resumed_from_task` are now part of that record.
            # They are the difference between "the harness kept being killed"
            # and "the model could not be graded", which are the two states
            # the operator most needs told apart and which used to render
            # identically. What was measured before the last death is NOT
            # thrown away: `detail->tasks` keeps every graded task, and
            # tasks_passed / tasks_total are already the live cursor totals.
            "       detail = jsonb_set(detail, '{failure}', "
            "                jsonb_build_object("
            "                    'type', 'declared_dead', "
            "                    'message', 'no heartbeat for "
            f"{STALE_AFTER_S}s, after ' || resumes::text || ' resume(s) from "
            "task ' || task_index::text || '. The process running this eval "
            "kept going away before it could record a reason — that is the "
            "harness, not a verdict on the model', "
            "                    'resource_refusal', false, "
            "                    'resumes', resumes, "
            "                    'resumed_from_task', task_index, "
            "                    'last_heartbeat', detail->'heartbeat')) "
            " WHERE status='running' "
            # THE NEW CLAUSE, and the whole behavioural change: a run that has
            # not used up its resumes is not dead, it is interrupted, and
            # `recover()` gets it. Only an exhausted one is certified.
            f"   AND resumes >= {MAX_RESUMES} "
            f"   AND {_STALE} "
            " RETURNING id")
    if rows:
        log.warning("eval: %d run(s) stopped reporting %d× and were closed out",
                    len(rows), MAX_RESUMES)
    # The UPDATE above is the claim — only one process can win a row — so
    # announcing exactly what it returned is exactly-once without a second
    # gate, and it happens here rather than in `_sweep` because `_sweep`
    # returns early for a follower while this runs for everyone.
    for r in rows:
        await announce(str(r["id"]))
    return len(rows)


async def estimate(suite: str) -> dict:
    """What this suite has cost before — the basis for the operator warning.

    Returns `measured: False` and no figures when it has never been run.
    Saying "unknown" is worth more than a fabricated number in a dialog whose
    whole job is telling someone what they are about to spend.

    ONLY COMPLETE RUNS COUNT (migration 127). `status IN ('passed','failed')`
    let a run killed at task 3 of 7 into the median, so the figure the operator
    is shown before spending eight minutes was partly the cost of runs that
    stopped early — an under-estimate built from the same confusion between a
    verdict and an interruption that this whole lane is about. The same
    predicate the ranking uses, for the same reason.
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
            "  FROM eval_runs WHERE suite = $1 "
            "   AND status IN ('passed','failed') "
            f"  AND {MEASURED_WHERE}",
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
    # detail->'failure' rides along so an error night can SAY why it died —
    # a VRAM-refused run and a bad model used to render identically as
    # "did not finish", which is the ambiguity the failure record exists
    # to remove. The full detail (per-task breakdown) stays behind, it is
    # too big for a list endpoint.
    #
    # task_index / resumes / stalled_for_s ride along too (migration 124).
    # They are what makes a run OPERABLE rather than a black box: "3 of 7,
    # last beat 4s ago" and "3 of 7, last beat 40 minutes ago" are the two
    # states a person watching a run needs to tell apart, and both used to
    # render as a bare 'running'. `stalled_for_s` is derived from the same
    # heartbeat the reaper reads, so a stuck run cannot look healthy here and
    # dead there.
    #
    # `outcome` rides along too (migration 127), and it is the field a caller
    # should branch on. A run that graded all seven tasks and scored two is a
    # RESULT; a run that graded none is the harness failing. Both used to be
    # 'failed'/'error' and both rendered as "did not finish", which is how a
    # measurement Jeremy had paid eight minutes for reached nobody.
    #
    # `announcement` says whether he was told, so "did anyone see this?" is a
    # fact read off the row rather than an assumption made about it.
    sql = ("SELECT id, suite, agent_name, model, status, started_at, "
           "       finished_at, tasks_total, tasks_passed, tokens_in, "
           "       tokens_out, duration_s, error, repeat_count, suite_version, "
           "       task_index, resumes, announced_at, announcement, "
           f"      {_GRADED_SQL}, "
           "       detail->'failure' AS failure, "
           "       CASE WHEN status = 'running' THEN round(extract(epoch FROM "
           "            now() - COALESCE((detail->>'heartbeat')::timestamptz, "
           "                             started_at))) END AS stalled_for_s "
           "  FROM eval_runs")
    args: list = []
    if agent_name:
        sql += " WHERE agent_name = $1"
        args.append(agent_name)
    sql += " ORDER BY started_at DESC LIMIT " + str(int(limit))
    async with db.acquire() as conn:
        rows = [dict(r) for r in await conn.fetch(sql, *args)]
    for r in rows:
        if isinstance(r.get("failure"), str):
            try:
                r["failure"] = json.loads(r["failure"])
            except ValueError:
                r["failure"] = None
        r["announcement"] = _as_dict(r.get("announcement")) or None
        r["outcome"] = outcome(r)
    return rows


async def progress(run_id: str) -> Optional[dict]:
    """One run, task by task, with a MECHANICAL reading of whether it is stuck.

    `stalled` is not a word anyone types: it is `stalled_for_s > STALE_AFTER_S`
    on a row still marked running, which is the identical predicate the reaper
    and the claim use. That is the point — an operator asking "is this stuck?"
    and the recovery deciding "is this stuck?" must not be able to disagree,
    and a second definition typed into a UI or a tool description is how they
    come to.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, suite, agent_name, model, status, started_at, "
            "       finished_at, tasks_total, tasks_passed, "
            "       task_index, resumes, repeat_count, suite_version, "
            "       tokens_in, tokens_out, duration_s, error, claimed_by, "
            "       announced_at, announcement, "
            f"      {_GRADED_SQL}, "
            # The test stamp, so `_announce` can refuse a suite-written row
            # from ANY process — the sweep that re-manufactures junk runs in
            # the live backend, where no test signal exists in the process.
            "       COALESCE((detail->>'test')::boolean, false) AS test_run, "
            "       detail->'tasks' AS tasks, detail->'failure' AS failure, "
            "       round(extract(epoch FROM now() - COALESCE("
            "           (detail->>'heartbeat')::timestamptz, started_at))) "
            "           AS stalled_for_s "
            "  FROM eval_runs WHERE id = $1::uuid", run_id)
    if not row:
        return None
    out = dict(row)
    for key in ("tasks", "failure"):
        if isinstance(out.get(key), str):
            try:
                out[key] = json.loads(out[key])
            except ValueError:
                out[key] = None
    out["announcement"] = _as_dict(out.get("announcement")) or None
    # ONE definition of every reading. `stalled` used to be computed here and
    # `outcome` computes it too; two copies of a predicate is how a run comes
    # to read healthy in the panel and stuck in the tool. This is the copy
    # that was deleted.
    out["outcome"] = outcome(out)
    stalled = out["outcome"]["stalled"]
    out["stalled"] = stalled
    if out["status"] != "running":
        out["stalled_for_s"] = None
    out["note"] = (
        f"stopped reporting {int(out['stalled_for_s'] or 0)}s ago at task "
        f"{out['task_index']} of {out['tasks_total']}; it has already been "
        f"resumed {out['resumes']}× of {MAX_RESUMES} allowed. Recovery picks "
        f"it up at the next backend start — this is the harness, not the model"
        if stalled else
        f"task {out['task_index']} of {out['tasks_total']}"
        if out["status"] == "running" else
        # NOT `status: passed/total` any more. That line is what taught every
        # reader — including her — to say "failed 2/7" about a run that
        # measured cleanly. The derived reading leads, and the status word
        # rides behind it where it can still be looked up.
        f"{out['outcome']['headline']} ({out['outcome']['basis']}; "
        f"recorded status {out['status']})")
    return out


async def latest_verdicts() -> list[dict]:
    """The newest finished verdict per (agent, model) — what a picker shows.

    `repeat_count` and `suite_version` ride along because a bare "2/7" in a
    picker is the exact over-reading migration 086 exists to stop: one draw
    against a suite that has since moved looks identical to a repeated run
    against the current one.

    So does `outcome`. `status IN ('passed','failed')` is NOT the same
    question as "was this a measurement": a run killed at task 3 of 7 lands
    'failed' with 3 graded, and its 1/7 in a picker reads as a model that
    answered six questions wrongly. The row now says which it is; the caller
    decides what to do about it, rather than being told a number and nothing
    else.
    """
    async with db.acquire() as conn:
        rows = [dict(r) for r in await conn.fetch(
            "SELECT DISTINCT ON (agent_name, model) agent_name, model, status, "
            "       tasks_passed, tasks_total, started_at, repeat_count, "
            "       suite_version, suite, task_index, resumes, "
            f"      {_GRADED_SQL} "
            "  FROM eval_runs WHERE status IN ('passed','failed') "
            " ORDER BY agent_name, model, started_at DESC")]
    for r in rows:
        r["outcome"] = outcome(r)
    return rows


# ── telling the operator, once the run has a result ──────────────────────
#
# Jeremy, 2026-08-07: "I ran a model eval test, haven't seen any update." The
# run had finished seven minutes earlier. A suite is eight minutes of wall
# clock — nobody watches one — so a result that only exists in a table is a
# result nobody has.
#
# The channel is migration 125's, deliberately and not by convenience: it
# records the notification, puts a POINTER to it in the conversation, and
# deep-links the push at the same row, so the news survives the transport
# failing and a tap lands on the thing that was tapped.
#
# ONE RUN, ONE ANNOUNCEMENT — AND `dedupe_key` IS NOT WHAT ENFORCES IT
# (migration 128). This file used to say the run-id dedupe key made two
# racing callers fold onto one notification. It does not, and the claim was
# measured false: `notify.send` reads `notifications.find_repeat` and then
# inserts, with a plain btree on the fingerprint, so two callers that read
# before either writes both publish. Three concurrent `_announce` calls on
# one terminal run produced 3 pushes, 3 notification rows and 3 chat
# pointers, every one of them returning `deduped: False`; the same three
# serialized produced 1 push and two `deduped: True`.
#
# So the dedupe key stays — it is exactly right for the SERIALIZED retry,
# which is what happens when a send succeeds and the record of it does not —
# and the race is refused a step earlier by `_claim_announce`, a leased
# claim on the row taken before the send. `_execute` announcing its own
# verdict and `_sweep`'s backlog pass are on the same event loop 60s apart,
# and a second backend is normal here, so this has to hold across processes:
# only the database can say it.
#
# THE LEASE IS DELIBERATELY SHORTER THAN `notifications.DEDUPE_WINDOW_S`
# (300s). The one case where a claim expires with the news already sent is a
# process that published and then died before recording it; the sweep's
# retry then lands inside the fingerprint window, so it folds onto the
# notification the dead process left behind and is recorded as `deduped`
# instead of buzzing a second time. Longer than that window and the retry
# would be a second push. test_eval_announcement §7 holds the two numbers in
# that order.
ANNOUNCE_LEASE_S = 180


def announcement_text(row) -> tuple[str, str]:
    """(title, body) for a run that has a result. Pure, so it is testable.

    Carries what an operator asked to look away for eight minutes needs back:
    which model, which suite, the score, whether the score MEANS anything, and
    where the per-task detail is. Nothing here is phrased from the status
    word; every claim comes off `outcome`.
    """
    o = _f(row, "outcome", None) or outcome(row)
    suite = _f(row, "suite", "a suite")
    version = _f(row, "suite_version", None)
    repeat = int(_f(row, "repeat_count", 1) or 1)
    duration = float(_f(row, "duration_s", 0) or 0)
    took = (f" It took {int(duration // 60)}m{int(duration % 60):02d}s of "
            f"model time." if duration else "")
    tag = f" (v{version})" if version is not None else ""
    reps = f", {repeat}× each" if repeat > 1 else ""

    if o["code"] == MEASURED:
        title = f"Eval finished: {o['label']} on {suite}"
        body = (f"{o['headline']}{tag}{reps}.{took} "
                f"Every task was graded, so this is a measurement and not a "
                f"crash — a low score here is the model's, not the harness's.")
    else:
        # NOT "failed". Whatever this run was, it was not a verdict on the
        # model, and the title is the one line that reaches a lock screen.
        title = f"Eval produced no usable score: {suite}"
        body = f"{o['headline']}{tag}{reps}.{took}"
        if o.get("why"):
            body += f" Reason: {o['why']}"
            if o.get("failure_type"):
                body += f" ({o['failure_type']})"
            body += "."
        if o.get("resumes"):
            body += (f" It was interrupted and resumed {o['resumes']}× before "
                     f"this.")
        body += {
            UNMEASURED: " Nothing about the model can be read off this run.",
            PARTIAL: " The tasks it did grade are a partial run, not a score.",
        }.get(o["code"], " This run cannot be verified, so nothing is claimed "
                         "from it.")
    return title, body + " Per-task detail: Library → Models → Run history."


def announce_link(run_id: str) -> str:
    """Where "show me the detail" goes. A real route, checked by hand against
    AppShell's `/library/:kind` — a deep link into a page that does not exist
    is a worse answer than no link."""
    return f"/library/models?run={run_id}"


async def _claim_announce(run_id: str) -> bool:
    """Take the announce step for this run. True iff it is now ours to do.

    THE GATE FOR THE RACE, and the reason it is a database write rather than
    an `asyncio.Lock`: the two callers that collide are not always in one
    process. `_execute` announces its own verdict while the leader's 60s
    sweep is announcing the backlog, and a second backend (a test run,
    `python -m app.evals`, another container) is the normal case in this
    repo, not an edge one.

    Exactly one winner comes out of concurrent callers because under READ
    COMMITTED the second UPDATE blocks on the winner's row lock and then
    re-evaluates its WHERE against the committed row — where
    `announce_claimed_at` is now fresh, so it matches nothing and returns no
    row. Same shape as `_claim_stale`.

    A LEASE, NOT A FLAG. A process that dies between claiming and sending
    must not silence the result forever; `ANNOUNCE_LEASE_S` later the claim
    is dead and `_announce_backlog` picks the run up again, which is the
    whole point of that sweep. The lease is long enough to cover a slow
    provider (notify.send does network I/O) and short enough that a killed
    backend costs the operator one sweep, not a night.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE eval_runs "
            "   SET announce_claimed_at = now(), announce_claimed_by = $2 "
            " WHERE id = $1::uuid "
            "   AND announced_at IS NULL "
            "   AND (announce_claimed_at IS NULL "
            f"        OR announce_claimed_at < now() - interval "
            f"           '{ANNOUNCE_LEASE_S} seconds') "
            " RETURNING id", run_id, await _instance_id())
    return row is not None


async def _record_announcement(run_id: str, doc: dict) -> bool:
    """Close the announce step for this run, WITH the account of how it went.

    `WHERE announced_at IS NULL` makes the ROW exactly-once, and it is the
    second line of defence rather than the first: the send happens before
    this, so a process dying between them retries — and the retry, being
    serialized with the attempt that died, folds onto the same notification
    through notify.send's fingerprint window rather than buzzing twice.
    Claiming first would have been the other trade, and it produces a row
    that says the operator was told by a process that died before telling
    him, which is the failure mode this repo is named for.

    What this cannot do is make the NOTIFICATION exactly-once, because it
    runs after the send — two callers racing have both already published by
    the time either gets here. `_claim_announce` is the line that refuses
    that, one step earlier.

    Migration 127's CHECK refuses a doc with no `how`, so a caller that
    swallowed its reason cannot write a blank claim.
    """
    doc = {**doc}
    doc.setdefault("how", "no account of the delivery was recorded")
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE eval_runs SET announced_at = now(), "
            "       announcement = $2::jsonb "
            " WHERE id = $1::uuid AND announced_at IS NULL RETURNING id",
            run_id, json.dumps(doc))
    if row is None:
        log.info("eval run %s was already announced by someone else", run_id)
    return row is not None


async def _announce(run_id: str) -> Optional[dict]:
    """Tell the operator this run has a result. Returns what was recorded.

    Reads the row back rather than being handed a summary: the row is the
    fact, and a message built from in-memory variables is a message about
    what the process THOUGHT it wrote.

    NOTHING HERE INVENTS A DELIVERY. The dict written onto the run is
    notify.send's own — its state, its `delivery_label` (the honest line:
    "accepted by webpush — not confirmed received"), and `confirmed`, which
    is true for exactly one state. A transport failure still closes the step,
    because retrying a refused provider forever is nagging, and the failure
    is written where the panel shows it; only an announce that never reached
    a notification row at all is left open for the sweep.
    """
    from app import notify

    row = await progress(run_id)
    if row is None:
        log.warning("eval: cannot announce %s — no such run", run_id)
        return None
    if row["status"] == RUNNING:
        # Migration 127 refuses this at the database too. A run still going
        # has no result, and announcing a score it has not finished earning
        # is the thing every other guard in this file is about.
        log.warning("eval: refusing to announce %s — it is still running",
                    run_id)
        return None
    if row.get("announced_at"):
        return None
    # The ROW STAMP decides, not the calling process. A process signal here
    # would be wrong in both directions: the junk sweep runs in the LIVE
    # backend (no test signal in the process, only the stamp says), and
    # test_eval_announcement drives this function through a faked transport
    # to pin the real recording behaviour (a process signal would suppress
    # the very path under test). The stamp is written where the suite touches
    # the row — `start`, `_persist_progress`, `_park` — by the same derived
    # `notifications.test_context()` the record guard uses.
    from app.tools import fixtures
    suppress = ("a graded eval run's fixtures are active in this context"
                if fixtures.active() is not None else None)
    if suppress is None and row.get("test_run"):
        suppress = "the row is stamped as a test row — a suite run wrote it"
    if suppress:
        # A TEST'S RESULT IS NOT NEWS. Announcing it puts junk in the
        # operator's real conversation — 102 eval rows for suites 'fake' and
        # 'fake-durability' did exactly that, and deleting them without
        # closing the runs let the backlog sweep re-manufacture a fresh batch
        # at 12:15Z on 2026-08-08. The step is CLOSED with an honest account
        # rather than left open, because an open step is precisely what the
        # sweep exists to pick up.
        doc = {"how": f"suppressed — {suppress}; nothing was sent and "
                      f"nothing was written to the conversation",
               "suppressed": True,
               "outcome": (row.get("outcome") or {}).get("code")}
        await _record_announcement(run_id, doc)
        log.info("eval run %s: announcement suppressed (%s)", run_id, suppress)
        return doc
    if not await _claim_announce(run_id):
        # Someone else is announcing this run RIGHT NOW (or announced it
        # between the read above and here). Not an error and not a retry:
        # the news is being delivered, by them.
        log.info("eval: %s is already being announced elsewhere — not "
                 "sending a second time", run_id)
        return None

    title, body = announcement_text(row)
    result = await notify.send(
        body, title=title, tags=["eval"], kind="eval", source="eval",
        click=announce_link(run_id),
        # The run id IS the identity of this news — one run, one
        # announcement — so two callers racing collapse instead of buzzing
        # twice, and two DIFFERENT runs never suppress each other however
        # similar their text.
        dedupe_key=f"eval-run:{run_id}")
    doc = {
        "how": (result.get("delivery_label")
                or result.get("error")
                or ("published" if result.get("ok") else
                    "the send path reported neither an outcome nor a reason")),
        "confirmed": bool(result.get("confirmed")),
        "state": result.get("state"),
        "in_chat": result.get("in_chat"),
        "deduped": bool(result.get("deduped")),
        "provider": result.get("provider"),
        "notification_id": result.get("notification_id"),
        "outcome": (row.get("outcome") or {}).get("code"),
        "title": title,
    }
    for key in ("chat_error", "record_error"):
        if result.get(key):
            doc[key] = result[key]
    await _record_announcement(run_id, doc)
    log.info("eval run %s announced: %s", run_id, doc["how"])
    return doc


async def announce(run_id: str) -> Optional[dict]:
    """`_announce`, with the failure contained. Every hook uses this.

    An announcement that raises must never take down the verdict it is about
    — the run's own record is the more valuable of the two, and it is already
    written by the time this is called. Leaving `announced_at` NULL is not a
    swallow: it is precisely what the backlog sweep looks for, so the failure
    is retried rather than lost.
    """
    try:
        return await _announce(run_id)
    except Exception:  # noqa: BLE001
        log.exception("eval run %s: announcing its result failed — the row is "
                      "left unannounced for the sweep to retry", run_id)
        return None


# How many overdue announcements one sweep will make. A cap, because the
# sweep runs every 60s and a burst of pushes is the nag this repo's dedupe
# rules exist to prevent; the rest are picked up by the next pass.
ANNOUNCE_PER_SWEEP = 5


async def _announce_backlog(limit: int = ANNOUNCE_PER_SWEEP,
                            only_run: Optional[str] = None) -> int:
    """Announce results whose own process never got to.

    A run that finished while the transport was down, or whose backend was
    killed between the verdict and the notification, is exactly the case this
    lane is about — a real result nobody was told. The query is the partial
    index migration 127 adds: terminal, and never announced.

    It cannot flood, and that is the migration's doing rather than this
    function's: the backfill closed all 250 pre-existing rows with an
    account of themselves, so "never announced" means since 127 and not
    since the beginning of the table.

    A run under a live announce lease is skipped here (migration 128).
    `_claim_announce` would refuse it anyway — that is the gate — but a row
    another process is mid-send on would otherwise eat one of the five slots
    this pass has, every pass, and the overdue result behind it would wait.

    A row stamped `test` is skipped too. Those are rows a suite drove against
    the live database; on 2026-08-08 this sweep found a batch of them
    terminal-and-unannounced and re-manufactured junk announcements into the
    operator's conversation at 12:15Z. `_announce` refuses them as well — the
    skip here just stops them eating the five slots forever.

    `only_run` narrows the pass to a single id, for the reason and with the
    history `_claim_stale` documents: the suites drive this against the live
    database, and an unscoped pass reaches every real row — including
    closing a real, overdue result with whatever this process would say
    about it. Production passes nothing.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id FROM eval_runs "
            " WHERE announced_at IS NULL AND status <> 'running' "
            "   AND NOT COALESCE((detail->>'test')::boolean, false) "
            "   AND (announce_claimed_at IS NULL "
            f"        OR announce_claimed_at < now() - interval "
            f"           '{ANNOUNCE_LEASE_S} seconds') "
            "   AND ($2::uuid IS NULL OR id = $2::uuid) "
            " ORDER BY finished_at DESC NULLS LAST LIMIT $1",
            int(limit), only_run)
    done = 0
    for r in rows:
        if await announce(str(r["id"])):
            done += 1
    if done:
        log.warning("eval: announced %d overdue result(s)", done)
    return done


async def _execute(run_id: str, suite_name: str, model: str,
                   repeat: int = 1, *, resume_from: int = 0,
                   prior: Optional[dict] = None) -> None:
    """Run every task in a suite against one model and record the verdict.

    `repeat` runs each task N times. A task counts as passed only if it passed
    EVERY repeat, which is the honest reading when the thing being measured is
    stochastic: two runs of this suite scored 2/7 and 3/7 hours apart, and the
    task that flipped was one nothing had touched. Strictness is the point —
    "passed once out of three" is not a property you can route work on.

    RESUMABLE (migration 124). `resume_from` is the persisted cursor and
    `prior` is what the run had already earned, both read off the row by
    `_resume` rather than held in memory — the process that held it is the one
    that died. Progress is written after EVERY task, so the cursor a later
    resume reads is a fact about work that finished, not about work that
    started. A task is the unit because a task is what has a verdict; nothing
    inside one is idempotent enough to resume mid-way, so an interrupted task
    is re-run in full, which is the safe direction.
    """
    from app.evals import checks, runner as eval_runner, suites as suite_mod

    if run_id in _executing:
        # ONE RUN, ONE EXECUTION, per process. Callers are supposed to have
        # established this before getting here; this is the line that refuses
        # when one of them is wrong, and it is worth a line of its own because
        # the damage is not repairable by a later pass — two loops append to
        # the same `details` document and race the same terminal UPDATE, so
        # the row ends up describing neither of them.
        raise RuntimeError(
            f"eval run {run_id} is already executing in this process — "
            f"refusing to start it a second time")
    _executing.add(run_id)
    # Starts BEFORE any work, so a run that dies in its first seconds is
    # still distinguishable from one that never reported at all.
    beat = asyncio.create_task(_heartbeat(run_id))
    scratch = Path(tempfile.mkdtemp(prefix="nova-eval-"))
    prior = prior or {}
    total = graded = 0
    passed = int(prior.get("passed") or 0)
    tin = int(prior.get("tin") or 0)
    tout = int(prior.get("tout") or 0)
    prior_duration = float(prior.get("duration") or 0.0)
    details: list[dict] = list(prior.get("details") or [])
    all_classes: set[str] = set(prior.get("classes") or ())
    all_errors: list[str] = list(prior.get("errors") or ())
    failure: Optional[dict] = None
    status, error = "passed", None
    # Whether this call reached a VERDICT. False means the process is going
    # away mid-run, which is not one — see the CancelledError arm below.
    terminal = True
    started = asyncio.get_event_loop().time()

    def elapsed() -> float:
        """Time this run has spent EXECUTING, summed across interruptions.

        Carried forward from the row, because a resumed run that reported only
        its final segment would tell the cost estimator the suite is cheaper
        than it is. Deliberately not `finished_at - started_at`: measured live
        on run 28e4b1f8, 456s of wall clock of which 383s was the row sitting
        stalled waiting for recovery. What `estimate()` is asked is "what will
        this cost me", and the answer to that is 68s of work, not the length
        of somebody's editing session.
        """
        return prior_duration + (asyncio.get_event_loop().time() - started)

    try:
        suite = suite_mod.load_suite(suite_name)
        tasks = list(suite_mod.load_tasks(suite))
        total = len(tasks)
        # The denominator is written down BEFORE the first task, so a run
        # killed at task 3 of 7 reads as "3 of 7 done" rather than as a run
        # that measured three tasks. 175 rows in this table say tasks_total=0
        # after up to 46 minutes of work, which is the same fact stated the
        # useless way.
        await _persist_progress(run_id, index=resume_from, total=total,
                                passed=passed,
                                graded=sum(1 for e in details
                                           if e.get("gradeable")),
                                tin=tin, tout=tout, duration=elapsed(),
                                details=details)
        for index, task in enumerate(tasks):
            if index < resume_from:
                continue                  # already graded; its entry is in `details`
            runs_passed = 0
            failures: list[str] = []
            errors: list[str] = []
            classes: set[str] = set()
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
                # The CLASS of every LLM failure, off the spans — the one
                # machine-readable fact that separates "the window refused
                # this prompt" from "the model answered badly".
                classes.update(result.error_classes)
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
            if classes:
                entry["error_classes"] = sorted(classes)
            if repeat > 1:
                # The flaky middle ground is invisible in a pass/fail column,
                # and it is the most useful thing a repeated run learns.
                entry["runs_passed"] = runs_passed
                entry["runs"] = repeat
            details.append(entry)
            all_classes.update(classes)
            all_errors.extend(errors)
            # THE CURSOR, written after the task's side effects and its
            # verdict, never before. A crash between the two re-runs this
            # task — a wasted turn, which is recoverable — where advancing
            # first would skip it and score a suite the model was never
            # asked half of. Same rule action_worker._run_steps follows.
            await _persist_progress(
                run_id, index=index + 1, total=total, passed=passed,
                graded=sum(1 for e in details if e.get("gradeable")),
                tin=tin, tout=tout, duration=elapsed(), details=details)
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
            failure = {"type": "no_gradeable_tasks", "message": why[:500],
                       "error_classes": sorted(all_classes),
                       "resource_refusal": resource_refusal(all_classes,
                                                            all_errors)}
        else:
            status = "passed" if passed == total and total else "failed"
    except asyncio.CancelledError:
        # THE PROCESS IS GOING AWAY. Not a verdict, and it must not be written
        # as one — which is exactly what used to happen, and it is the worst
        # bug this lane found. `status` is initialised to "passed", nothing
        # reassigns it on the way out, and CancelledError is a BaseException
        # so the `except Exception` below never saw it: the `finally` wrote
        # status='passed' with whatever partial score the run had reached.
        # A shutdown cancelling a half-finished suite recorded a PASS.
        #
        # Now the row is left exactly as the cursor found it — still
        # 'running', with every task graded so far persisted — and boot
        # recovery resumes it. Re-raised so the loop still sees the cancel.
        terminal = False
        log.warning("eval run %s cancelled at task %d/%d — left for recovery",
                    run_id, len(details), total)
        raise
    except Exception as exc:  # noqa: BLE001 — a harness failure is not a verdict
        if db.pool is None:
            # THE SHUTDOWN GOT HERE FIRST. `db.close_pool()` runs in the same
            # lifespan teardown that is about to kill this task, and every
            # query after it raises RuntimeError("Pool not initialized") — so
            # the exception is not about the harness or the model, it is the
            # process leaving. MEASURED LIVE 2026-08-07 22:22 on run
            # 28e4b1f8: an edit to eval_runs.py reloaded the backend, the
            # cursor write raised, and the run was one open pool away from
            # being recorded as `error: RuntimeError: Pool not initialized` —
            # "the backend restarted" wearing "the harness failed", which is
            # the exact confusion this lane exists to remove.
            #
            # DERIVED, not string-matched: the question "is the pool gone" is
            # answered by looking at the pool. A message pattern would rot the
            # first time asyncpg reworded itself.
            terminal = False
            log.warning("eval run %s: the pool closed under it at task %d/%d "
                        "— the process is going away, left for recovery",
                        run_id, len(details), total)
            raise
        log.exception("eval run %s failed", run_id)
        status, error = "error", f"{type(exc).__name__}: {exc}"[:500]
        # The row used to say 'error' and nothing else, so a night that died
        # was indistinguishable from a model that is bad, and everything
        # downstream debugged blind. The exception type and message ARE the
        # reason; whether it was the machine refusing is derived from the
        # same evidence, never asserted.
        failure = {"type": type(exc).__name__, "message": str(exc)[:500],
                   "error_classes": sorted(all_classes),
                   "resource_refusal": resource_refusal(
                       all_classes, all_errors + [str(exc)])}
    finally:
        beat.cancel()
        shutil.rmtree(scratch, ignore_errors=True)
        _executing.discard(run_id)
        # Compare-and-clear: this run frees the slot only if the slot is
        # still ITS reservation. A bare `_running = None` here would let a
        # finishing run open the gate on somebody else's.
        _release_slot(run_id)
    if not terminal:
        return
    detail_payload: dict = {"tasks": details}
    if failure:
        detail_payload["failure"] = failure
    try:
        async with db.acquire() as conn:
            # `detail || $8` rather than `detail = $8`: the last heartbeat is
            # the one timestamp that bounds a death and there is no reason to
            # erase it on the way past. task_index lands on the cursor rather
            # than on `total`, because a run that ended early ended EARLY and
            # a reader deserves to see where.
            await conn.execute(
                "UPDATE eval_runs SET status=$2, finished_at=now(), "
                "tasks_total=$3, tasks_passed=$4, tokens_in=$5, tokens_out=$6, "
                "duration_s=$7, detail = detail || $8::jsonb, error=$9, "
                "tasks_gradeable=$10, task_index=$11 WHERE id=$1::uuid",
                run_id, status, total, passed, tin, tout,
                round(elapsed(), 1),
                json.dumps(detail_payload), error, graded, len(details))
    except Exception:
        # THE VERDICT DID NOT LAND. Loud, and the row stays 'running' with its
        # cursor rather than silently vanishing — recovery will finish it. A
        # write that fails quietly here is the "fallback that reads as
        # success" in its purest form: the work happened and nothing says so.
        log.exception("eval run %s: could not record its verdict (%s %d/%d) — "
                      "the row is left for recovery", run_id, status, passed,
                      total)
        raise
    log.info("eval run %s: %s (%d/%d)", run_id, status, passed, total)
    # AND THE OPERATOR IS TOLD. Strictly after the verdict landed and only on
    # the path where it did — announcing a result whose write raised would be
    # a notification about a row that says something else. `announce` reads
    # the row back rather than trusting these locals, for the same reason.
    await announce(run_id)


MAX_REPEAT = 10


async def start(suite_name: str, model: str, repeat: int = 1) -> dict:
    """Begin a run. Returns immediately with the row id.

    THE ONE-AT-A-TIME LIMIT IS ENFORCED HERE, and it has to be: migration
    124's system_prompt tells model-manager "only one eval runs at a time; a
    second start is refused with the id of the one holding the slot", and a
    sentence in a prompt is a request, not a control. It used to be one —
    `if _running:` and `_running = run_id` with a `db.acquire()` and a
    `fetchrow` between them, which is two await points where the nightly
    tournament's next model and an operator press (or an agent's `run_eval`
    turn) both read None and both went. The row id is now minted here so the
    slot can be reserved BEFORE anything is awaited, and the reservation is
    released if the insert or the task spawn fails, so a refused start never
    leaves an orphan 'running' row for recovery to chew on.
    """
    from app.evals import suites as suite_mod
    from app.llm import router as llm_router

    if _running:
        # A cheap, well-worded refusal before the validation work. NOT the
        # gate — `_reserve_slot` below is.
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
    # Minted here rather than by the database default, so the slot can be
    # taken before the first await. `gen_random_uuid()` is still the column
    # default for every other writer.
    run_id = str(uuid.uuid4())
    if not await _reserve_slot(run_id):
        raise ValueError(f"an eval is already running ({_running})")
    try:
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO eval_runs (id, suite, agent_name, model, "
                "                       suite_version, repeat_count, detail) "
                "VALUES ($1::uuid,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id",
                run_id, suite_name, suite.agent, model, suite.version, repeat,
                # Stamped from birth when a suite is the caller, so even a
                # run killed before its first progress write cannot be
                # announced as real news later — see `_persist_progress`.
                json.dumps({"test": True})
                if notifications.test_context() is not None else "{}")
        if not row:
            # The insert is the only thing that makes this run recoverable.
            # Reporting a run id for a row that does not exist would be the
            # purest form of the fallback that reads as success.
            raise RuntimeError("the eval_runs insert returned no id — the run "
                               "was NOT recorded and has not started")
        asyncio.create_task(_execute(run_id, suite_name, model, repeat))
    except BaseException:
        # Nothing is executing, so nothing will free the slot. Holding it
        # after a failed start would wedge every later run, including the
        # tournament's, until the process restarted.
        _release_slot(run_id)
        raise
    return {"id": run_id, "suite": suite_name, "agent": suite.agent,
            "model": model, "suite_version": suite.version,
            "repeat": repeat, "status": "running"}


# ── champion vs challenger — the durable half ────────────────────────────

async def record_comparison(*, suite: str, suite_version: int,
                            repeat_count: int, champion: str, challenger: str,
                            tasks_total: int, tasks_gradeable: int,
                            tasks_invalid: int, champion_passed: int,
                            challenger_passed: int, regressions: list[str],
                            improvements: list[str], detail: dict) -> str:
    """Persist one pairwise verdict. Returns the row id, or RAISES.

    The CLI printed a scoreboard and persisted nothing, so a verdict lived in
    a terminal and died there. This is the row it becomes. It VERIFIES its
    own insert (RETURNING id) and fails loudly when it cannot — a comparison
    that claims to be recorded and is not would be read later as "never run",
    which quietly re-spends a night of GPU time.
    """
    try:
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "INSERT INTO eval_comparisons "
                "  (suite, suite_version, repeat_count, champion, challenger, "
                "   tasks_total, tasks_gradeable, tasks_invalid, "
                "   champion_passed, challenger_passed, regressions, "
                "   improvements, detail) "
                "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,"
                "        $11::jsonb,$12::jsonb,$13::jsonb) RETURNING id",
                suite, suite_version, repeat_count, champion, challenger,
                tasks_total, tasks_gradeable, tasks_invalid,
                champion_passed, challenger_passed,
                json.dumps(regressions), json.dumps(improvements),
                json.dumps(detail))
    except Exception as exc:
        text = str(exc)
        if "eval_comparisons" in text and "does not exist" in text:
            raise RuntimeError(
                "the eval_comparisons table does not exist — migration 120 "
                "has not been applied to this database. Migrations run at "
                "backend startup; apply it, then re-run. The comparison was "
                "NOT recorded.") from exc
        raise
    if not row or not row["id"]:
        raise RuntimeError("the eval_comparisons insert returned no id — "
                           "the verdict was NOT recorded")
    return str(row["id"])


async def comparisons(suite: Optional[str] = None,
                      limit: int = 20) -> list[dict]:
    """Recorded pairwise verdicts, newest first, with staleness on the row.

    `current_suite_version` is read from the suite file at answer time — the
    one truth about what the suite is NOW — so a verdict recorded before the
    suite moved can say it describes a different set of tasks instead of
    wearing a bare score.
    """
    from app.evals import suites as suite_mod
    sql = ("SELECT id, at, suite, suite_version, repeat_count, champion, "
           "       challenger, tasks_total, tasks_gradeable, tasks_invalid, "
           "       champion_passed, challenger_passed, regressions, "
           "       improvements "
           "  FROM eval_comparisons")
    args: list = []
    if suite:
        sql += " WHERE suite = $1"
        args.append(suite)
    sql += " ORDER BY at DESC LIMIT " + str(int(limit))
    try:
        async with db.acquire() as conn:
            rows = [dict(r) for r in await conn.fetch(sql, *args)]
    except Exception as exc:
        text = str(exc)
        if "eval_comparisons" in text and "does not exist" in text:
            # NOT an empty list: "no comparisons recorded" and "the table is
            # missing" must never read the same — that is the fallback that
            # reads as success.
            raise RuntimeError(
                "the eval_comparisons table does not exist — migration 120 "
                "has not been applied to this database yet (migrations run "
                "at backend startup)") from exc
        raise
    versions: dict[str, Optional[int]] = {}
    for r in rows:
        for key in ("regressions", "improvements"):
            if isinstance(r.get(key), str):
                try:
                    r[key] = json.loads(r[key])
                except ValueError:
                    r[key] = []
        name = r["suite"]
        if name not in versions:
            try:
                versions[name] = suite_mod.load_suite(name).version
            except Exception:  # noqa: BLE001 — a deleted suite is not a crash
                versions[name] = None
        r["current_suite_version"] = versions[name]
    return rows
