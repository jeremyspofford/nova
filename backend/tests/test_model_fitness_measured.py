"""Fitness must MEASURE behaviour, not read a capability a model declares.

    docker compose exec backend python tests/test_model_fitness_measured.py

Every check in `assess` above this one reads something the model says about
itself. `/api/show`'s capability list is a manifest: "tools" in it means the
runtime knows how to format a tool call, not that this model has ever made
one. ornith:9b declares tools, passed that check, and is recorded at 0/6 on
its own agent's suite — so the exact model the narration, capability-claim and
service-claim detectors were built for was being waved through as fit for the
front door.

The properties defended here:

1. A model with a recorded ZERO is BLOCKING, and says so with the number.
2. A model that has never been graded produces a finding that says UNMEASURED
   — silence would read as "fit", which is how this happened. Same HONEST
   ABSENCE rule diagnose learned the same day.
3. The declared-capability check is KEPT, not replaced. It is cheap and it
   catches a genuinely tool-less model before a turn is spent on it. It just
   stops being the last word.
4. A role that needs no tools is not judged on a tool-calling suite.

`describe` and `eval_evidence` are both injected, so nothing here touches
ollama or the eval_runs table.
"""

import asyncio
import sys

sys.path.insert(0, "/app/backend")

from app import model_fitness as mf                # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


def run(*, evidence, caps=("tools",), needs_tools=True, local=True):
    """assess() with both of its sources injected."""
    async def _describe(model):
        return {"capabilities": list(caps) if caps is not None else None,
                "local": local, "context_length": 40960}

    async def _evidence(model, agent_name=None):
        return evidence

    real_d, real_e = mf.describe, mf.eval_evidence
    mf.describe, mf.eval_evidence = _describe, _evidence
    try:
        return asyncio.run(mf.assess(
            "ollama:test:9b", needs_tools=needs_tools, role="'main'",
            measured_for="main"))
    finally:
        mf.describe, mf.eval_evidence = real_d, real_e


def by_check(findings, key):
    return next((f for f in findings if f["check"] == key), None)


def main() -> int:
    print("1. a recorded zero blocks, with the number")
    fs = run(evidence={"suite": "main", "tasks_passed": 0, "tasks_total": 6,
                       "failed_tasks": ["main/shell-claim-under-pressure",
                                        "main/service-outage-named"]})
    m = by_check(fs, "measured")
    check("it is BLOCKING", m and m["severity"] == mf.BLOCKING,
          m["severity"] if m else "no finding")
    check("the score is in the text", m and "0/6" in m["detail"])
    check("and it names what failed, not just a ratio",
          m and "service-outage-named" in m["detail"])
    check("it says the verdict is measured, not inferred from the manifest",
          m and "measured" in m["detail"] and "/api/show" in m["detail"])

    print("2. never graded says UNMEASURED — silence would read as fit")
    fs = run(evidence=None)
    u = by_check(fs, "unmeasured")
    check("a finding exists at all", bool(u))
    check("it is advisory, not blocking — absence of evidence is not evidence "
          "of unfitness either", u and u["severity"] == mf.ADVISORY)
    check("it names the distinction that caused this",
          u and "DECLARES" in u["detail"])
    check("and tells the operator how to get the evidence",
          u and "app.evals" in u["detail"])
    check("no 'measured' finding is invented alongside it",
          by_check(fs, "measured") is None)

    print("3. a partial score is advisory, not blocking")
    fs = run(evidence={"suite": "main", "tasks_passed": 5, "tasks_total": 6,
                       "failed_tasks": ["main/service-outage-named"]})
    m = by_check(fs, "measured")
    check("advisory", m and m["severity"] == mf.ADVISORY, m["severity"] if m else "-")
    check("with the real score", m and "5/6" in m["detail"])

    print("4. a clean sweep produces no behavioural finding")
    fs = run(evidence={"suite": "main", "tasks_passed": 6, "tasks_total": 6,
                       "failed_tasks": []})
    check("nothing measured, nothing unmeasured",
          by_check(fs, "measured") is None and by_check(fs, "unmeasured") is None,
          str([f["check"] for f in fs]))

    print("5. the declared-capability check is KEPT, not replaced")
    fs = run(evidence={"suite": "main", "tasks_passed": 6, "tasks_total": 6,
                       "failed_tasks": []}, caps=("completion",))
    t = by_check(fs, "tools")
    check("a model that cannot call tools is still blocked on the cheap check, "
          "before a turn is spent measuring it",
          t and t["severity"] == mf.BLOCKING, str([f["check"] for f in fs]))

    print("6. a role that needs no tools is not judged on a tool suite")
    fs = run(evidence=None, needs_tools=False)
    check("no unmeasured finding for a tool-less role",
          by_check(fs, "unmeasured") is None, str([f["check"] for f in fs]))

    print("7. eval_evidence survives detail arriving as a JSON STRING")
    # asyncpg hands jsonb back as str unless a codec is registered, and the
    # column is read straight off the row — a dict-only reader would silently
    # report zero failed tasks and the finding would lose its whole point.
    import json as _json

    class _Conn:
        async def fetchrow(self, sql, *args):
            return {"suite": "main", "agent_name": "main", "tasks_passed": 0,
                    "tasks_total": 2, "finished_at": None,
                    "detail": _json.dumps({"tasks": [
                        {"task": "main/a", "passed": False},
                        {"task": "main/b", "passed": True}]})}

    class _Acquire:
        async def __aenter__(self): return _Conn()
        async def __aexit__(self, *a): return False

    from app import db
    real_acquire = db.acquire
    db.acquire = lambda: _Acquire()
    try:
        ev = asyncio.run(mf.eval_evidence("ollama:test:9b", "main"))
    finally:
        db.acquire = real_acquire
    check("the failing task is extracted from a string payload",
          ev and ev["failed_tasks"] == ["main/a"], str(ev and ev["failed_tasks"]))

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
