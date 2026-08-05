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
        def __init__(self, name, v):
            self.name, self.version, self.agent = name, v, name

    real = (db.acquire, suite_mod.list_suites, suite_mod.load_suite,
            mt._installed_local)

    async def _installed():
        return list(models)

    db.acquire = lambda: Acquire(Conn(newest))
    suite_mod.list_suites = lambda *a, **k: list(suites)
    suite_mod.load_suite = lambda name, *a, **k: FakeSuite(name, suites[name])
    mt._installed_local = _installed
    try:
        return asyncio.run(mt.next_pairing())
    finally:
        (db.acquire, suite_mod.list_suites, suite_mod.load_suite,
         mt._installed_local) = real


def ts(hours_ago: float):
    return dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=hours_ago)


class RowsConn:
    """Answers the standings query from a list of recorded runs."""

    def __init__(self, rows):
        self.rows = rows

    async def fetch(self, sql, models, min_repeat):
        out = [r for r in self.rows
               if r["model"] in models and r["repeat_count"] >= min_repeat
               # mirrors the SQL: only a run the model actually sat
               and r.get("tasks_gradeable") is not None
               and r["tasks_gradeable"] == r["tasks_total"]
               and r["tasks_total"] > 0]
        # production orders newest-first and standings() relies on that to
        # pick the newest COMPARABLE row per pair — so the fake must too
        out.sort(key=lambda r: r["started_at"], reverse=True)
        return out


def run(suite, model, passed, total, ver, hours_ago, repeat=3, asked=None):
    """One recorded run. `asked` defaults to the whole suite — a complete
    sitting — because that is what a comparable run is."""
    return {"suite": suite, "model": model, "tasks_passed": passed,
            "tasks_total": total, "suite_version": ver,
            "started_at": ts(hours_ago), "repeat_count": repeat,
            "tasks_gradeable": total if asked is None else asked}


