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

import logging
import time
from typing import Optional

log = logging.getLogger(__name__)

# Three, because at one this suite disagreed with itself. A task counts as
# passed only if it passed every repeat, so the cost buys a number that does
# not move when nothing changed.
DEFAULT_REPEAT = 3

_last_run = 0.0


async def _installed_local() -> list[str]:
    """Every local model on this box, as `ollama:<name>`.

    Derived from what ollama actually has, so pulling one puts it in the next
    tournament with no edit here, and removing one drops it out.
    """
    from app import models_catalog
    return [f"ollama:{m['name']}" for m in await models_catalog._ollama_models()]


async def next_pairing() -> Optional[tuple[str, list[str]]]:
    """(suite, models) for tonight — the suite whose coverage is stalest.

    Rotating on staleness rather than a fixed order means eight nights covers
    everything, and a suite that has never been run at its CURRENT version
    sorts first. Comparing against the current version is the point: a score
    recorded before the suite moved describes a different set of tasks, so it
    is not coverage.
    """
    from app import db
    from app.evals import suites as suite_mod

    models = await _installed_local()
    if not models:
        log.info("tournament: no local models installed, nothing to rank")
        return None

    best: Optional[tuple[float, str]] = None
    async with db.acquire() as conn:
        for name in suite_mod.list_suites():
            try:
                version = suite_mod.load_suite(name).version
            except Exception:  # noqa: BLE001 — one broken suite is not the fleet
                log.warning("tournament: suite %s will not load", name)
                continue
            row = await conn.fetchrow(
                "SELECT max(started_at) AS newest FROM eval_runs "
                " WHERE suite = $1 AND suite_version = $2 "
                "   AND status IN ('passed','failed')", name, version)
            newest = row["newest"] if row else None
            # never measured at this version sorts first, and stays first
            age = -1.0 if newest is None else -newest.timestamp()
            if best is None or age > best[0]:
                best = (age, name)
    return (best[1], models) if best else None


async def maybe_run() -> Optional[dict]:
    """One tournament night, if one is due. Called from the scheduler tick.

    Self-limiting the same way every other job in that tick is, and gated on
    a setting so it can be turned off without editing code. Returns a summary
    or None when nothing ran.
    """
    global _last_run
    from app import eval_runs, settings_store

    every_hours = float(settings_store.get("evals.tournament_every_hours") or 0)
    if every_hours <= 0:
        return None                       # off, and off is the default
    if time.monotonic() - _last_run < every_hours * 3600:
        return None
    # Claim the slot BEFORE the work, so a run that dies half way does not
    # re-enter on the next tick and spend another hour of the box.
    _last_run = time.monotonic()

    pairing = await next_pairing()
    if not pairing:
        return None
    suite, models = pairing
    repeat = int(settings_store.get("evals.tournament_repeat") or DEFAULT_REPEAT)

    log.info("tournament: %s against %d local model(s), repeat=%d",
             suite, len(models), repeat)
    done, skipped = [], []
    for model in models:
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

    summary = {"suite": suite, "repeat": repeat, "ran": done, "skipped": skipped}
    log.info("tournament: finished %s — ran %d, skipped %d",
             suite, len(done), len(skipped))
    return summary


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
