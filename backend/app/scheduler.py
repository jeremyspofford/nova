"""Automation scheduler — Nova's autonomous heartbeat.

Ticks every 60s; runs due automations serially by handing each one's
instruction to its agent (the same runner chat uses). The kill switch is the
live `automations.enabled` setting — togglable from the UI, no restart.
"""

import asyncio
import logging
from datetime import datetime, timezone

from app import automations, settings_store, sysmon, trace
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
from app.llm import router as llm_router
from app.memory.memory import memory

log = logging.getLogger(__name__)

TICK_SECONDS = 60
_running = asyncio.Lock()


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
    await trace.maybe_prune()   # self-limits to once a day
    # fleet monitoring rides the same heartbeat, ahead of the automations
    # kill switch — an instance keeps reporting its hardware either way
    await sysmon.maybe_sample()
    await sysmon.maybe_prune_samples()   # leader-only, self-limits to daily
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
