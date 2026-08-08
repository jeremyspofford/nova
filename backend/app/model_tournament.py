"""Rank the local models against the suites, on a schedule, without asking.

docs/plans/model-tournament.md, phase 1. Jeremy: *"maybe nova should run
nightly tests of new local llms nightly."*

WHAT THIS DOES NOT DO, first, because it is the design: it never promotes,
never swaps a binding and never deletes a model. It builds evidence. Phase 2
turns evidence into a card the operator clicks.

That restraint is measured, not cautious. `ornith:9b` scored 2/7 and then 3/7
on consecutive runs of the same suite, and the task that flipped was a coin at
1/3. `ornith:9b` and `qwen3:8b` are tied at 2/7 over three repeats each. A
loop that promoted on those numbers would promote whichever model ran on a
lucky night — and with 34 GB of models against 832 GB free, nothing is
forcing the decision anyway.

MECHANICAL, and deliberately so. Nothing here asks a model which model is
best: the rotation is "whichever suite has the stalest coverage", the field is
"every installed local model", and the verdict is the contract. The only part
of this feature that needs judgment is deciding what is worth DOWNLOADING,
which is phase 4 and proposes rather than acts.

Three things make a recorded score comparable, and all three now exist:
`suite_version` (migration 086), `repeat_count` (same), and a suite that can
answer every tool its agent holds (`test_eval_servability.py`). Without the
last one a tournament ranks artifacts — fixing it in `main` alone turned
glm-5.2 from FAILED into 3/3.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from typing import Optional

log = logging.getLogger(__name__)

# Three, because at one this suite disagreed with itself. A task counts as
# passed only if it passed every repeat, so the cost buys a number that does
# not move when nothing changed.
DEFAULT_REPEAT = 3

# In-process single-flight. The DURABLE half of the gate is the
# tournament_attempts row (migration 093); this only stops two ticks in one
# backend overlapping, which the tick's own await used to prevent for free
# before the night moved off it.
_night = asyncio.Lock()


async def _installed_local() -> list[str]:
    """Every local model on this box, as `ollama:<name>`.

    Derived from what ollama actually has, so pulling one puts it in the next
    tournament with no edit here, and removing one drops it out.
    """
    from app import models_catalog
    return [f"ollama:{m['name']}" for m in await models_catalog._ollama_models()]


async def next_pairing() -> Optional[tuple[str, list[str]]]:
    """(suite, models) for tonight — the suite whose coverage is stalest.

    Rotating on staleness rather than a fixed order means the rotation
    actually rotates, and a suite that has never been run at its CURRENT
    version sorts first. Comparing against the current version is the point: a
    score recorded before the suite moved describes a different set of tasks,
    so it is not coverage.

    THE FIELD IS EVERY INSTALLED LOCAL MODEL, for every suite. That was
    narrowed once — a cloud-bound agent's suite ran the install standby alone,
    on the argument that ranking six models against guardian measures a
    configuration nobody deploys — and the narrowing was wrong in a way worth
    recording, because the argument sounded right:

    * It made the standby UNIMPROVABLE. Eleven of twelve agents are cloud, so
      eleven of twelve suites entered exactly one model: the incumbent. A
      challenger cannot out-score a model it is never run against, so the
      standby would have been defended by never being tested — a declared
      choice wearing measurement's clothes, which is the thing this file
      exists to avoid.
    * It asked the deployment question about the wrong subject. "Does anyone
      deploy THIS model on THIS agent?" is not the test; "does anyone deploy A
      LOCAL model on this agent?" is. The answer is yes for every agent,
      because the standby stands in for all of them the moment a provider
      fails — which happened on an HTTP 402 the day this was written.
    * The choice it informs is ONE choice, not eight. There is one `main`
      binding and one install-wide standby, and no way to bind a different
      local model per agent for the degraded path. "Which model is best at
      guardian" is a question nobody can act on. Jeremy, 2026-08-04: *"we can
      find the best local model that, if we have to choose one local llm,
      would be the best across all."* That needs the same field everywhere —
      see `standings()`.

    Cost is why the narrowing was tempting and why it was not needed: one
    suite runs per night, so a night is |field| runs either way. Six models ×
    3 repeats at ~1.5–2.9 min a pass is roughly 30–55 minutes, all of it
    local and none of it billed. The full 8-suite rotation is 48 runs spread
    over 48 nights of ordinary sleep, not 48 runs in one.
    """
    from app import db
    from app.evals import suites as suite_mod

    installed = await _installed_local()
    if not installed:
        log.info("tournament: no local models installed, nothing to rank")
        return None

    best: Optional[tuple[float, str]] = None
    async with db.acquire() as conn:
        for name in suite_mod.list_suites():
            try:
                suite = suite_mod.load_suite(name)
            except Exception:  # noqa: BLE001 — one broken suite is not the fleet
                log.warning("tournament: suite %s will not load", name)
                continue
            # 'error' counts as an ATTEMPT here, though never as a score.
            # A suite nothing can currently grade — every model refused on a
            # prompt over its window — would otherwise never gain coverage,
            # and the rotation would park on it forever while the other seven
            # went unmeasured. Trying and failing is still a turn taken.
            row = await conn.fetchrow(
                "SELECT max(started_at) AS newest FROM eval_runs "
                " WHERE suite = $1 AND suite_version = $2 "
                "   AND status IN ('passed','failed','error')",
                name, suite.version)
            newest = row["newest"] if row else None
            # never measured at this version sorts first, and stays first
            age = -1.0 if newest is None else -newest.timestamp()
            if best is None or age > best[0]:
                best = (age, name)
    return (best[1], installed) if best else None


async def standings(min_repeat: Optional[int] = None) -> dict:
    """If you had to keep ONE local model, which one — measured, across suites.

    The nightly job records a score per (suite, model). This is the only place
    that adds them up, and adding up is where a ranking usually starts lying,
    so every rule here exists to stop a specific over-reading:

    * **The basis is the suites that can tell two models apart, and a model
      is ranked only if it was measured across all of it.** Nothing else is
      apples-to-apples: a model measured on `main` alone cannot be compared
      against one measured on `main` and `guardian`, and averaging their rates
      anyway ranks the least-tested model first roughly as often as not.
      Pairings outside the basis are reported as `missing`, never folded in.
    * **Only at the suite's CURRENT version.** A score from before the suite
      moved describes a different set of tasks. Same rule `next_pairing` uses
      to decide coverage, for the same reason.
    * **Only runs of `min_repeat` or more.** One draw is not a measurement:
      `ornith:9b` scored 2/7 and then 3/7 on consecutive runs of the same
      suite, and the task that flipped was a coin at 1/3. A manual `repeat=1`
      row must not be able to crown anything.
    * **A leader needs a margin — and a tie is reported as a tie.** At the
      time of writing `ornith:9b` and `qwen3:8b` are tied 2/7 over three
      repeats each. The honest answer there is "no winner", not whichever
      sorts first.

    Returns `comparable: False` — with the pairings still owed — until at
    least two models have been measured across the whole basis, which is the
    normal state early in a rotation. It never invents a winner from a thin
    basis: a gauge that does that gets switched off the first time it is
    confidently wrong, the same way a grounding check that eats good
    summaries gets switched off.
    """
    from app import db, eval_runs, settings_store
    from app.evals import suites as suite_mod

    if min_repeat is None:
        min_repeat = int(settings_store.get("evals.tournament_repeat")
                         or DEFAULT_REPEAT)

    installed = await _installed_local()
    versions: dict[str, int] = {}
    for name in suite_mod.list_suites():
        try:
            versions[name] = suite_mod.load_suite(name).version
        except Exception:  # noqa: BLE001 — one broken suite is not the fleet
            log.warning("standings: suite %s will not load", name)

    # Whether anything will ever pay the owed pairings off. The panel says
    # "the nightly rotation is what pays them off", and with the tournament
    # switched off that sentence is a promise nothing keeps — derived from
    # the same setting maybe_run() gates on, so it cannot drift from it.
    rotation_enabled = float(
        settings_store.get("evals.tournament_every_hours") or 0) > 0

    empty = {"min_repeat": min_repeat, "installed": installed,
             "basis": [], "comparable": False, "table": [],
             "missing": [], "leader": None,
             "coverage_reset": [], "rotation_enabled": rotation_enabled}
    if not installed or not versions:
        return empty

    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT suite, model, tasks_passed, tasks_total, started_at, "
            "       repeat_count, suite_version "
            "  FROM eval_runs "
            " WHERE status IN ('passed','failed') AND model = ANY($1::text[]) "
            "   AND repeat_count >= $2 "
            # Only a run the model actually SAT. A task refused before it
            # reached the model still counts in tasks_total, so a partially
            # asked run is not the same test as a complete one — measured
            # 2026-08-04, when six models were ranked on denominators of 0,
            # 2, 6 and 7 questions and the two that were never asked anything
            # came last at 0%. NULL is pre-migration-087 and unknowable, so
            # it is excluded rather than assumed complete.
            #
            # THE CLAUSE IS NO LONGER TYPED HERE. It is the SQL half of
            # `eval_runs.outcome()`'s MEASURED reading — the one that decides
            # what the panel renders and what the finished-run notification
            # says — and two copies of this predicate is how a run comes to
            # be announced as a 2/7 measurement while the board silently
            # refuses to rank it. One definition, both callers.
            f"   AND {eval_runs.MEASURED_WHERE} "
            " ORDER BY started_at DESC", installed, min_repeat)

    # Newest row per (suite, model) that is actually comparable. The version
    # test sits INSIDE the loop rather than in the SQL because the current
    # version differs per suite — filtering first and de-duplicating second
    # would let a newer run at a stale version mask an older run at the
    # current one, which is the one that counts.
    newest: dict[tuple[str, str], dict] = {}
    for r in rows:                       # rows arrive newest-first
        key = (r["suite"], r["model"])
        if key in newest or versions.get(r["suite"]) != r["suite_version"]:
            continue
        newest[key] = dict(r)

    # A suite earns its place in the basis once it can tell two models apart.
    # The first cut of this asked for ALL installed models, which reads as the
    # stricter rule and is actually the more fragile one: pulling a seventh
    # model emptied the basis and threw away a clean six-way comparison until
    # the rotation came round again — and proposing pulls is phase 4 of this
    # same plan, so that is the normal case, not an edge one. Two is the
    # threshold at which a suite carries information about which model to
    # keep; below it there is nothing to compare.
    covered_by = {s: {m for m in installed if (s, m) in newest} for s in versions}
    basis = sorted(s for s, models in covered_by.items() if len(models) >= 2)

    table = []
    for m in installed:
        # Ranked means measured across the WHOLE basis. A model measured on
        # part of it is carried with its coverage rather than being averaged
        # in over fewer suites, which would flatter it.
        ranked = bool(basis) and all((s, m) in newest for s in basis)
        passed = sum(newest[(s, m)]["tasks_passed"] for s in basis) if ranked else 0
        total = sum(newest[(s, m)]["tasks_total"] for s in basis) if ranked else 0
        table.append({
            "model": m,
            "ranked": ranked,
            "passed": passed,
            "total": total,
            "pass_rate": (passed / total) if total else None,
            "suites": len(basis) if ranked else 0,
            # what this model has been measured on AT ALL, so an unranked one
            # shows how close it is rather than just being absent
            "covered": sorted(s for s in versions if (s, m) in newest),
        })
    table.sort(key=lambda r: (not r["ranked"], -(r["pass_rate"] or 0.0), r["model"]))

    # Two ranked models or it is not a comparison. One model measured across
    # the basis is a score, and calling it "best" would be true only in the
    # sense that it is the only one.
    ranked_rows = [r for r in table if r["ranked"]]
    comparable = len(ranked_rows) >= 2

    # A leader must beat the runner-up on BOTH the rate and the raw task
    # count. The two only disagree if the recorded totals differ across models
    # on the same basis — which should not happen, and if it does the
    # comparison is not sound enough to name a winner from.
    leader = None
    if comparable \
            and (ranked_rows[0]["pass_rate"] or 0) > (ranked_rows[1]["pass_rate"] or 0) \
            and ranked_rows[0]["passed"] > ranked_rows[1]["passed"]:
        leader = ranked_rows[0]["model"]

    # SAY when an empty board is a RESET, not an absence. Bumping a suite's
    # version voids every recorded run of it — deliberately, a score against
    # v8 does not describe v12 — but the board it leaves behind used to look
    # exactly like one where nothing had ever been measured: comparable=false,
    # covered=[] for every model, ~48 nights of rotation silently re-owed.
    # An empty board that cannot say WHY it is empty is the "fallback that
    # reads as success" failure. Derived per suite from the same rows-vs-
    # current-version comparison the basis uses, never from a maintained list.
    coverage_reset = []
    for s, current in sorted(versions.items()):
        if any((s, m) in newest for m in installed):
            continue                     # has coverage at the current version
        stale = [r for r in rows if r["suite"] == s]
        if not stale:
            continue                     # never measured at all — a true absence
        stale_versions = {r["suite_version"] for r in stale}
        coverage_reset.append({
            "suite": s,
            "version": current,
            # NULL suite_version rows are pre-086: measured, version unknown
            "measured_versions": sorted(
                (v for v in stale_versions if v is not None), reverse=True),
            "runs_voided": len(stale),
            "last_measured": max(r["started_at"] for r in stale),
        })

    return {
        "min_repeat": min_repeat,
        "installed": installed,
        "basis": basis,
        "comparable": comparable,
        "table": table,
        "missing": [{"suite": s, "model": m}
                    for s in sorted(versions) for m in installed
                    if (s, m) not in newest],
        "leader": leader,
        "coverage_reset": coverage_reset,
        "rotation_enabled": rotation_enabled,
    }


async def last_attempt() -> Optional[dict]:
    """The most recent tournament night claimed, or None if there never was one.

    Read from the database rather than a module global, because the global
    measured UPTIME. `time.monotonic()` on Linux is seconds-since-boot and a
    fresh process starts the counter at 0.0, so on any box up longer than the
    interval the gate opened on the FIRST tick after every restart. Under
    `--reload` every source edit is a restart: 177 launches and zero finishes
    in the 48h before this was written. Migration 093 has the measurements.
    """
    from app import db
    try:
        async with db.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT at, outcome, suite, detail FROM tournament_attempts "
                " ORDER BY at DESC LIMIT 1")
    except Exception:  # noqa: BLE001 — a missing history is not a failed night
        log.exception("could not read the tournament attempt history")
        return None
    return dict(row) if row else None


async def _record_attempt(outcome: str, *, suite: Optional[str] = None,
                          detail: Optional[str] = None) -> None:
    """Write the night down. Best effort — a night that ran is not undone by
    failing to record it — but see the caller: the CLAIM is checked, because a
    claim that silently failed to persist would re-enter on the next tick."""
    from app import db
    async with db.acquire() as conn:
        await conn.execute(
            "INSERT INTO tournament_attempts (outcome, suite, detail) "
            "VALUES ($1,$2,$3)", outcome, suite, detail)


async def maybe_run() -> Optional[dict]:
    """One tournament night, if one is due. Spawned OFF the scheduler tick.

    Gated on a setting so it can be turned off without editing code. Returns a
    summary or None when nothing ran.

    NOT awaited by the tick any more. A night is six models with a 3600s
    ceiling each, and it used to sit on the critical path of a 60-second
    heartbeat: everything below it in `tick()` — the whole automation body —
    never ran again for the life of the process. See migration 093.

    Two guards, because they answer different questions. `_night` is
    in-process and stops two ticks in ONE backend overlapping; the attempt row
    is durable and stops a RESTART re-arming the interval. Neither substitutes
    for the other.
    """
    from app import eval_runs, settings_store

    every_hours = float(settings_store.get("evals.tournament_every_hours") or 0)
    if every_hours <= 0:
        return None                       # off, and off is the default
    if _night.locked():
        return None                       # this process is already running one

    async with _night:
        # DUE? Asked of the attempt history, not of a module global — the
        # `_maybe_backup` pattern, for the reason migration 089 records.
        last = await last_attempt()
        if last and last.get("at"):
            age = (dt.datetime.now(dt.timezone.utc) - last["at"]).total_seconds()
            if age < every_hours * 3600:
                return None

        pairing = await next_pairing()
        if not pairing:
            # Still a claim. Nothing being due is a fact about tonight, and
            # without recording it the gate reopens on the very next tick and
            # re-asks a question whose answer has not changed.
            await _record_attempt("nothing_due")
            return None
        suite, models = pairing

        # Claim the slot BEFORE the work, so a night that dies half way does
        # not re-enter on the next tick and spend another six hours of the
        # box. Deliberately NOT best-effort: if this write fails the interval
        # is unenforceable, and running anyway is how 177 launches happened.
        try:
            await _record_attempt("claimed", suite=suite)
        except Exception:  # noqa: BLE001
            log.exception("tournament: could not claim the night — not running")
            return None
        return await _run_night(suite, models, eval_runs, settings_store)


async def _run_night(suite: str, models: list[str], eval_runs,
                     settings_store) -> Optional[dict]:
    """The night itself, once it has been claimed. Split out so the claim and
    the work are separately readable — the claim is the control."""
    repeat = int(settings_store.get("evals.tournament_repeat") or DEFAULT_REPEAT)

    log.info("tournament: %s against %d local model(s), repeat=%d",
             suite, len(models), repeat)
    done, skipped = [], []
    for model in models:
        # Wait for the SLOT, not just the row. Measured 2026-08-04: another
        # process booting the app reaped a LIVE run's row — it was executing
        # the whole time and went on to record failed (2/6) — so `_await_run`
        # saw a terminal row and returned while the in-process guard was
        # still genuinely held. Every remaining model was then refused in one
        # burst, because `continue` never yields. Ran 1, skipped 5.
        #
        # eval_runs.reconcile_orphans no longer lies like that, but the row
        # and the guard remain two different facts, and this waits on the one
        # `start` actually checks. A guard held by a task that died without
        # cleanup would otherwise cost every night, not one.
        held = await _await_slot()
        if held:
            log.warning("tournament: the eval slot is still held by %s — "
                        "skipping the rest of tonight rather than burning "
                        "through them", held)
            skipped.extend(f"{m}: eval slot held by {held}"
                           for m in models[models.index(model):])
            break
        try:
            run = await eval_runs.start(suite, model, repeat)
        except ValueError as e:
            # An eval already running, or a model that resolves to something
            # else. Both are reasons to skip THIS model, not to abandon the
            # night — and both are worth naming rather than swallowing.
            log.warning("tournament: skipped %s — %s", model, e)
            skipped.append(f"{model}: {e}")
            continue
        except Exception:  # noqa: BLE001
            log.exception("tournament: %s failed to start", model)
            skipped.append(f"{model}: failed to start")
            continue
        await _await_run(run["id"])
        done.append(model)
        # Before the next model loads, not after the night ends — the point
        # is that the NEXT one is sized against a free card.
        await _evict(model)

    summary = {"suite": suite, "repeat": repeat, "ran": done, "skipped": skipped}
    # The night finished. Recorded so the history says what a claim bought —
    # the claim row alone cannot tell "ran six" from "died on the first".
    try:
        await _record_attempt(
            "ok", suite=suite,
            detail=f"ran {len(done)}, skipped {len(skipped)}")
    except Exception:  # noqa: BLE001 — bookkeeping never undoes work that ran
        log.exception("tournament: could not record the finished night")
    log.info("tournament: finished %s — ran %d, skipped %d",
             suite, len(done), len(skipped))

    # Say what the night bought. A row filed is not an answer, and the
    # question the rotation exists to settle is which single local model to
    # keep — so it gets asked every night, including the nights when the
    # honest answer is "not yet, and here is what is still owed".
    try:
        table = await standings()
        summary["standings"] = table
        if table["leader"]:
            log.info("tournament: best local model over %d suite(s): %s",
                     len(table["basis"]), table["leader"])
        elif table["comparable"]:
            log.info("tournament: %d suite(s) comparable, no model ahead by a "
                     "margin — reporting a tie", len(table["basis"]))
        else:
            log.info("tournament: not comparable yet — %d pairing(s) still "
                     "owed before any model can be ranked",
                     len(table["missing"]))
    except Exception:  # noqa: BLE001 — a summary never fails the night's work
        log.exception("tournament: standings failed")
    return summary


async def _evict(model: str) -> None:
    """Drop a model from VRAM so the NEXT one is sized against a free card.

    This is the night's real cost, and it was invisible until the field
    widened. Ollama keeps a model resident for minutes after its last call,
    and the tournament runs six back to back at about that interval — so
    every model after the first loaded into a GPU still holding its
    predecessor. `local_context` then sized the window to whatever was left.

    Measured 2026-08-04, mid-night: 19.7 GB of a 24 GB card held by three
    models at once, two of them finished. Windows collapsed to 8,192 against
    models whose real limits are 32k-262k, and `main`'s 4,211-token prompt
    was refused by NINETEEN tokens — so four of six models were never asked
    anything, and the ranking that came out of it put two of them last on no
    evidence.

    Best effort by design: a model that will not evict is a slower night, not
    a failed one, and the window guard still refuses honestly if the next one
    ends up cramped.
    """
    import httpx

    from app import settings_store
    base = str(settings_store.get("inference.ollama_url") or "").rstrip("/")
    if not base or not model.startswith("ollama:"):
        return
    name = model.split(":", 1)[1]
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            # keep_alive=0 unloads immediately; an empty prompt does no work
            resp = await client.post(f"{base}/api/generate",
                                     json={"model": name, "keep_alive": 0})
            resp.raise_for_status()
        log.info("tournament: evicted %s from VRAM", model)
    except Exception:  # noqa: BLE001 — eviction is an optimisation, not a gate
        log.warning("tournament: could not evict %s; the next model will be "
                    "sized against whatever is left", model, exc_info=True)


async def _await_slot(poll_s: float = 2.0,
                      limit_s: float = 120.0) -> Optional[str]:
    """Wait for the eval slot to free. Returns None when it did, else the
    holder — so the caller can say WHICH run is in the way rather than
    reporting six identical refusals.

    Bounded, because a slot held by a task that died without running its
    cleanup never frees on its own, and a tournament that waits forever costs
    every night after it rather than one.
    """
    import asyncio

    from app import eval_runs
    deadline = time.monotonic() + limit_s
    while True:
        held = eval_runs.busy()
        if not held:
            return None
        if time.monotonic() >= deadline:
            return held
        await asyncio.sleep(poll_s)


async def _await_run(run_id: str, poll_s: float = 10.0,
                     limit_s: float = 3600.0) -> None:
    """Wait for one run to finish. Only one eval may run at a time, so the
    models are graded one after another rather than raced — and the ceiling
    means a wedged run costs one night, not every night after it."""
    import asyncio

    from app import db
    deadline = time.monotonic() + limit_s
    while time.monotonic() < deadline:
        async with db.acquire() as conn:
            status = await conn.fetchval(
                "SELECT status FROM eval_runs WHERE id = $1::uuid", run_id)
        if status != "running":
            return
        await asyncio.sleep(poll_s)
    log.warning("tournament: run %s still going after %.0fs — moving on",
                run_id, limit_s)
