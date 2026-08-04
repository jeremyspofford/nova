"""Automation scheduler — Nova's autonomous heartbeat.

Ticks every 60s; runs due automations serially by handing each one's
instruction to its agent (the same runner chat uses). The kill switch is the
live `automations.enabled` setting — togglable from the UI, no restart.
"""

import asyncio
import logging
import time
from pathlib import Path
from datetime import datetime, timezone

from app import automations, instances, retention, settings_store, sysmon, trace
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
from app.llm import router as llm_router
from app.memory.memory import memory

log = logging.getLogger(__name__)

TICK_SECONDS = 60
_running = asyncio.Lock()


_last_backup: float = 0.0


async def _maybe_backup() -> None:
    """A scheduled snapshot, run by code rather than requested of a model.

    Deliberately NOT an automation. An automation hands an instruction to an
    agent, and an agent that declines, forgets, or narrates leaves the
    operator with a cheerful summary and no backup — the exact shape this
    codebase refuses everywhere else. Nothing here consults a model.

    Retention deletes old bundles only AFTER a new one has been written and
    verified, so a failing backup can never reduce how many you have.
    """
    global _last_backup
    hours = float(settings_store.get("backups.every_hours") or 0)
    if hours <= 0:
        return
    now = time.monotonic()
    if _last_backup and now - _last_backup < hours * 3600:
        return
    from app import backup_service, backup_snapshot
    ok, why = backup_service.store_available()
    if not ok:
        log.warning("scheduled backup skipped: %s", why)
        return
    _last_backup = now
    try:
        man = await backup_service.snapshot()
        log.info("scheduled backup: %s (%.1f MB)",
                 man["path"], man["bytes"] / 1e6)
    except backup_snapshot.SnapshotRefused as e:
        # A refusal is news: something on this stack is unaccounted for and
        # the operator is the only one who can classify it.
        log.error("scheduled backup REFUSED: %s", e)
        try:
            from app import notify
            await notify.send(f"Nova could not back up: {e}",
                              title="Backup refused", tags=["warning"])
        except Exception:
            log.exception("could not notify about the refused backup")
        return
    except Exception:
        log.exception("scheduled backup failed")
        return
    _prune_bundles()


def _prune_bundles() -> None:
    """Keep the newest N, delete the rest. Runs only after a good backup."""
    from app import backup_service
    keep = int(settings_store.get("backups.keep") or 7)
    bundles = backup_service.bundles()          # newest first
    for old in bundles[keep:]:
        try:
            Path(old["path"]).unlink()
            log.info("pruned old backup %s", old["path"])
        except OSError:
            log.exception("could not prune %s", old["path"])


async def run_one(automation: dict) -> tuple[bool, str]:
    """Execute a single automation. Returns (ok, summary)."""
    agent = await agent_registry.get_agent_by_name(automation["agent_name"])
    if not agent or not agent["enabled"]:
        return False, f"agent '{automation['agent_name']}' not found or disabled"

    # per-automation override for legitimately long jobs; NULL = global default
    timeout = (automation.get("timeout_seconds")
               or settings_store.get("automations.run_timeout_seconds"))
    final, errors = "", []

    async def consume():
        nonlocal final
        # one ledger trace per run — a timeout cancels consume(), which the
        # turn records as status=cancelled on its way out
        async with trace.turn(
                "automation", automation=automation["name"],
                model=llm_router.effective_model(agent["model"])) as t:
            async for event in agent_runner.run_agent(
                    agent, [{"role": "user", "content": automation["instruction"]}],
                    dispatch_depth=1, automation=automation["name"]):
                if event["type"] == "final":
                    final = event["text"]
                elif event["type"] == "error":
                    errors.append(event["error"])
                    t.set_error(event["error"])
                elif event["type"] == "activity":
                    log.info("automation[%s] %s %s", automation["name"],
                             event.get("kind"), event.get("name"))

    try:
        await asyncio.wait_for(consume(), timeout=timeout)
    except asyncio.TimeoutError:
        return False, f"timed out after {timeout}s"

    if errors and not final:
        return False, "; ".join(errors)[:500]
    return True, final.strip() or "(no report)"


