"""Measurement must be LEGIBLE: an error night says why it died, a voided
board says it was voided, and a pairwise verdict outlives the terminal.

    docker compose exec backend python tests/test_eval_legibility.py

Three defects, all the same shape — a result that reads as one thing while
being another:

* eval_runs rows landed status='error' with detail={} (or a bare heartbeat)
  and tasks_gradeable NULL, so a VRAM-starved night was indistinguishable
  from a model that is bad. gemma4:12b wore that ambiguity for weeks.
* bumping a suite's version voids every recorded run of it — correctly —
  but the standings board it left looked exactly like one where nothing had
  ever been measured. An empty board that cannot say WHY it is empty is the
  "fallback that reads as success" failure.
* `python -m app.evals run` printed a champion-vs-challenger scoreboard and
  persisted nothing, so no downstream card could ever be raised from it.
"""

import asyncio
import datetime as dt
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

from app import eval_runs, model_tournament                    # noqa: E402
from app.evals import runner as eval_runner_mod                # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class Conn:
    """Records every statement and its args; answers from a script."""

    def __init__(self, fetch_rows=None, fetchrow_result=None,
                 fetchrow_fn=None):
        self.fetch_rows = fetch_rows or []
        self.fetchrow_result = fetchrow_result
        self.fetchrow_fn = fetchrow_fn
        self.executed: list[tuple[str, tuple]] = []

    async def fetch(self, sql, *args):
        self.executed.append((" ".join(sql.split()), args))
        return self.fetch_rows

    async def fetchrow(self, sql, *args):
        self.executed.append((" ".join(sql.split()), args))
        if self.fetchrow_fn:
            return self.fetchrow_fn(sql, *args)
        return self.fetchrow_result

    async def execute(self, sql, *args):
        self.executed.append((" ".join(sql.split()), args))
        return "UPDATE 1"

    async def fetchval(self, sql, *args):
        self.executed.append((" ".join(sql.split()), args))
        return None


class Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return False


def with_conn(conn):
    from app import db
    real = db.acquire
    db.acquire = lambda: Acquire(conn)
    return lambda: setattr(db, "acquire", real)


# ── 1. the resource-refusal classifier ───────────────────────────────────

def test_classifier():
    print("\n[1] a resource refusal is derived, never asserted")
    check("prompt_too_long — the router's own VRAM-window refusal class — "
          "is a resource refusal",
          eval_runs.resource_refusal(["prompt_too_long"], []))
    check("ollama's cannot-load shapes are recognised by signature",
          eval_runs.resource_refusal(
              [], ["model requires more system memory (21.2 GiB) than is "
                   "available (14.9 GiB)"]))
    check("a 404 for a never-pulled model is NOT a resource refusal",
          not eval_runs.resource_refusal(
              ["http_status"], ["404: model 'x' not found"]))
    check("no evidence means no claim",
          not eval_runs.resource_refusal([], []))


# ── 2. the class survives into the result ────────────────────────────────

def test_error_classes_from_spans():
    print("\n[2] error classes are read off the SPANS (the trace is the fact)")
    r = eval_runner_mod.RunResult(
        label="candidate", task="t", suite="s", suite_version=1,
        agent="a", model="ollama:x", effective_model="ollama:x")
    r.spans = [
        {"kind": "llm_call", "name": "llm", "status": "error",
         "detail": {"error_class": "prompt_too_long"}},
        {"kind": "tool", "name": "y", "status": "ok", "detail": {}},
        {"kind": "llm_call", "name": "llm", "status": "error",
         "detail": {"error_class": "prompt_too_long"}},
    ]
    check("run_agent drops error_class from its yielded event, so the span "
          "detail is where it must come from",
          r.error_classes == ["prompt_too_long"], str(r.error_classes))
    r.spans = []
    check("no spans, no classes", r.error_classes == [])


# ── 3. a reaped orphan records a structured reason ───────────────────────

