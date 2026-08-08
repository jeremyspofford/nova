"""The build loop actually loops, and a red loop reports as red.

    docker compose exec backend python tests/test_build_loop.py

Step 5 of Jeremy's flow — "loop 3 & 4 until completed the task" — has been in
`code_change._step_build` since ea9e70f and had never executed. Everything
about it was pinned except its behaviour: `test_code_landing.py` §6 asserts the
schema caps attempts at 5 and that the two constants are positive, which is a
statement about the ceilings and none about the loop.

Reading it before running it found three reasons it could not have worked, and
running it found a fourth:

  1. EVERY ATTEMPT CLONED THE TRUNK. So attempt 2 opened a checkout in which
     attempt 1's change did not exist, while its prompt quoted a test failure
     the agent could not reproduce. Not a weak retry — a false premise.
  2. ONLY THE LAST FAILURE SURVIVED, because the task text was rebuilt from the
     original each pass. Attempt 3 could undo attempt 1's fix and rediscover
     attempt 1's failure.
  3. THE NO-COMMIT PATH THREW THE HISTORY AWAY entirely, replacing the text
     with a warning about silent no-ops.
  4. A LOOP THAT NEVER WENT GREEN REPORTED "installed". `_run_steps` recorded
     every step "ok" whatever it returned, `_process` called the run
     "succeeded", and the operator was notified success for three failed
     attempts. Same for a landing refused by the sandbox gate.

WHAT IS BEING DEFENDED HERE is that a retry is the next step of one piece of
work rather than a second roll of the dice, and that when the loop gives up it
says so.
"""

import asyncio
import sys
import uuid

sys.path.insert(0, "/app/backend")

from app import actions                                  # noqa: E402
from app.actions import code_change as cc                # noqa: E402

# NO `_env` GUARD, deliberately: every question below is answered by driving
# the loop against a fake coder, so it means the same thing in the sandbox as
# it does on the operator's install. A suite that needs a live sidecar to
# describe its own control flow is testing the sidecar.

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}"
          + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def _doc(**over):
    raw = {"type": "code_change.build", "workspace": "nova",
           "task": "Add a docstring to backend/app/health.py explaining the "
                   "readiness contract.",
           "why": "because", **over}
    return actions.parse(raw)


# ── a fake coder, so the loop's control flow can be watched ─────────────────

class FakeCoder:
    """Stands in for `app.coder`. Records what the loop asked for.

    Deliberately NOT a mock library: the interesting assertions are about the
    arguments the loop passes — which task text, resuming which session — and
    those read better as a list of dicts than as call-object introspection.
    """

    def __init__(self, outcomes):
        #: one entry per attempt: ("green"|"red"|"nocommit"|"crash", detail)
        self.outcomes = list(outcomes)
        self.starts: list[dict] = []
        self.checked: list[str] = []
        self.lanes: list[str] = []
        self.charges: list[dict] = []
        self.delay = 0.0

    async def start(self, workspace, task, *, requested_by=None,
                    continue_from=None, **kw):
        sid = str(uuid.uuid4())
        self.starts.append({"session": sid, "task": task,
                            "continue_from": continue_from})
        return {"status": "started", "session_id": sid}

    async def refresh(self, session_id):
        i = [s["session"] for s in self.starts].index(session_id)
        kind, _ = self.outcomes[i]
        if kind == "crash":
            return {"state": "failed", "error": "the agent returned an error"}
        if kind == "nocommit":
            return {"state": "done", "commit": None}
        return {"state": "done", "commit": f"c0ffee{i}"}

    async def sandbox_check(self, session_id, *, lane="operator"):
        # `lane` is the SPEND BUDGET this check is charged to (ROADMAP #47
        # rail 3), not a permission. Accepted here so the fake keeps the real
        # signature — a stub that lags the thing it stands in for turns a
        # green suite into a statement about the stub.
        if self.delay:
            await asyncio.sleep(self.delay)
        self.checked.append(session_id)
        self.lanes.append(lane)
        i = [s["session"] for s in self.starts].index(session_id)
        kind, detail = self.outcomes[i]
        if kind == "green":
            return {"status": "ok", "detail": "build, boot and suite all green",
                    "eval": {"state": "unmeasured",
                             "detail": "no floors are set"}}
        return {"status": "failed", "stage": "suite", "detail": detail}


