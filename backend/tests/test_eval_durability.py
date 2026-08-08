"""An eval run survives the backend restarting.

    docker compose exec backend python tests/test_eval_durability.py

THE INCIDENT (2026-08-07). Jeremy: "I couldn't run a model eval loop on a
model." Measured over the whole table the same evening — 250 rows, every eval
ever recorded on this box:

    177 error, 73 failed, 0 passed
    175 of the 177 errors died to the PROCESS, not the model
        (170 'stopped reporting and was declared dead', 5 'interrupted by a
        backend restart'); only 2 were real
    175 of them carried tasks_total = 0 — after 105s to 46 minutes of work,
        nothing whatsoever was kept

A run executed wholly in memory inside a backend running under --reload,
where any .py edit is a restart, and wrote nothing until its final `finally`.
So 70% of eval history is the harness being killed, recorded in a shape that
reads — to a model picker, and to the self-improvement loop's eval floor —
exactly like a model that could not be graded.

What this pins, layer by layer:

  1. THE CURSOR — progress is written after every task, so an interruption
     keeps what was measured.
  2. THE RESUME — a restart carries on from the cursor and does NOT re-run
     the tasks already graded.
  3. CANCELLATION IS NOT A VERDICT — the worst bug this lane found: `status`
     is initialised to "passed", CancelledError is a BaseException so the
     `except Exception` never saw it, and the `finally` wrote a PASS for a
     suite that was killed half way through.
  4. DEATH IS STILL CERTIFIED, but only at the ceiling, and it says how many
     attempts it took.
  5. THE CLAIM — one owner, enforced by the row lock and not by a column.
  6. IT REFUSES TO RESUME A DIFFERENT MEASUREMENT — a suite whose version
     moved, a model whose provider went away.
  7. "THE HARNESS DIED" NEVER READS AS "THE MODEL FAILED".
  8. THE GRANT — model-manager actually holds run_eval and eval_results. A
     tool is not a capability until an agent holds it.
  9. THE SLOT IS A GATE, and it is asked BEFORE the row is charged. Three
     defects found 2026-08-07 reviewing this lane, all in the same handful of
     lines and all measured live:
       * a claim bumps `resumes`, and the in-process slot was checked AFTER
         it, so a recoverable run burned all three lives without one task
         being attempted and was then certified dead saying it had been
         resumed three times;
       * `_resume` read `_running == run_id` as PERMISSION, so a live run
         whose heartbeat merely lapsed got a second `_execute` on top of
         itself — tasks 2 and 3 each ran twice, two coroutines racing one
         detail->tasks document;
       * `start` tested `_running` and set it two awaits later and `_lock`
         was never acquired at all, so two concurrent starts both succeeded
         — while migration 124's system_prompt tells the agent the slot is
         the limit.
"""

import asyncio
import json
import sys
import uuid

sys.path.insert(0, "/app/backend")

from app import db, eval_runs                                   # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


# ── the fake suite: four tasks, graded without touching a model ────────────

class Task:
    def __init__(self, i):
        self.ref = f"fake/task-{i}"
        self.id = f"task-{i}"
        self.contract = {}


class Suite:
    agent = "model-manager"
    version = 1
    task_ids = ["task-0", "task-1", "task-2", "task-3"]


class Result:
    usage = {"prompt_tokens": 10, "completion_tokens": 5}
    duration_s = 0.1
    gradeable = True
    errors: list[str] = []
    error_classes: tuple = ()


class Report:
    passed = True
    failures: list[str] = []


TASKS = [Task(i) for i in range(4)]
RAN: list[str] = []


def install_fakes(on_task=None):
    """Patch the harness so a 'run' is four cheap in-process steps."""
    from app.evals import checks, runner as eval_runner, suites as suite_mod

    async def run_task(task, model, **kw):
        RAN.append(task.ref)
        if on_task:
            await on_task(task)
        return Result()

    suite_mod.load_suite = lambda name: Suite()
    suite_mod.load_tasks = lambda suite: list(TASKS)
    eval_runner.run_task = run_task
    checks.evaluate = lambda contract, result: Report()


def self_resolving_model() -> str:
    """A model id that resolves to ITSELF, derived from the live router.

    Hardcoding one would make this test a hostage to whatever is installed;
    worse, the first thing `_resume` checks is that the model still resolves
    to itself, so a made-up id is refused before a single task runs — which
    is the check working and looks exactly like the resume being broken.
    The router's own fallback is self-resolving by construction.
    """
    from app.llm import router as llm_router
    return llm_router.effective_model("nosuchprovider:nosuchmodel")