def test_orphan_failure_stamp():
    print("\n[3] a run declared dead says so in detail->failure")
    conn = Conn()
    restore = with_conn(conn)
    try:
        asyncio.run(eval_runs.reconcile_orphans())
    finally:
        restore()
    sql = conn.executed[0][0] if conn.executed else ""
    check("the reap writes detail->failure",
          "'{failure}'" in sql and "jsonb_set" in sql, sql[:120])
    check("...typed declared_dead — the process died, which is not a model "
          "verdict", "declared_dead" in sql)
    check("...carrying the last heartbeat, the one timestamp bounding the "
          "death", "last_heartbeat" in sql)
    check("...and never a resource refusal: nothing was observed",
          "'resource_refusal', false" in sql)
    check("...still claiming only what was OBSERVED — silence, not a cause",
          "restart" not in sql.lower())


# ── 4. an error run's row carries the reason ─────────────────────────────

class _FakeReport:
    def __init__(self, passed):
        self.passed = passed
        self.failures = []


class _FakeResult:
    def __init__(self, gradeable, errors, classes):
        self.gradeable = gradeable
        self.errors = errors
        self.error_classes = classes
        self.usage = {}
        self.duration_s = 1.0


class _FakeTask:
    def __init__(self, ref):
        self.ref = ref
        self.contract = {}


class _FakeSuite:
    def __init__(self, name="fake", version=3, agent="main"):
        self.name = name
        self.version = version
        self.agent = agent
        self.task_ids = ["t1"]


def test_execute_records_failure():
    print("\n[4] a run nothing could grade records type, message and "
          "resource_refusal")
    from app.evals import checks, suites as suite_mod

    real = (suite_mod.load_suite, suite_mod.load_tasks, checks.evaluate,
            eval_runner_mod.run_task)
    suite_mod.load_suite = lambda name, root=None: _FakeSuite()
    suite_mod.load_tasks = lambda suite, only=None: [_FakeTask("fake/t1")]
    checks.evaluate = lambda contract, result: _FakeReport(False)

    async def fake_run_task(task, model, **kw):
        return _FakeResult(
            gradeable=False,
            errors=["This prompt is about 4,211 tokens, and ollama:x has "
                    "4,096 usable"],
            classes=["prompt_too_long"])

    eval_runner_mod.run_task = fake_run_task
    conn = Conn()
    restore = with_conn(conn)
    try:
        asyncio.run(eval_runs._execute(
            "11111111-1111-1111-1111-111111111111", "fake", "ollama:x", 1))
    finally:
        restore()
        (suite_mod.load_suite, suite_mod.load_tasks, checks.evaluate,
         eval_runner_mod.run_task) = real

    # THE TERMINAL update, matched on `finished_at` rather than on being the
    # first one seen. Since migration 124 `_execute` also writes a per-task
    # cursor through the same table, so "the first UPDATE eval_runs" is now
    # the progress write and this assertion silently changed subject.
    update = next((e for e in conn.executed
                   if "UPDATE eval_runs SET" in e[0]
                   and "finished_at" in e[0]), None)
    check("the terminal update ran", update is not None)
    if not update:
        return
    args = update[1]
    detail = json.loads(args[7])
    failure = detail.get("failure") or {}
    check("status is error, never failed — a machine fact is not a verdict",
          args[1] == "error", str(args[1]))
    check("detail->failure exists on the row", bool(failure))
    check("...typed no_gradeable_tasks",
          failure.get("type") == "no_gradeable_tasks", str(failure)[:120])
    check("...with the refusal message", "4,211 tokens"
          in str(failure.get("message")), str(failure.get("message"))[:80])
    check("...naming the error class off the spans",
          failure.get("error_classes") == ["prompt_too_long"])
    check("...and derived as a RESOURCE refusal, so a starved night stops "
          "reading like a bad model",
          failure.get("resource_refusal") is True)
    check("the per-task entries carry their classes too",
          (detail["tasks"][0].get("error_classes") == ["prompt_too_long"]),
          str(detail["tasks"][:1])[:120])


# ── 5. a version bump is a RESET the standings can say ───────────────────

def _standings(rows, current_version=12):
    from app import settings_store
    from app.evals import suites as suite_mod

    real_installed = model_tournament._installed_local
    real_list, real_load = suite_mod.list_suites, suite_mod.load_suite
    real_get = settings_store.get

    async def installed():
        return ["ollama:qwen3:8b", "ollama:ornith:9b"]

    model_tournament._installed_local = installed
    suite_mod.list_suites = lambda root=None: ["main"]
    suite_mod.load_suite = (
        lambda name, root=None: _FakeSuite("main", current_version))
    settings_store.get = lambda key: None    # repeat default, rotation off
    conn = Conn(fetch_rows=rows)
    restore = with_conn(conn)
    try:
        return asyncio.run(model_tournament.standings())
    finally:
        restore()
        model_tournament._installed_local = real_installed
        suite_mod.list_suites, suite_mod.load_suite = real_list, real_load
        settings_store.get = real_get