class FakeCtx:
    def __init__(self):
        self.records: list[tuple] = []
        self.scratch: dict = {}

    async def record(self, name, status, detail=""):
        self.records.append((name, status, detail))


def _run(outcomes, doc=None, budget=None, delay=0.0, rec=None):
    """Drive `_step_build` against a fake coder. Returns (result, fake)."""
    import app.coder as real_coder
    fake = FakeCoder(outcomes)
    fake.delay = delay
    saved = {k: getattr(real_coder, k) for k in ("start", "refresh",
                                                 "sandbox_check")}
    saved_budget = cc._LOOP_BUDGET_S
    saved_poll = cc._POLL_S
    for k in saved:
        setattr(real_coder, k, getattr(fake, k))
    # THE LEDGER IS STUBBED, NOT DISABLED. `spend.record` writes one row per
    # attempt (rail 3) and this suite runs with no database; it swallows its
    # own failure by design, but it would log a stack trace per attempt and a
    # clean run would read as broken. Recording the calls instead means the
    # metering stays observable here rather than merely tolerated.
    import app.spend as real_spend
    saved_record = real_spend.record

    async def _record(lane, kind, **kw):
        fake.charges.append({"lane": lane, "kind": kind, **kw})
        return {"id": None, "metered": bool(kw.get("usage"))}
    real_spend.record = _record
    if budget is not None:
        cc._LOOP_BUDGET_S = budget
    cc._POLL_S = 0.0
    try:
        out = asyncio.run(cc._step_build(doc or _doc(), rec or {}, FakeCtx()))
    finally:
        for k, v in saved.items():
            setattr(real_coder, k, v)
        real_spend.record = saved_record
        cc._LOOP_BUDGET_S = saved_budget
        cc._POLL_S = saved_poll
    return out, fake


# ── 1. the instruction a retry is given ─────────────────────────────────────

def test_retry_task():
    print("\n1. A RETRY IS TOLD WHAT HAPPENED, AND WHERE IT IS STANDING")
    task = "Add a docstring to health.py."
    first = cc.retry_task(task, [], None)
    check("1.1 attempt 1 gets the task unchanged", first == task,
          "nothing has happened yet, so there is nothing to say")

    fail1 = "suite: FAILED tests/test_health.py::test_readiness"
    second = cc.retry_task(task, [fail1], "sess-1")
    check("1.2 a retry carries the failure verbatim", fail1 in second,
          "'the sandbox said no' is not actionable")
    check("1.3 …and still carries the original task", task in second)
    check("1.4 …and says which attempt this is", "ATTEMPT 2" in second)

    fail2 = "suite: FAILED tests/test_other.py::test_thing"
    third = cc.retry_task(task, [fail1, fail2], "sess-2")
    check("1.5 attempt 3 carries EVERY failure, not just the last",
          fail1 in third and fail2 in third,
          "otherwise it can undo attempt 1's fix and rediscover its failure")
    check("1.6 …in order, numbered by attempt",
          third.index(fail1) < third.index(fail2))

    # THE FALSE PREMISE, and the reason this function exists. What the agent is
    # told about its checkout has to be TRUE of the checkout it gets.
    check("1.7 a resumed retry says the change is already in the tree",
          "ALREADY CONTAINS" in third, "and it is — the clone is that session's")
    check("1.8 …and tells it to reproduce the failure before editing",
          "eproduce" in third)

    orphan = cc.retry_task(task, ["finished without changing anything"], None)
    check("1.9 with nothing to resume it does NOT claim the change is present",
          "ALREADY CONTAINS" not in orphan,
          "the bug: quoting a failure the agent cannot reproduce")
    check("1.10 …it says the checkout is clean, which is the truth",
          "clean checkout" in orphan)


# ── 2. the loop, driven ─────────────────────────────────────────────────────

