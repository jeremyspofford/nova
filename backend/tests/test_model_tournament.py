"""Which suite gets ranked tonight, and why nothing is ever promoted.

    docker compose exec backend python tests/test_model_tournament.py

Phase 1 of docs/plans/model-tournament.md builds EVIDENCE. It does not swap a
binding and does not delete a model, and that is measured rather than timid:
`ornith:9b` scored 2/7 then 3/7 on consecutive runs of the same suite, the
task that flipped was a coin at 1/3, and `ornith:9b` and `qwen3:8b` are tied
at 2/7 over three repeats each. A loop promoting on those numbers promotes
whichever model ran on a lucky night.

The selection is mechanical — no model is asked which model is best — so it is
testable, and these are the properties that make a recorded score comparable:

1. A suite never measured AT ITS CURRENT VERSION sorts first. A score from
   before the suite moved describes a different set of tasks, so it is not
   coverage, and treating it as coverage would leave a changed suite unranked
   indefinitely.
2. Otherwise the stalest wins, so eight nights covers eight suites instead of
   one suite being measured forever.
3. Off is the default, and off means nothing runs.
"""

import asyncio
import datetime as dt
import sys

sys.path.insert(0, "/app/backend")

from app import model_tournament as mt              # noqa: E402

FAILURES: list[str] = []


def check(label, cond, detail=""):
    print(f"  {'PASS' if cond else 'FAIL'}  {label}" + (f"   [{detail}]" if detail else ""))
    if not cond:
        FAILURES.append(label)


class Conn:
    """Answers the newest-run query from a {(suite, version): datetime} map."""

    def __init__(self, newest):
        self.newest = newest

    async def fetchrow(self, sql, *args):
        return {"newest": self.newest.get((args[0], args[1]))}


class Acquire:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        return self.conn

    async def __aexit__(self, *a):
        return False


def pairing(suites: dict, newest: dict, models=("ollama:a",)):
    """next_pairing with the suite table, the run history and the installed
    model list all injected — no database, no ollama."""
    from app import db
    from app.evals import suites as suite_mod

    class FakeSuite:
        def __init__(self, v):
            self.version = v

    real = (db.acquire, suite_mod.list_suites, suite_mod.load_suite,
            mt._installed_local)

    async def _installed():
        return list(models)

    db.acquire = lambda: Acquire(Conn(newest))
    suite_mod.list_suites = lambda *a, **k: list(suites)
    suite_mod.load_suite = lambda name, *a, **k: FakeSuite(suites[name])
    mt._installed_local = _installed
    try:
        return asyncio.run(mt.next_pairing())
    finally:
        (db.acquire, suite_mod.list_suites, suite_mod.load_suite,
         mt._installed_local) = real


def ts(hours_ago: float):
    return dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours_ago)


def main() -> int:
    print("1. a suite never measured at its current version goes first")
    got = pairing({"alpha": 1, "beta": 2}, {("alpha", 1): ts(1)})
    check("beta, which has no result at v2, wins over a fresh alpha",
          got and got[0] == "beta", str(got and got[0]))

    print("2. a score from an OLDER version is not coverage")
    # alpha was measured an hour ago — but at v1, and alpha is now v2. That
    # score describes different tasks, so alpha still counts as unmeasured.
    got = pairing({"alpha": 2, "beta": 2},
                  {("alpha", 1): ts(1), ("beta", 2): ts(48)})
    check("alpha wins despite a recent result, because it was a different suite",
          got and got[0] == "alpha", str(got and got[0]))

    print("3. otherwise the stalest wins, so the rotation actually rotates")
    got = pairing({"alpha": 1, "beta": 1, "gamma": 1},
                  {("alpha", 1): ts(2), ("beta", 1): ts(100), ("gamma", 1): ts(50)})
    check("beta, untouched longest", got and got[0] == "beta", str(got and got[0]))
    got = pairing({"alpha": 1, "beta": 1, "gamma": 1},
                  {("alpha", 1): ts(2), ("beta", 1): ts(1), ("gamma", 1): ts(500)})
    check("gamma once it is the stalest", got and got[0] == "gamma",
          str(got and got[0]))

    print("4. the field is every installed local model, derived not listed")
    got = pairing({"alpha": 1}, {}, models=("ollama:a", "ollama:b", "ollama:c"))
    check("all three are entered", got and len(got[1]) == 3, str(got and got[1]))
    check("no local models at all means no tournament, not an empty run",
          pairing({"alpha": 1}, {}, models=()) is None)

    print("5. off is the default, and off means nothing happens")
    from app import settings_store
    real_get = settings_store.get
    settings_store.get = lambda k, *a, **kw: (
        0 if k == "evals.tournament_every_hours" else real_get(k, *a, **kw))
    try:
        check("maybe_run does nothing while the interval is 0",
              asyncio.run(mt.maybe_run()) is None)
    finally:
        settings_store.get = real_get

    print("6. it cannot promote or delete — there is no such code path")
    src = open("/app/backend/app/model_tournament.py").read()
    for forbidden in ("uninstall", "delete_model", "patchAgent", "update_agent",
                      "manage_agents"):
        check(f"no {forbidden!r} anywhere in the module", forbidden not in src)

    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILED: " + "; ".join(FAILURES))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