def standings_of(suites: dict, rows: list, models, min_repeat=3):
    """standings() with the suite table, the run history, the installed list
    and the repeat setting all injected — no database, no ollama."""
    from app import db, settings_store
    from app.evals import suites as suite_mod

    class FakeSuite:
        def __init__(self, name, v):
            self.name, self.version, self.agent = name, v, name

    real = (db.acquire, suite_mod.list_suites, suite_mod.load_suite,
            mt._installed_local, settings_store.get)
    real_setting = settings_store.get

    async def _installed():
        return list(models)

    db.acquire = lambda: Acquire(RowsConn(rows))
    suite_mod.list_suites = lambda *a, **k: list(suites)
    suite_mod.load_suite = lambda name, *a, **k: FakeSuite(name, suites[name])
    mt._installed_local = _installed
    settings_store.get = lambda k, *a, **kw: (
        min_repeat if k == "evals.tournament_repeat" else real_setting(k, *a, **kw))
    try:
        return asyncio.run(mt.standings())
    finally:
        (db.acquire, suite_mod.list_suites, suite_mod.load_suite,
         mt._installed_local, settings_store.get) = real


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

    print("4b. the field does not narrow to whatever an agent happens to be bound to")
    # It did once: a cloud-bound agent's suite entered the install standby
    # ALONE, on the argument that ranking six models against guardian measures
    # a configuration nobody deploys. That argument sounded right and was
    # wrong twice over. It made the standby UNIMPROVABLE — eleven of twelve
    # suites entered exactly one model, the incumbent, and a challenger cannot
    # out-score a model it is never run against. And it asked the deployment
    # question about the wrong subject: not "does anyone deploy THIS model on
    # THIS agent" but "does anyone deploy A LOCAL model here", which is yes
    # everywhere, because the standby stands in for every cloud agent the
    # moment a provider fails.
    #
    # Proven by making the registry RAISE rather than by reading the field
    # back: if a binding could influence the field at all, this explodes
    # instead of returning three models.
    from app.agents import registry as agent_registry

    real_get = agent_registry.get_agent_by_name

    async def _explode(_name):
        raise AssertionError("field selection consulted a binding")

    agent_registry.get_agent_by_name = _explode
    try:
        got = pairing({"cloud-suite": 1}, {},
                      models=("ollama:a", "ollama:b", "ollama:standby"))
        check("a suite whose agent runs cloud still enters the whole field — "
              "every local model is a candidate for the standby role, and the "
              "standby role runs every suite",
              got and got[1] == ["ollama:a", "ollama:b", "ollama:standby"],
              str(got and got[1]))
    except AssertionError as exc:
        check(f"the field must not depend on a binding — {exc}", False)
    finally:
        agent_registry.get_agent_by_name = real_get

    print("5. the basis is the suites that can tell two models apart")
    # Anything else is not apples-to-apples. Averaging a model measured on one
    # suite against one measured on two ranks the least-tested model first
    # about as often as not, which is the failure this whole shape avoids.
    got = standings_of(
        {"alpha": 1, "beta": 1},
        [run("alpha", "ollama:a", 5, 7, 1, 2),
         run("alpha", "ollama:b", 3, 7, 1, 2),
         run("beta", "ollama:a", 6, 6, 1, 2)],
        ("ollama:a", "ollama:b"))
    check("beta is excluded — only one model has ever been measured on it",
          got["basis"] == ["alpha"], str(got["basis"]))
    check("and the pairing still owed is NAMED, not silently folded in",
          {"suite": "beta", "model": "ollama:b"} in got["missing"],
          str(got["missing"]))
    check("the winner is decided on the basis alone — 5/7 beats 3/7",
          got["leader"] == "ollama:a", str(got["leader"]))
    check("a's uncounted 6/6 on beta does not inflate its total",
          got["table"][0]["total"] == 7, str(got["table"][0]))

    print("5b. a newly pulled model does not erase a comparison it is not in")
    # The first cut required EVERY installed model on a suite for it to count,
    # which reads stricter and is more fragile: pulling a third model emptied
    # the basis and threw away a clean two-way result until the rotation came
    # round again. Proposing pulls is phase 4 of this same plan, so that is
    # the normal case rather than an edge one.
    got = standings_of(
        {"alpha": 1, "beta": 1},
        [run("alpha", "ollama:a", 5, 7, 1, 2),
         run("alpha", "ollama:b", 3, 7, 1, 2),
         run("beta", "ollama:a", 4, 6, 1, 2),
         run("beta", "ollama:b", 2, 6, 1, 2)],
        ("ollama:a", "ollama:b", "ollama:new"))
    check("the measured models keep their comparison over BOTH suites",
          got["basis"] == ["alpha", "beta"] and got["comparable"],
          f"basis={got['basis']} comparable={got['comparable']}")
    check("the newcomer is carried as unranked instead of emptying the basis",
          any(r["model"] == "ollama:new" and not r["ranked"]
              for r in got["table"]),
          str([(r["model"], r["ranked"]) for r in got["table"]]))
    check("...and it sorts last, below everything actually measured",
          got["table"][-1]["model"] == "ollama:new",
          str([r["model"] for r in got["table"]]))
    check("the winner is still decided among the models that were measured "
          "(9/13 against 5/13)", got["leader"] == "ollama:a", str(got["leader"]))

    print("6. only the current suite version counts, and only a real repeat")
    # alpha is now v2. a's NEWEST row is v1 — a different set of tasks — and
    # its v2 row is older. The older comparable row has to win, which is why
    # the version test cannot happen after de-duplication.
    got = standings_of(
        {"alpha": 2},
        [run("alpha", "ollama:a", 7, 7, 1, 1),
         run("alpha", "ollama:a", 2, 7, 2, 9),
         run("alpha", "ollama:b", 3, 7, 2, 5)],
        ("ollama:a", "ollama:b"))
    a = next((r for r in got["table"] if r["model"] == "ollama:a"), None)
    check("a newer row at a STALE version does not mask the older current one",
          a and a["passed"] == 2, str(a))
    check("...so b takes it on 3/7 against a's real 2/7",
          got["leader"] == "ollama:b", str(got["leader"]))

    got = standings_of({"alpha": 1},
                       [run("alpha", "ollama:a", 7, 7, 1, 1, repeat=1),
                        run("alpha", "ollama:b", 0, 7, 1, 1, repeat=3)],
                       ("ollama:a", "ollama:b"))
    check("a single draw cannot enter the standings, let alone win them",
          got["comparable"] is False and got["leader"] is None,
          f"basis={got['basis']} leader={got['leader']}")

    print("6b. a model that was never asked is not a model that scored zero")
    # The real first night, 2026-08-04. Six models over `main`; ollama keeps
    # each resident for minutes, so every model after the first loaded into a
    # GPU still holding its predecessor, windows collapsed to 8,192, and
    # main's 4,211-token prompt was refused by nineteen tokens. Recorded:
    #
    #   gemma4:12b  0/7 asked 0     ornith:9b  0/7 asked 0
    #   gemma4:e2b  0/7 asked 2     qwen3:14b  2/7 asked 6
    #   qwen3:8b    1/7 asked 7  <- the only complete sitting
    #
    # standings crowned qwen3:14b and put the two that answered NOTHING last
    # at 0%. Version, repeat and basis were all satisfied; the denominators
    # were not the same test.
    got = standings_of(
        {"main": 1},
        [run("main", "ollama:gemma4:12b", 0, 7, 1, 2, asked=0),
         run("main", "ollama:gemma4:e2b", 0, 7, 1, 2, asked=2),
         run("main", "ollama:qwen3:14b", 2, 7, 1, 2, asked=6),
         run("main", "ollama:qwen3:8b", 1, 7, 1, 2, asked=7)],
        ("ollama:gemma4:12b", "ollama:gemma4:e2b",
         "ollama:qwen3:14b", "ollama:qwen3:8b"))
    ranked = [r["model"] for r in got["table"] if r["ranked"]]
    check("a model asked NOTHING is not ranked at 0% — it has no score",
          "ollama:gemma4:12b" not in ranked, str(ranked))
    check("...nor one asked 2 of 7, which is a different test",
          "ollama:gemma4:e2b" not in ranked and "ollama:qwen3:14b" not in ranked,
          str(ranked))
    check("one complete sitting is not a comparison, so no winner is named",
          got["leader"] is None and not got["comparable"],
          f"leader={got['leader']} comparable={got['comparable']}")
    check("the incomplete pairings are reported as still owed",
          len(got["missing"]) == 3, str(len(got["missing"])))

    # ...and once two models have actually sat the whole thing, it ranks.
    got = standings_of(
        {"main": 1},
        [run("main", "ollama:a", 4, 7, 1, 2),
         run("main", "ollama:b", 1, 7, 1, 2)],
        ("ollama:a", "ollama:b"))
    check("two complete sittings do compare, and 4/7 beats 1/7",
          got["comparable"] and got["leader"] == "ollama:a", str(got["leader"]))

    print("7. a tie is reported as a tie, and no evidence as no evidence")
    got = standings_of({"alpha": 1},
                       [run("alpha", "ollama:a", 2, 7, 1, 2),
                        run("alpha", "ollama:b", 2, 7, 1, 2)],
                       ("ollama:a", "ollama:b"))
    check("ornith and qwen3 really are tied at 2/7 — naming either would be "
          "an artifact of sort order",
          got["comparable"] and got["leader"] is None, str(got["leader"]))
    got = standings_of({"alpha": 1}, [], ("ollama:a", "ollama:b"))
    check("nothing measured is 'not comparable', never a default winner",
          got["comparable"] is False and got["leader"] is None
          and len(got["missing"]) == 2, str(got))

    print("7b. a held eval slot stops the night, it does not consume it")
    # Measured 2026-08-04. Another process booting the app reaped run 1's ROW
    # while it was still executing — it later recorded failed (2/6), so it
    # had never died — and _await_run, which watches the row, returned while
    # the in-process guard start() actually checks was still held. `continue`
    # never yields, so models 2-6 were refused in one scheduling window: ran
    # 1, skipped 5. The row and the guard are two different facts, and the
    # loop was watching the wrong one.
    from app import eval_runs, settings_store

    real_busy, real_start = eval_runs.busy, eval_runs.start
    real_setting = settings_store.get
    started: list = []

    async def _start(suite, model, repeat):
        started.append(model)
        raise AssertionError("start() must not be reached while held")

    eval_runs.busy = lambda: "run-that-never-let-go"
    eval_runs.start = _start
    settings_store.get = lambda k, *a, **kw: (
        1 if k == "evals.tournament_every_hours"
        else 3 if k == "evals.tournament_repeat" else real_setting(k, *a, **kw))
    real_pairing, real_slot = mt.next_pairing, mt._await_slot
    # FORCING A NIGHT DUE, the way the gate actually works now. This used to
    # set `mt._last_run = 0.0`, a module global holding time.monotonic() — the
    # very thing migration 093 removed, because monotonic() is seconds since
    # BOOT and a fresh process starts the counter at zero, so on any box up
    # longer than the interval the gate opened on the first tick after every
    # restart. Measured 2026-08-05: 177 launches in 48h, zero finishes.
    # Due-ness is now asked of the tournament_attempts ledger, so the stub is
    # "there has never been a night" plus a recorder that writes nothing.
    real_last, real_record = mt.last_attempt, mt._record_attempt

    async def _no_history():
        return None

    async def _record(outcome, **kw):
        recorded.append(outcome)

    recorded: list = []
    mt.last_attempt, mt._record_attempt = _no_history, _record

    async def _pairing():
        return ("alpha", ["ollama:a", "ollama:b", "ollama:c"])

    async def _slot(*a, **kw):        # the real one, minus the 120s wait
        return eval_runs.busy()

    mt.next_pairing, mt._await_slot = _pairing, _slot
    try:
        summary = asyncio.run(mt.maybe_run())
        check("start() is never called while the slot is held",
              started == [], str(started))
        check("...and all three are reported as skipped, naming the holder",
              summary and len(summary["skipped"]) == 3
              and "run-that-never-let-go" in summary["skipped"][0],
              str(summary and summary["skipped"]))
        # THE CLAIM IS WRITTEN BEFORE THE WORK, and a night that bought
        # nothing still counts as spent. Both halves matter: without the
        # first, a night that dies half way re-enters on the next tick and
        # spends another six hours of the box; without the second, a run of
        # held slots re-asks the same question every sixty seconds forever.
        check("the night was claimed before any model was tried",
              recorded and recorded[0] == "claimed", str(recorded))

        # And the durable gate holds: with that claim now in the ledger, a
        # second call inside the interval must do nothing at all. This is the
        # property the module global could not express — it survived a
        # restart only by accident of uptime, which is to say never.
        import datetime as dt

        async def _just_claimed():
            return {"at": dt.datetime.now(dt.timezone.utc), "outcome": "claimed"}

        mt.last_attempt = _just_claimed
        check("a second call inside the interval is refused by the ledger",
              asyncio.run(mt.maybe_run()) is None)
    finally:
        eval_runs.busy, eval_runs.start = real_busy, real_start
        mt.next_pairing, mt._await_slot = real_pairing, real_slot
        mt.last_attempt, mt._record_attempt = real_last, real_record
        settings_store.get = real_setting

    print("8. off is the default, and off means nothing happens")
    from app import settings_store
    real_get = settings_store.get
    settings_store.get = lambda k, *a, **kw: (
        0 if k == "evals.tournament_every_hours" else real_get(k, *a, **kw))
    try:
        check("maybe_run does nothing while the interval is 0",
              asyncio.run(mt.maybe_run()) is None)
    finally:
        settings_store.get = real_get

    print("9. it cannot promote or delete — there is no such code path")
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