def _row(model, version, when=None):
    return {"suite": "main", "model": model, "tasks_passed": 3,
            "tasks_total": 7, "repeat_count": 3, "suite_version": version,
            "started_at": when or dt.datetime(2026, 8, 1,
                                              tzinfo=dt.timezone.utc)}


def test_standings_reset():
    print("\n[5] standings say 'coverage reset by suite edit', never a bare "
          "empty board")
    out = _standings([_row("ollama:qwen3:8b", 8), _row("ollama:ornith:9b", 8)])
    check("runs at a superseded version do not count as coverage",
          out["comparable"] is False and out["basis"] == [])
    resets = out.get("coverage_reset") or []
    check("the reset is NAMED in the payload", len(resets) == 1,
          str(resets)[:120])
    if resets:
        r = resets[0]
        check("...with the suite and its current version",
              r["suite"] == "main" and r["version"] == 12, str(r)[:120])
        check("...the newest version actually measured",
              r["measured_versions"] == [8])
        check("...and how many complete runs the edit voided",
              r["runs_voided"] == 2)
        check("...and when coverage last existed",
              bool(r["last_measured"]))
    check("the payload says whether anything will re-measure "
          "(rotation_enabled, derived from the same setting maybe_run "
          "gates on)", out.get("rotation_enabled") is False)

    out = _standings([_row("ollama:qwen3:8b", 12),
                      _row("ollama:ornith:9b", 12)])
    check("coverage at the CURRENT version is not a reset",
          out.get("coverage_reset") == [], str(out.get("coverage_reset")))
    check("...and those runs count (two ranked models are comparable)",
          out["comparable"] is True)

    out = _standings([])
    check("a suite never measured at all is a true absence, not a reset",
          out.get("coverage_reset") == [])


# ── 6. next_pairing already treats a bump as never-measured — pinned ─────

def test_bump_sorts_first():
    print("\n[6] a version-bumped suite sorts FIRST in the rotation")
    from app.evals import suites as suite_mod

    real_installed = model_tournament._installed_local
    real_list, real_load = suite_mod.list_suites, suite_mod.load_suite

    async def installed():
        return ["ollama:qwen3:8b"]

    versions = {"bumped": 2, "covered": 1}
    model_tournament._installed_local = installed
    suite_mod.list_suites = lambda root=None: ["bumped", "covered"]
    suite_mod.load_suite = (
        lambda name, root=None: _FakeSuite(name, versions[name]))

    def answer(sql, *args):
        # (suite, suite_version): the bumped suite has no run at v2
        if args and args[0] == "bumped":
            return {"newest": None}
        return {"newest": dt.datetime.now(dt.timezone.utc)}

    conn = Conn(fetchrow_fn=answer)
    restore = with_conn(conn)
    try:
        pairing = asyncio.run(model_tournament.next_pairing())
    finally:
        restore()
        model_tournament._installed_local = real_installed
        suite_mod.list_suites, suite_mod.load_suite = real_list, real_load
    check("the mechanical re-trigger: bumping suite_version makes it the "
          "stalest coverage, so the next night measures it",
          pairing is not None and pairing[0] == "bumped", str(pairing))


# ── 7. a pairwise verdict is durable, and verified when written ──────────