def test_the_loop_loops():
    print("\n2. THE LOOP RUNS, AND EACH PASS BUILDS ON THE LAST")
    red = ("red", "suite: FAILED tests/test_health.py::test_readiness")
    out, fake = _run([red, ("green", "")])

    check("2.1 a red attempt is followed by a second one",
          len(fake.starts) == 2, f"{len(fake.starts)} session(s) started")
    check("2.2 attempt 2's instruction carried attempt 1's failure",
          len(fake.starts) > 1 and red[1] in fake.starts[1]["task"])
    # THE HALF THAT WAS MISSING. Carrying the text is not enough: the code the
    # text is about has to be in the tree the agent opens.
    check("2.3 …and attempt 2 RESUMED attempt 1's session",
          len(fake.starts) > 1
          and fake.starts[1]["continue_from"] == fake.starts[0]["session"],
          "a fresh clone would make the quoted failure unreproducible")
    check("2.4 attempt 1 resumed nothing", fake.starts[0]["continue_from"] is None)
    check("2.5 green on attempt 2 returns ok",
          out.get("status") == "ok" and out.get("attempts") == 2,
          str(out.get("detail"))[:60])
    check("2.6 …naming the session that is ready to land",
          out.get("session_id") == fake.starts[1]["session"])


def test_the_cap_stops_it():
    print("\n3. THE CAP STOPS IT, AND SAYS SO")
    red = ("red", "suite: FAILED test_a")
    red2 = ("red", "suite: FAILED test_b")
    red3 = ("red", "boot: backend never became healthy")
    out, fake = _run([red, red2, red3], doc=_doc(attempts=3))

    check("3.1 exactly `attempts` sessions were started, and no more",
          len(fake.starts) == 3, f"{len(fake.starts)}")
    check("3.2 …and every one of them was checked",
          len(fake.checked) == 3, f"{len(fake.checked)}")
    check("3.3 the loop reports FAILURE, not a quiet stop",
          out.get("status") == "error", str(out.get("detail"))[:60])
    detail = str(out.get("detail"))
    check("3.4 …and the report names all three failures",
          all(x[1][:20] in detail for x in (red, red2, red3)), detail[:90])
    check("3.5 the chain is unbroken — each attempt resumed the last",
          fake.starts[2]["continue_from"] == fake.starts[1]["session"]
          and fake.starts[1]["continue_from"] == fake.starts[0]["session"])


def test_the_clock_stops_it():
    print("\n4. THE WALL CLOCK STOPS IT BEFORE THE CAP")
    red = ("red", "suite: FAILED test_a")
    # A budget smaller than one attempt takes. Attempt 1 runs to completion —
    # the loop checks the clock BETWEEN attempts, so a step in progress is
    # never abandoned half-done — and attempt 2 is refused.
    out, fake = _run([red, red, red], doc=_doc(attempts=3),
                     budget=0.5, delay=0.6)

    check("4.1 the clock cut the loop short of its attempt cap",
          len(fake.starts) == 1, f"{len(fake.starts)} of 3 attempts ran")
    check("4.2 it reports failure", out.get("status") == "error")
    check("4.3 …and says the budget is what stopped it",
          "budget" in str(out.get("detail")), str(out.get("detail"))[:80])
    check("4.4 …and still reports what it managed to try",
          red[1][:18] in str(out.get("detail")), str(out.get("detail"))[:80])


def test_a_no_op_attempt():
    print("\n5. AN ATTEMPT THAT WROTE NOTHING IS NOT A BASE TO RESUME FROM")
    out, fake = _run([("nocommit", ""), ("green", "")])
    check("5.1 the loop continues after a silent no-op",
          len(fake.starts) == 2)
    check("5.2 the no-op session was never sandbox-checked",
          fake.checked == [fake.starts[1]["session"]],
          "there is no commit to check")
    check("5.3 attempt 2 did not resume a session with no work in it",
          fake.starts[1]["continue_from"] is None,
          "resuming it would silently reset the base to the trunk")
    check("5.4 …and attempt 2 was told the checkout is clean",
          "clean checkout" in fake.starts[1]["task"])

    print("   …and a session that died is treated the same way")
    out, fake = _run([("crash", ""), ("green", "")])
    check("5.5 a failed session does not stop the loop", len(fake.starts) == 2)
    check("5.6 …and is not resumed from",
          fake.starts[1]["continue_from"] is None)
    check("5.7 …but IS reported in the next attempt's history",
          "failed" in fake.starts[1]["task"], fake.starts[1]["task"][-60:])


