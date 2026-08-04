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


async def field_for(suite_agent: str, installed: list[str],
                    standby: str) -> list[str]:
    """Which local models it is worth running THIS suite against.

    The suites are not interchangeable — guardian grades refusing an injected
    rule deletion, memory-curator grades deleting exactly the notes a subject
    spans, tool-creator grades refusing to widen its own reach. But they are
    each graded against their agent's REAL toolset, and only one agent on this
    install runs a local model at all. Ranking six local models against
    guardian measures a configuration nobody deploys, and that was most of the
    night's work.

    So the field is derived from what is actually bound:

      the suite's agent runs local   every installed model, because they are
                                     all candidates for that binding
      the suite's agent runs cloud   the install standby ONLY — it is the one
                                     local model that will ever run this
                                     agent, and it really will: it stands in
                                     for all eleven cloud agents the moment a
                                     provider fails, which happened today on
                                     an HTTP 402

    Derived, so moving an agent onto a local model puts its suite back in the
    full rotation with no edit here.
    """
    from app.agents import registry as agent_registry
    from app.llm import router as llm_router

    agent = await agent_registry.get_agent_by_name(suite_agent)
    if agent and llm_router.is_local(
            llm_router.effective_model(agent.get("model") or "")):
        return installed
    return [standby] if standby in installed else []


async def next_pairing() -> Optional[tuple[str, list[str]]]:
    """(suite, models) for tonight — the suite whose coverage is stalest.

    Rotating on staleness rather than a fixed order means the rotation
    actually rotates, and a suite that has never been run at its CURRENT
    version sorts first. Comparing against the current version is the point: a
    score recorded before the suite moved describes a different set of tasks,
    so it is not coverage.
    """
    from app import db, model_chain
    from app.evals import suites as suite_mod

    installed = await _installed_local()
    if not installed:
        log.info("tournament: no local models installed, nothing to rank")
        return None
    standby = model_chain.standby_setting()

    best: Optional[tuple[float, str, list[str]]] = None
    async with db.acquire() as conn:
        for name in suite_mod.list_suites():
            try:
                suite = suite_mod.load_suite(name)
            except Exception:  # noqa: BLE001 — one broken suite is not the fleet
                log.warning("tournament: suite %s will not load", name)
                continue
            field = await field_for(suite.agent, installed, standby)
            if not field:
                continue          # nothing local will ever run this agent
            row = await conn.fetchrow(
                "SELECT max(started_at) AS newest FROM eval_runs "
                " WHERE suite = $1 AND suite_version = $2 "
                "   AND status IN ('passed','failed')", name, suite.version)
            newest = row["newest"] if row else None
            # never measured at this version sorts first, and stays first
            age = -1.0 if newest is None else -newest.timestamp()
            if best is None or age > best[0]:
                best = (age, name, field)
    return (best[1], best[2]) if best else None


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
