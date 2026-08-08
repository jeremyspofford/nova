""""Green" has to include "did not get worse at being Nova".

    docker compose exec -T backend python tests/eval_floor.py
    docker compose exec -T backend python tests/eval_floor.py --ratchet

ROADMAP #47 rail 2. `docs/plans/autonomous-improvement.md`:

    The sandbox today builds, boots, imports prod data, and runs the unit +
    e2e suites. It never runs the eval suites, so a candidate can pass every
    test and still be measurably worse at being Nova.

This is the fifth sandbox stage. `inference-control/server.py` runs it inside
the candidate stack, after the unit suite and the browser suite, and reads the
one machine-readable line it prints. It is NOT a `test_*.py` — `run_all.py`
globs that pattern and this costs model tokens and minutes, so it is opt-in the
same way `drill_backup_apply.py` beside it is.

THE FLOOR IS A RATCHET, modelled exactly on `coverage_floor.json`: it records
the best score each suite has honestly reached, a run fails if a change drops
below it, and it only ever moves UP. `--ratchet` writes measured scores in and
REFUSES to write a lower one — a floor someone can quietly lower reads as green
while eroding, so lowering it has to be a visible diff in git, made by hand,
with a reason in the commit.

THREE VERDICTS, AND THE THIRD IS THE ONE THAT MATTERS

    ok           every floored suite met its floor
    below        a suite scored under its floor — a measured regression
    unmeasured   the stage ran and could not measure

`unmeasured` is NOT a pass. The sandbox excludes the four credential tables by
design (`_SANDBOX_EXCLUDE`), so `llm_providers` is empty inside it and every
cloud model reads as unconfigured; there is one 24GB GPU on this box, shared
with whisper, and the sandbox stack does not start ollama at all. So today the
honest answer inside a sandbox is usually "I could not reach a model", and the
whole design of this file is that that answer is REPORTED rather than rounded
to green. `code_change` refuses an autonomous landing on anything but `ok`, and
an operator-approved landing is unaffected — he read the diff.

An empty floor file is `unmeasured` for the same reason. Floors are seeded by
running `--ratchet` on a machine that can reach the models; inventing numbers
here would be a gate calibrated against nothing.
"""

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, "/app/backend")

HERE = Path(__file__).parent
FLOOR_FILE = HERE / "eval_floor.json"

#: The line `inference-control` greps out of the stage's stdout. One line, one
#: JSON object, so the sidecar never has to parse prose — and it is printed
#: even on the failure paths, because a stage that fails silently is
#: indistinguishable from one that did not run.
MARKER = "EVAL_FLOOR_RESULT "

OK, BELOW, UNMEASURED = "ok", "below", "unmeasured"
#: 0 clean, 1 a measured regression, 3 could not measure. Distinct because the
#: caller treats them differently: 1 is a verdict about the code, 3 is a
#: verdict about the machine, and collapsing them would let a missing API key
#: read as a bad change.
EXIT = {OK: 0, BELOW: 1, UNMEASURED: 3}


def read_floors() -> dict:
    try:
        doc = json.loads(FLOOR_FILE.read_text())
    except FileNotFoundError:
        return {}
    except ValueError as e:
        # A corrupt floor file is not "no floors" — it is a gate that cannot
        # say what it is enforcing, and it fails loudly.
        raise SystemExit(f"{FLOOR_FILE} is not valid JSON: {e}")
    return {k: float(v) for k, v in (doc.get("suites") or {}).items()}


def write_floors(scores: dict, previous: dict) -> list[str]:
    """Raise floors to the measured scores. Never lowers one. Returns the moves."""
    moves = []
    merged = dict(previous)
    for suite, score in sorted(scores.items()):
        old = previous.get(suite)
        if old is not None and score <= old:
            continue
        merged[suite] = round(score, 4)
        moves.append(f"{suite}: {old if old is not None else '(new)'} -> "
                     f"{round(score, 4)}")
    doc = {
        "_comment": (
            "Eval floors — ROADMAP #47 rail 2. Fraction of gradeable tasks a "
            "suite must pass. A RATCHET: raised by `python "
            "tests/eval_floor.py --ratchet` after an honest measurement, and "
            "lowered ONLY by hand, in a commit that says why."),
        "suites": merged,
    }
    FLOOR_FILE.write_text(json.dumps(doc, indent=2) + "\n")
    return moves