async def tick():
    # every instance reports its own hardware — sampling is never gated
    await sysmon.maybe_sample()
    # keep the prompt's platform block warm HERE, so no chat turn ever
    # waits on a sidecar probe to build its prompt
    try:
        from app.agents import runner as agent_runner
        await agent_runner.warm_platform_facts()
    except Exception:
        log.exception('platform facts warm failed; the turn path falls back')
    # everything below is fleet-singleton work: exactly one instance may
    # run automations and prunes, or they double-run on a shared DB
    if not instances.is_leader():
        return
    await trace.maybe_prune()            # self-limits to once a day
    await sysmon.maybe_prune_samples()   # self-limits to daily
    await retention.maybe_prune()        # tool rows, consents, alerts, recs
    # BEFORE alert evaluation: retiring an instance clears its open alerts,
    # and doing it after would leave a red card standing for a whole tick.
    await sysmon.maybe_retire_instances() # self-limits to daily
    from app import secret_store
    await secret_store.maybe_nudge_rotation()  # self-limits to daily
    await sysmon.maybe_evaluate_alerts() # de-dupes via open alert rows
    await _maybe_backup()                # self-limits to backups.every_hours
    # Ranks the local models against the stalest suite. Off by default, and it
    # only ever RECORDS — no binding is swapped and no model is deleted, for
    # the reason in model_tournament's docstring: the same model has scored
    # 2/7 and 3/7 on consecutive runs of the same suite.
    try:
        from app import model_tournament
        await model_tournament.maybe_run()
    except Exception:  # noqa: BLE001 — a tournament never costs the tick
        log.exception("model tournament failed")
    if not settings_store.get("automations.enabled"):
        return
    if _running.locked():
        return  # previous tick still working; skip
    async with _running:
        for automation in await automations.due():
            log.info("Automation due: %s (agent=%s)",
                     automation["name"], automation["agent_name"])
            started = datetime.now(timezone.utc)
            ok, summary = await run_one(automation)
            outcome = await automations.record_run(
                automation["id"], "ok" if ok else "failed", summary,
                automation["interval_minutes"], failed=not ok,
                started_at=started)
            # failures land in the journal too — Nova's own memory must hold
            # a trace of her automations breaking, not just docker logs
            if not ok and outcome != "auto_disabled":
                try:
                    await memory.write(
                        f"Automation '{automation['name']}' run FAILED: "
                        f"{summary[:300]}",
                        type="journal", source_type="automation")
                except Exception:
                    log.exception("journal write for failed automation failed")
            if ok and "nothing stale" not in summary.lower():
                try:
                    await memory.write(
                        f"Automation '{automation['name']}' ran: {summary[:600]}",
                        type="journal", source_type="automation")
                except Exception:
                    log.exception("journal write for automation failed")
            if outcome == "auto_disabled":
                try:
                    await memory.write(
                        f"Automation '{automation['name']}' was auto-disabled after "
                        f"5 consecutive failures. Last error: {summary[:300]}",
                        type="journal", source_type="automation")
                except Exception:
                    pass
                # reach the operator even if the app is closed — an automation
                # silently disabling itself is exactly the "you'd never know"
                # case notifications exist for (roadmap #21). Best-effort: a
                # no-op unless notifications are configured, never blocks the tick.
                try:
                    from app import notify
                    await notify.send(
                        f"'{automation['name']}' turned itself off after 5 "
                        f"straight failures. Last error: {summary[:200]}",
                        title="Automation auto-disabled", priority="high",
                        tags=["warning"])
                except Exception:
                    log.exception("failure notification for auto-disabled automation failed")
            log.info("Automation %s: %s — %.120s",
                     automation["name"], "ok" if ok else "FAILED", summary)


async def loop():
    log.info("Automation scheduler started (tick %ds)", TICK_SECONDS)
    while True:
        try:
            await tick()
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("scheduler tick failed; continuing")
        await asyncio.sleep(TICK_SECONDS)