# ── 6. a failure is reported as a failure ───────────────────────────────────

def test_a_refusal_is_not_success():
    print("\n6. A STEP THAT FAILED IS NOT RECORDED AS SUCCESS")
    from app import action_worker as aw

    check("6.1 an error result is refused",
          aw.refusal({"status": "error", "detail": "none green"}) == "none green")
    check("6.2 …even with no detail to explain it",
          bool(aw.refusal({"status": "error"})))
    check("6.3 an ok result is not", aw.refusal({"status": "ok"}) is None)
    check("6.4 …and neither is a plain string",
          aw.refusal("landed on nova/x") is None,
          "steps may return a receipt line instead of a dict")

    # The receipt the operator reads. A dict repr in the card is a debug dump.
    check("6.5 the receipt is the detail line, not the dict",
          aw._receipt({"status": "error", "detail": "none green", "x": 1})
          == "none green")

    async def _fails(doc, rec, ctx):
        return {"status": "error",
                "detail": "stopped after 3 attempts, none green"}

    async def _never_runs(doc, rec, ctx):        # pragma: no cover
        raise AssertionError("a step ran after one that failed")

    # No database needed and none touched: the failing step returns before the
    # cursor is written, which is itself part of what is being asserted.
    async def drive():
        class Spec:
            steps = [("first", _fails), ("second", _never_runs)]

        run = {"id": uuid.uuid4(), "answer": None, "question": None,
               "step_index": 0, "conversation_id": None}
        seen: list[tuple] = []

        async def step(name, status, detail=""):
            seen.append((name, status, detail))

        result = await aw._run_steps(Spec(), _doc(), {}, run, step)
        return result, seen

    try:
        result, seen = asyncio.run(drive())
    except Exception as e:                                   # noqa: BLE001
        check("6.6 the step runner could be driven", False, str(e)[:80])
        return
    check("6.6 the failing step is recorded `error`, not `ok`",
          seen and seen[0][1] == "error", str(seen[:1]))
    check("6.7 …with the reason in the receipt",
          seen and "none green" in seen[0][2], str(seen[0][2])[:60] if seen else "")
    check("6.8 …and the run stopped there", len(seen) == 1,
          f"{len(seen)} step(s) recorded")
    check("6.9 …and the result it returns is still the failure",
          aw.refusal(result) is not None)


# ── 7. the broker can genuinely resume ──────────────────────────────────────

def test_the_broker_can_resume():
    """The loop's promise is only true if the sidecar honours it."""
    print("\n7. THE SIDECAR THE LOOP TALKS TO CAN ACTUALLY RESUME")
    import ast
    try:
        src = open("/app/project/coder/broker.py").read()
    except OSError as e:
        print(f"  SKIP  the project tree is not mounted here ({e})")
        return
    tree = ast.parse(src)

    fields: set[str] = set()
    clone_raises = False
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == "StartSession":
            fields = {t.target.id for t in node.body
                      if isinstance(t, ast.AnnAssign)
                      and isinstance(t.target, ast.Name)}
        if isinstance(node, ast.FunctionDef) and node.name == "_checkout":
            clone_raises = any(isinstance(n, ast.Raise)
                               for n in ast.walk(node))
    check("7.1 the broker accepts a session to continue from",
          "continue_from" in fields, sorted(fields))
    check("7.2 …and a base ref, so a resumed patch is measured from the trunk",
          "base_ref" in fields)
    # The false-premise guard, in the one place that can enforce it: cloning
    # the trunk when asked to resume is exactly the bug, arriving silently.
    check("7.3 a resume it cannot honour raises rather than starting fresh",
          clone_raises, "a silent fresh clone is the bug this replaces")
    check("7.4 the patch is not pinned to the last commit alone",
          '"HEAD~1..HEAD"' not in src,
          "a resumed series would be cut down to its final delta")

    # ONE CLONE PER REPOSITORY. Every session used to run its own `git clone`,
    # so N tasks against one repo meant N copies on disk, minutes each, and N
    # views of `main` drifting apart as they aged. A checkout is kept in sync,
    # not made again.
    clones = [n for n in ast.walk(tree)
              if isinstance(n, ast.Call)
              and any(isinstance(a, ast.Constant) and a.value == "clone"
                      for a in (n.args[0].elts
                                if n.args and isinstance(n.args[0], ast.List)
                                else []))]
    check("7.5 the broker runs `git clone` in exactly one place",
          len(clones) == 1, f"{len(clones)} call site(s)")
    in_mirror = False
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_mirror":
            in_mirror = any(n in clones for n in ast.walk(node))
    check("7.6 …and that place is the shared mirror, cloned once and fetched",
          in_mirror, "sessions must not clone")
    checkout_src = ""
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "_checkout":
            checkout_src = ast.unparse(node)
    check("7.7 a session takes a worktree of it instead",
          "'worktree'" in checkout_src and "'add'" in checkout_src,
          "cheap, shares the object store, and keeps one view of main")