async def _bootstrap() -> None:
    """Everything the harness needs that main.py's lifespan would have done.

    `providers.warm()` is not optional: `is_configured()` reads a cache only
    warm() fills, so with a cold cache every cloud model looks unconfigured
    and this would report `unmeasured` for a reason that is not true.
    """
    from app import db, rules, settings_store
    from app.llm import providers
    await db.init_pool()
    await settings_store.warm()
    await providers.warm()
    await rules.warm()


async def _model_for(suite) -> tuple[str, str]:
    """(model, why-not) for a suite — DERIVED from the agent it grades.

    Never a constant. Every suite declares the agent it is about, and that
    agent's row carries the model it actually runs on, so a suite is measured
    against the model that would really answer — including after a
    `model.assign` card moves one.
    """
    from app.agents import registry as agent_registry
    from app.llm import router as llm_router

    agent = await agent_registry.get_agent_by_name(suite.agent)
    if not agent:
        return "", f"no agent named {suite.agent!r}"
    model = (agent.get("model") or "").strip()
    if not model:
        return "", f"agent {suite.agent!r} has no model assigned"
    if ":" not in model:
        return "", (f"agent {suite.agent!r} runs on {model!r}, which carries "
                    f"no provider slug")
    effective = llm_router.effective_model(model)
    if effective != model:
        # The exact trap `run_task` refuses: an unconfigured provider is
        # silently swapped for the local fallback, so a "measurement" would be
        # of a different model entirely. Inside the sandbox this is the normal
        # case, because llm_providers is deliberately not imported.
        return "", (f"{model} resolves to {effective} — its provider is not "
                    f"configured here, so this would grade the fallback")
    return model, ""


async def _run_suite(name: str, scratch: Path) -> dict:
    """Score one suite: passed / gradeable, or a reason it could not be scored."""
    from app.evals import checks
    from app.evals import runner as eval_runner
    from app.evals import suites as suite_mod

    suite = suite_mod.load_suite(name)
    model, why_not = await _model_for(suite)
    if not model:
        return {"suite": name, "measured": False, "reason": why_not}

    total = passed = gradeable = 0
    failures: list[str] = []
    errors: list[str] = []
    for task in suite_mod.load_tasks(suite):
        total += 1
        try:
            result = await eval_runner.run_task(
                task, model, label="candidate", scratch_root=scratch)
        except Exception as e:                               # noqa: BLE001
            errors.append(f"{task.ref}: {type(e).__name__}: {e}"[:300])
            continue
        if not result.gradeable:
            # A task the model was never actually asked — a refused tool, a
            # prompt over the window — is not a wrong answer, and counting it
            # as one turns a fact about the machine into a verdict about the
            # code. `eval_runs._execute` draws the same line.
            errors.extend(result.errors[:2])
            continue
        gradeable += 1
        report = checks.evaluate(task.contract, result)
        if report.passed:
            passed += 1
        else:
            failures.extend(f"{task.ref}: {f}" for f in report.failures[:3])

    if not gradeable:
        return {"suite": name, "measured": False, "tasks": total,
                "reason": ("no task in this suite could be graded — the model "
                           "was never reached. " + ("; ".join(errors[:3])
                                                    or "no reason recorded"))}
    return {"suite": name, "measured": True, "model": model, "tasks": total,
            "gradeable": gradeable, "passed": passed,
            "score": round(passed / gradeable, 4),
            "failures": failures[:8]}