def test_record_comparison():
    print("\n[7] record_comparison verifies its own insert")
    kwargs = dict(suite="main", suite_version=12, repeat_count=3,
                  champion="openrouter:z-ai/glm-5.2",
                  challenger="ollama:qwen3:8b", tasks_total=7,
                  tasks_gradeable=6, tasks_invalid=1, champion_passed=5,
                  challenger_passed=3, regressions=["main/a", "main/b"],
                  improvements=[], detail={"tasks": []})

    conn = Conn(fetchrow_result={"id": "abc-123"})
    restore = with_conn(conn)
    try:
        rid = asyncio.run(eval_runs.record_comparison(**kwargs))
    finally:
        restore()
    check("a verified insert returns the row id", rid == "abc-123", rid)
    sql, args = conn.executed[0]
    check("the key is (suite, suite_version, repeat_count, champion, "
          "challenger)", args[:5] == ("main", 12, 3,
                                      "openrouter:z-ai/glm-5.2",
                                      "ollama:qwen3:8b"), str(args[:5]))
    check("the insert proves itself with RETURNING id", "RETURNING id" in sql)

    conn = Conn(fetchrow_result=None)
    restore = with_conn(conn)
    try:
        asyncio.run(eval_runs.record_comparison(**kwargs))
        check("an unverifiable insert FAILS instead of reading as recorded",
              False)
    except RuntimeError as e:
        check("an unverifiable insert FAILS instead of reading as recorded",
              "NOT recorded" in str(e), str(e)[:80])
    finally:
        restore()

    class MissingTableConn(Conn):
        async def fetchrow(self, sql, *args):
            raise Exception('relation "eval_comparisons" does not exist')

    restore = with_conn(MissingTableConn())
    try:
        asyncio.run(eval_runs.record_comparison(**kwargs))
        check("a missing table names migration 120, not a stack trace", False)
    except RuntimeError as e:
        check("a missing table names migration 120, not a stack trace",
              "migration 120" in str(e), str(e)[:90])
    finally:
        restore()


# ── 8. the CLI aggregation matches the strict per-task rule ──────────────

class _Side:
    def __init__(self, valid=True, gradeable=True):
        self.valid = valid
        self.gradeable = gradeable


def _pair(ref, champ_ok, chall_ok, champ_side=None, chall_side=None):
    return {"task": ref,
            "champion": champ_side or _Side(),
            "challenger": chall_side or _Side(),
            "champion_contract": _FakeReport(champ_ok),
            "challenger_contract": _FakeReport(chall_ok)}


def test_cli_aggregation():
    print("\n[8] the CLI aggregates with the same rule eval_runs applies: "
          "passed EVERY repeat, invalid counts for neither side")
    import argparse

    from app.evals import __main__ as cli

    recorded = {}

    async def capture(**kw):
        recorded.update(kw)
        return "row-1"

    real = eval_runs.record_comparison
    eval_runs.record_comparison = capture

    class _T:
        suite = _FakeSuite("main", 12)

    pairs = [
        # t1: champion passes both repeats, challenger drops one — regression
        _pair("main/t1", True, True), _pair("main/t1", True, False),
        # t2: the reverse — improvement
        _pair("main/t2", False, True), _pair("main/t2", True, True),
        # t3: one invalid run — a suite gap, neither model's score
        _pair("main/t3", True, True),
        _pair("main/t3", True, True, champ_side=_Side(valid=False)),
    ]
    args = argparse.Namespace(champion="champ:x", challenger="chall:y",
                              ref="main")
    try:
        rid = asyncio.run(cli._record_comparison(args, [_T()], pairs))
    finally:
        eval_runs.record_comparison = real

    check("it records and returns the id", rid == "row-1", str(rid))
    check("repeat_count derived from the runs", recorded.get("repeat_count") == 2)
    check("three tasks total", recorded.get("tasks_total") == 3)
    check("the invalid task is carried as invalid, not scored",
          recorded.get("tasks_invalid") == 1
          and recorded.get("tasks_gradeable") == 2)
    check("passed means passed EVERY repeat",
          recorded.get("champion_passed") == 1
          and recorded.get("challenger_passed") == 1,
          f"{recorded.get('champion_passed')}/{recorded.get('challenger_passed')}")
    check("regressions and improvements are named tasks",
          recorded.get("regressions") == ["main/t1"]
          and recorded.get("improvements") == ["main/t2"],
          f"{recorded.get('regressions')} {recorded.get('improvements')}")
    check("the verdict is keyed to the suite's CURRENT version",
          recorded.get("suite_version") == 12)


def main() -> int:
    test_classifier()
    test_error_classes_from_spans()
    test_orphan_failure_stamp()
    test_execute_records_failure()
    test_standings_reset()
    test_bump_sorts_first()
    test_record_comparison()
    test_cli_aggregation()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES[:8]))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