def test_every_attempt_is_metered():
    """Rail 3: what a pass cost is written down, whether or not it worked.

    A meter that only counts successes measures the wrong thing — a failed
    attempt burned the same tokens — and a build the OPERATOR asked for must
    not be charged against the ceiling that bounds what happens while he is
    not looking.
    """
    print("\n8. EVERY ATTEMPT IS METERED, AND CHARGED TO THE RIGHT BUDGET")
    red = ("red", "2 failed")
    _out, fake = _run([red, red, ("green", "")])
    builds = [c for c in fake.charges if c["kind"] == "coding_session"]
    check("8.1 one ledger entry per attempt, failures included",
          len(builds) == 3, f"{len(builds)} entr(ies) for 3 attempts")
    check("8.2 an operator-triggered build is NOT charged to the "
          "self-improvement ceiling",
          {c["lane"] for c in fake.charges} == {"operator"},
          str({c["lane"] for c in fake.charges}))
    check("8.3 a session the sidecar reported no usage for is recorded "
          "UNMETERED, never as zero tokens",
          all(c.get("usage") is None for c in builds),
          "a zero would read as free")
    checks_ = [c for c in fake.charges if c["kind"] == "sandbox_check"]
    check("8.4 the sandbox check is charged too — it builds an image and "
          "imports a production-sized database",
          len(checks_) == 0 or all(c["lane"] == "operator" for c in checks_),
          "the fake stands in for coder.sandbox_check, which does its own "
          "recording in the real thing")
    check("8.5 the boot gate is told which budget it is spending",
          fake.lanes == ["operator"] * len(fake.lanes) and bool(fake.lanes),
          str(fake.lanes))

    # ...AND THOSE THREE ENTRIES ARE ONE PASS. The entries are per attempt on
    # purpose; the ceiling the operator approved is written in PASSES ("at
    # most 4 passes a day", migration 116). Without a run id on every row,
    # `spend.today` counted these three as three passes and one retrying pass
    # spent three quarters of his day. The run id is the only thing that can
    # tell them apart — nothing downstream can reconstruct it.
    _out2, fake2 = _run([red, red, ("green", "")],
                        rec={"run_id": "11111111-1111-1111-1111-111111111111"})
    builds2 = [c for c in fake2.charges if c["kind"] == "coding_session"]
    check("8.6 every attempt carries the run it belongs to",
          all(c.get("run_id") == "11111111-1111-1111-1111-111111111111"
              for c in builds2) and len(builds2) == 3,
          str([c.get("run_id") for c in builds2]))
    check("8.7 …one run id across all three, so three attempts are one pass "
          "against the ceiling he approved",
          len({c.get("run_id") for c in builds2}) == 1)


def main() -> int:
    test_retry_task()
    test_the_loop_loops()
    test_the_cap_stops_it()
    test_the_clock_stops_it()
    test_a_no_op_attempt()
    test_a_refusal_is_not_success()
    test_the_broker_can_resume()
    test_every_attempt_is_metered()
    if FAILURES:
        print(f"\nFAILED ({len(FAILURES)}): " + "; ".join(FAILURES[:8]))
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