async def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="eval_floor")
    ap.add_argument("--ratchet", action="store_true",
                    help="raise the floors to what was just measured "
                         "(never lowers one)")
    ap.add_argument("--suite", action="append", default=None,
                    help="measure only these suites (default: every suite "
                         "that has a floor, or every suite under --ratchet)")
    args = ap.parse_args(argv)

    from app.evals import suites as suite_mod

    floors = read_floors()
    if args.suite:
        names = list(args.suite)
    elif args.ratchet:
        names = suite_mod.list_suites()
    else:
        names = sorted(floors)

    if not names:
        out = {"state": UNMEASURED, "suites": [],
               "detail": (f"no eval floors are set ({FLOOR_FILE.name} lists no "
                          f"suites), so nothing was measured. Seed them from a "
                          f"machine that can reach the models: "
                          f"`python tests/eval_floor.py --ratchet`.")}
        print(out["detail"])
        print(MARKER + json.dumps(out))
        return EXIT[UNMEASURED]

    scratch = Path(tempfile.mkdtemp(prefix="nova-evalfloor-"))
    results = []
    try:
        await _bootstrap()
        for name in names:
            print(f"\n=== {name}")
            r = await _run_suite(name, scratch)
            results.append(r)
            if r["measured"]:
                floor = floors.get(name)
                print(f"    {r['passed']}/{r['gradeable']} gradeable task(s) "
                      f"passed on {r['model']} — score {r['score']}"
                      + (f", floor {floor}" if floor is not None else
                         ", no floor set"))
                for f in r["failures"]:
                    print(f"      x {f}")
            else:
                print(f"    NOT MEASURED — {r['reason']}")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
        try:
            from app import db
            await db.close_pool()
        except Exception:                                    # noqa: BLE001
            pass

    measured = {r["suite"]: r["score"] for r in results if r["measured"]}
    unmeasured = [r for r in results if not r["measured"]]

    if args.ratchet:
        moves = write_floors(measured, floors)
        print("\nfloors raised:" if moves else "\nno floor moved")
        for m in moves:
            print(f"  {m}")
        if unmeasured:
            # A ratchet run that could not measure everything must not read as
            # a full calibration. The suites it did measure are written; the
            # ones it could not are named, loudly.
            print(f"\n{len(unmeasured)} suite(s) could not be measured and "
                  f"have NO floor from this run:")
            for r in unmeasured:
                print(f"  {r['suite']}: {r['reason']}")

    # THE VERDICT. Order matters: a measured regression outranks an
    # unmeasured suite, because "this change made something worse" is a
    # stronger fact than "something else could not be checked".
    breaches = [(r["suite"], r["score"], floors[r["suite"]])
                for r in results
                if r["measured"] and r["suite"] in floors
                and r["score"] < floors[r["suite"]]]
    floored_and_measured = [r for r in results
                            if r["measured"] and r["suite"] in floors]

    if breaches:
        state = BELOW
        detail = "; ".join(f"{s}: {sc} < floor {fl}" for s, sc, fl in breaches)
    elif not floored_and_measured:
        state = UNMEASURED
        detail = ("nothing with a floor could be measured — "
                  + "; ".join(f"{r['suite']}: {r['reason']}"
                              for r in unmeasured)[:600]
                  or "no floored suite was run")
    elif unmeasured:
        # Some floors held and others could not be checked. NOT ok: a partial
        # measurement presented as a pass is the shape this whole file exists
        # to refuse.
        state = UNMEASURED
        detail = (f"{len(floored_and_measured)} floored suite(s) held, but "
                  + "; ".join(f"{r['suite']}: {r['reason']}"
                              for r in unmeasured)[:500])
    else:
        state = OK
        detail = (f"{len(floored_and_measured)} floored suite(s) at or above "
                  + ", ".join(f"{r['suite']} {r['score']}>={floors[r['suite']]}"
                              for r in floored_and_measured))

    out = {"state": state, "detail": detail,
           "scores": measured, "floors": floors,
           "suites": [{k: v for k, v in r.items() if k != "failures"}
                      for r in results]}
    print(f"\nEVAL FLOOR: {state.upper()} — {detail}")
    print(MARKER + json.dumps(out))
    return 0 if args.ratchet else EXIT[state]


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