async def new_run(**cols) -> str:
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO eval_runs (suite, agent_name, model, suite_version, "
            "  repeat_count, status) VALUES ($1,$2,$3,$4,$5,'running') "
            "RETURNING id",
            cols.get("suite", "fake-durability"), "model-manager",
            cols.get("model", self_resolving_model()),
            cols.get("suite_version", 1), 1)
    return str(row["id"])


async def row_of(run_id) -> dict:
    async with db.acquire() as conn:
        r = await conn.fetchrow("SELECT * FROM eval_runs WHERE id=$1::uuid",
                                run_id)
    out = dict(r)
    d = out["detail"]
    out["detail"] = json.loads(d) if isinstance(d, str) else (d or {})
    return out


async def cleanup(ids):
    async with db.acquire() as conn:
        await conn.execute("DELETE FROM eval_runs WHERE id = ANY($1::uuid[])",
                           [uuid.UUID(i) for i in ids])


# ── the body ──────────────────────────────────────────────────────────────

async def main() -> int:
    await db.init_pool()
    made: list[str] = []
    try:
        # ---- 1 + 3: a cancelled run keeps its cursor and is NOT a verdict --
        print("1. the cursor is written after every task")
        gate = asyncio.Event()
        install_fakes()

        async def stall(task):
            if task.ref == "fake/task-2":
                gate.set()
                await asyncio.sleep(30)      # the process 'goes away' here

        install_fakes(on_task=stall)
        run_id = await new_run()
        made.append(run_id)
        RAN.clear()
        eval_runs._running = run_id
        job = asyncio.create_task(
            eval_runs._execute(run_id, "fake", self_resolving_model()))
        await asyncio.wait_for(gate.wait(), 10)
        await asyncio.sleep(0.2)             # let the cursor write land
        mid = await row_of(run_id)
        check("two finished tasks are already persisted",
              mid["task_index"] == 2, f"task_index={mid['task_index']}")
        check("...with their per-task receipts",
              len(mid["detail"].get("tasks") or []) == 2,
              str(len(mid["detail"].get("tasks") or [])))
        check("...and the denominator, so it reads as 2 of 4 rather than "
              "as a run that measured 2", mid["tasks_total"] == 4,
              f"tasks_total={mid['tasks_total']}")
        check("...and the tokens spent so far are not lost",
              mid["tokens_in"] == 20 and mid["tokens_out"] == 10,
              f"{mid['tokens_in']}/{mid['tokens_out']}")

        print("3. a cancelled run is NOT recorded as a verdict")
        job.cancel()
        try:
            await job
        except asyncio.CancelledError:
            pass
        killed = await row_of(run_id)
        check("it did NOT write status='passed' for a suite it never finished",
              killed["status"] != "passed", killed["status"])
        check("the row is left 'running' at its cursor for recovery",
              killed["status"] == "running" and killed["task_index"] == 2,
              f"{killed['status']} @{killed['task_index']}")
        check("finished_at was not stamped on a run that has not finished",
              killed["finished_at"] is None, str(killed["finished_at"]))
        check("the in-process slot was released",
              eval_runs.busy() is None, str(eval_runs.busy()))

        # ---- 2: the resume ------------------------------------------------
        print("2. a restart resumes at the cursor")
        install_fakes()                      # no stall this time
        RAN.clear()
        # Backdate the heartbeat so the row is stale, exactly as a restart
        # would leave it — and stamp a known cost on the first segment. The
        # fakes run instantly, so without a planted figure the "time carried
        # forward" assertion below would compare 0.0 against 0.0 and pass
        # whatever the code did.
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE eval_runs SET duration_s = 123.4, "
                "  detail = jsonb_set(detail,'{heartbeat}',"
                " to_jsonb(now() - interval '10 minutes')) WHERE id=$1::uuid",
                run_id)
        # SCOPED TO THIS TEST'S OWN ROW. A bare claim reaches the whole live
        # pool, and on 2026-08-07 it did: this file ran while a genuine
        # skill-manager run was seconds old, took it, compared its recorded
        # v3 against the four-task fake suite installed above, and parked a
        # healthy live measurement as `suite_changed`. The narrowing lives in
        # eval_runs._claim_stale, so it is a line of code that refuses rather
        # than a rule the next author of this file has to remember.
        claimed = await eval_runs._claim_stale("test-instance", run_id)
        check("the stale run was claimed", claimed is not None
              and str(claimed["id"]) == run_id,
              str(claimed and claimed["id"]))
        check("...and the claim bumped resumes, which is what makes the "
              "ceiling terminate", claimed and claimed["resumes"] == 1,
              str(claimed and claimed["resumes"]))
        check("...and named its owner",
              claimed and claimed["claimed_by"] == "test-instance")
        await eval_runs._resume(dict(claimed))
        done = await row_of(run_id)
        check("the run finished", done["status"] in ("passed", "failed"),
              done["status"])
        check("it re-ran ONLY the tasks after the cursor",
              RAN == ["fake/task-2", "fake/task-3"], str(RAN))
        check("all four tasks are scored, not two",
              done["tasks_passed"] == 4 and done["tasks_total"] == 4,
              f"{done['tasks_passed']}/{done['tasks_total']}")
        check("...and the tokens from BEFORE the interruption are still in "
              "the total", done["tokens_in"] == 40,
              f"tokens_in={done['tokens_in']}")
        check("...and the time already spent is carried, not restarted — a "
              "resumed run that reported only its last segment would tell the "
              "cost estimator the suite is cheaper than it is",
              float(done["duration_s"] or 0) >= 123.4,
              f"planted 123.4 -> {done['duration_s']}")
        check("the finished row remembers it was interrupted",
              done["resumes"] == 1, f"resumes={done['resumes']}")

        # ---- 5: the claim is exclusive ------------------------------------
        print("5. the claim is a row lock, not a column")
        src = open("/app/backend/app/eval_runs.py").read()
        claim = src.split("async def _claim_stale")[1].split("async def")[0]
        check("FOR UPDATE SKIP LOCKED — two backends cannot claim one run",
              "FOR UPDATE SKIP LOCKED" in claim)
        check("...and it only ever takes ONE", "LIMIT 1" in claim)
        check("a second claim finds nothing once the row is terminal",
              await eval_runs._claim_stale("other", run_id) is None)
        check("...and a claim can be scoped to one id — the guard that stops "
              "this suite parking somebody's live run",
              "$2::uuid IS NULL OR id = $2::uuid" in claim)

        # ---- 4: death is certified only at the ceiling ---------------------
        print("4. death is certified only at the resume ceiling")
        young = await new_run()
        old = await new_run()
        made += [young, old]
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE eval_runs SET resumes=$2, task_index=1, "
                "  detail = jsonb_set(detail,'{heartbeat}', "
                "    to_jsonb(now() - interval '10 minutes')) "
                " WHERE id=$1::uuid", young, eval_runs.MAX_RESUMES - 1)
            await conn.execute(
                "UPDATE eval_runs SET resumes=$2, task_index=3, "
                "  detail = jsonb_set(detail,'{heartbeat}', "
                "    to_jsonb(now() - interval '10 minutes')) "
                " WHERE id=$1::uuid", old, eval_runs.MAX_RESUMES)
        closed = await eval_runs._certify_dead()
        y, o = await row_of(young), await row_of(old)
        check("a run under the ceiling is left alone — it is interrupted, "
              "not dead", y["status"] == "running", y["status"])
        check("a run at the ceiling is closed out", o["status"] == "error",
              o["status"])
        check("...and reported", closed >= 1, str(closed))
        fail = o["detail"].get("failure") or {}
        check("...as 'error', never 'failed' — the harness died, the model "
              "did not", o["status"] != "failed")
        check("...saying how many resumes it took",
              fail.get("resumes") == eval_runs.MAX_RESUMES, json.dumps(fail)[:160])
        check("...and where it kept dying",
              fail.get("resumed_from_task") == 3, str(fail.get("resumed_from_task")))
        check("...and that this is the harness, not a verdict",
              "not a verdict on the model" in (fail.get("message") or ""),
              (fail.get("message") or "")[:120])

        # ---- 6: it refuses to resume a different measurement ---------------
        print("6. it refuses to resume something that is no longer the same "
              "measurement")
        moved = await new_run(suite_version=99)
        made.append(moved)
        install_fakes()
        RAN.clear()
        await eval_runs._resume(await row_of(moved))
        m = await row_of(moved)
        check("a suite whose version moved is stopped, not mixed",
              m["status"] == "error", m["status"])
        check("...with a named type",
              (m["detail"].get("failure") or {}).get("type") == "suite_changed",
              json.dumps(m["detail"].get("failure"))[:140])
        check("...and no task was run against it", RAN == [], str(RAN))

        gone = await new_run(model="nosuchprovider:nosuchmodel")
        made.append(gone)
        RAN.clear()
        await eval_runs._resume(await row_of(gone))
        g = await row_of(gone)
        check("a model whose provider is gone is not silently graded as its "
              "fallback", g["status"] == "error"
              and (g["detail"].get("failure") or {}).get("type")
              == "model_unresolvable",
              json.dumps(g["detail"].get("failure"))[:140])
        check("...and no task was run against it either", RAN == [], str(RAN))

        # ---- 7: legibility -------------------------------------------------
        print("7. 'the harness died' never reads as 'the model failed'")
        for label, rid in (("declared_dead", old), ("suite_changed", moved),
                           ("model_unresolvable", gone)):
            r = await row_of(rid)
            f = r["detail"].get("failure") or {}
            check(f"{label}: status is 'error', not 'failed'",
                  r["status"] == "error", r["status"])
            check(f"{label}: carries resource_refusal, derived not asserted",
                  f.get("resource_refusal") is False, json.dumps(f)[:100])
            check(f"{label}: names itself", f.get("type") == label,
                  str(f.get("type")))
        prog = await eval_runs.progress(old)
        check("progress() calls a stalled run stalled using the SAME window "
              "the reaper uses", prog is not None and not prog["stalled"]
              and prog["status"] == "error", str(prog and prog["note"])[:100])

        stuck = await new_run()
        made.append(stuck)
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE eval_runs SET task_index=2, tasks_total=4, "
                "  detail = jsonb_set(detail,'{heartbeat}', "
                "    to_jsonb(now() - interval '10 minutes')) "
                " WHERE id=$1::uuid", stuck)
        p = await eval_runs.progress(stuck)
        check("a stuck run is visible AS stuck", p["stalled"] is True,
              p["note"][:80])
        check("...and says where it stopped",
              "task 2 of 4" in p["note"], p["note"][:100])
        fresh = await eval_runs.progress(run_id)
        check("a finished run is not called stalled",
              fresh["stalled"] is False and fresh["stalled_for_s"] is None,
              fresh["note"][:80])

        # ---- 8: the grant --------------------------------------------------
        print("8. a tool is not a capability until an agent holds it")
        from app.tools.builtin import BUILTIN_TOOLS
        check("run_eval exists", "run_eval" in BUILTIN_TOOLS)
        check("eval_results exists", "eval_results" in BUILTIN_TOOLS)
        check("run_eval is NOT declared reads_only — it inserts a row and "
              "spends tokens and GPU",
              not BUILTIN_TOOLS["run_eval"].get("reads_only"))
        check("eval_results IS reads_only",
              BUILTIN_TOOLS["eval_results"].get("reads_only") is True)
        async with db.acquire() as conn:
            granted = await conn.fetchval(
                "SELECT allowed_tools FROM agents WHERE name='model-manager'")
        check("model-manager HOLDS run_eval", "run_eval" in (granted or []),
              str(granted))
        check("model-manager HOLDS eval_results",
              "eval_results" in (granted or []))
        snap = json.load(open("/app/backend/app/evals/tasks/granted.json"))
        check("the eval snapshot knows about both",
              {"run_eval", "eval_results"} <= set(snap.get("model-manager", [])),
              str(snap.get("model-manager")))
        suite_json = json.load(
            open("/app/backend/app/evals/tasks/model-manager/suite.json"))
        check("run_eval is EXCLUDED from the suite — a suite that can start a "
              "suite is a recursion nobody wants to debug",
              "run_eval" in suite_json["run"]["exclude_tools"])
        check("eval_results is answerable in replay, so a stray call costs a "
              "graded tool_error instead of invalidating the run",
              "eval_results" in suite_json["run"]["replay_only_tools"])

        # ---- 9: the slot is a gate, and it is asked before the row is charged
        print("9. the one-at-a-time slot is mechanical")
        install_fakes()
        RAN.clear()
        check("no run holds the slot going in", eval_runs.busy() is None,
              str(eval_runs.busy()))

        # 9a. TWO CONCURRENT STARTS. `start` used to test `_running` and set
        # it two awaits later, so both callers read None and both went —
        # measured, two ids, BOTH started: True. The tournament's next model
        # plus an operator press is the real pairing.
        async with db.acquire() as conn:
            before = await conn.fetchval("SELECT now()")
        results = await asyncio.gather(
            eval_runs.start("fake", self_resolving_model(), 1),
            eval_runs.start("fake", self_resolving_model(), 1),
            return_exceptions=True)
        started = [r for r in results if isinstance(r, dict)]
        refused = [r for r in results if isinstance(r, Exception)]
        made += [r["id"] for r in started]
        check("exactly one of two concurrent starts is admitted",
              len(started) == 1, str([type(r).__name__ for r in results]))
        check("...and the other is REFUSED, naming the holder",
              len(refused) == 1 and "already running" in str(refused[0]),
              str(refused[:1]))
        async with db.acquire() as conn:
            inserted = await conn.fetchval(
                "SELECT count(*) FROM eval_runs WHERE suite='fake' "
                "  AND started_at >= $1", before)
        check("...and a refused start leaves NO orphan 'running' row for "
              "recovery to chew on", inserted == 1, f"{inserted} row(s)")
        for _ in range(200):                 # the fakes finish in ms
            if eval_runs.busy() is None:
                break
            await asyncio.sleep(0.05)
        check("the admitted run finished and freed the slot",
              eval_runs.busy() is None, str(eval_runs.busy()))
        if started:
            fin = await row_of(started[0]["id"])
            check("...having actually run the suite",
                  fin["status"] in ("passed", "failed")
                  and fin["tasks_total"] == 4,
                  f"{fin['status']} {fin['tasks_passed']}/{fin['tasks_total']}")

        # 9b. A CLAIM SPENDS A LIFE, so the slot is taken BEFORE the row is.
        # The old order claimed first and asked the slot second, inside
        # `_resume`: while another eval held the slot, every 60s sweep bumped
        # `resumes` on a perfectly recoverable run and ran nothing, and at 3
        # `_certify_dead` reaped it with a record saying it had been resumed
        # three times. Measured: resumes 1/2/3, tasks actually run [].
        from app import instances
        real_leader = instances.is_leader
        instances.is_leader = lambda: True
        busy_run = await new_run()
        made.append(busy_run)
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE eval_runs SET task_index=2, tasks_total=4, "
                "  detail = jsonb_set(detail,'{heartbeat}', "
                "    to_jsonb(now() - interval '10 minutes')) "
                " WHERE id=$1::uuid", busy_run)
        try:
            RAN.clear()
            eval_runs._running = "somebody-elses-run"
            swept = await eval_runs._sweep(only_run=busy_run)
            held = await row_of(busy_run)
            check("a sweep with the slot held resumes nothing",
                  swept["resumed"] == 0, json.dumps(swept, default=str))
            check("...and SAYS the slot was why",
                  swept.get("slot_held_by") == "somebody-elses-run",
                  str(swept.get("slot_held_by")))
            check("...and did not claim the row — a life it could not spend "
                  "is a life it must not charge",
                  held["resumes"] == 0, f"resumes={held['resumes']}")
            check("...leaving it 'running' at its cursor for the next pass",
                  held["status"] == "running" and held["task_index"] == 2,
                  f"{held['status']} @{held['task_index']}")
            check("...and no task was run", RAN == [], str(RAN))

            # ...and the same sweep, once the slot is free, DOES recover it.
            # Without this the check above would pass for a sweep that was
            # simply broken.
            eval_runs._running = None
            swept2 = await eval_runs._sweep(only_run=busy_run)
            done2 = await row_of(busy_run)
            check("the identical sweep with a free slot resumes it",
                  swept2["resumed"] == 1, json.dumps(swept2, default=str))
            check("...charging exactly one resume", done2["resumes"] == 1,
                  f"resumes={done2['resumes']}")
            check("...and running only the tasks after the cursor",
                  RAN == ["fake/task-2", "fake/task-3"], str(RAN))
            check("...and releasing the slot on the way out",
                  eval_runs.busy() is None, str(eval_runs.busy()))
        finally:
            instances.is_leader = real_leader
            eval_runs._running = None

        # 9c. A LAPSED HEARTBEAT IS NOT A CORPSE. `_resume` used to read
        # `_running == run_id` as permission and start a SECOND `_execute` on
        # a run this process was still executing — measured, tasks 2 and 3
        # each ran twice with two coroutines racing one detail->tasks
        # document. The refusal is `_executing`, which is a different fact
        # from the slot precisely because the slot is reserved before the id
        # is known.
        live = await new_run()
        made.append(live)
        RAN.clear()
        eval_runs._executing.add(live)
        try:
            resumed = await eval_runs._resume(await row_of(live))
            still = await row_of(live)
            check("a run this process is already executing is NOT resumed",
                  resumed is False, str(resumed))
            check("...and no task was run against it a second time",
                  RAN == [], str(RAN))
            check("...and it was not parked either — it is alive, not dead",
                  still["status"] == "running", still["status"])
            try:
                await eval_runs._execute(live, "fake", self_resolving_model())
                doubled = True
            except RuntimeError as exc:
                doubled = "already executing" in str(exc)
            check("...and _execute itself refuses, so no caller can route "
                  "around it", doubled is True, str(doubled))
        finally:
            eval_runs._executing.discard(live)
            eval_runs._running = None
        check("_lock is actually acquired now, not just declared",
              "async with _lock" in open("/app/backend/app/eval_runs.py").read())
    finally:
        await cleanup(made)
        await db.close_pool()

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
