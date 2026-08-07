"""Automation scheduler — Nova's autonomous heartbeat.

Ticks every 60s; runs due automations serially by handing each one's
instruction to its agent (the same runner chat uses). The kill switch is the
live `automations.enabled` setting — togglable from the UI, no restart.
"""

import asyncio
import logging
import datetime as dt
from pathlib import Path
from datetime import datetime, timezone

from app import (automations, bg, instances, notify, retention, settings_store,
                 sysmon, trace)
from app.agents import registry as agent_registry
from app.agents import runner as agent_runner
from app.llm import router as llm_router
from app.memory.memory import memory

log = logging.getLogger(__name__)

TICK_SECONDS = 60
_running = asyncio.Lock()


# NOTE: the backup interval used to live here as a module global and
# measured uptime rather than time — see _maybe_backup and migration 089.


async def _record_backup_failure(outcome: str, reason: str, *, title: str,
                                 lead: str) -> None:
    """Write down an attempt that produced no bundle, and say so ONCE.

    Guarantees the two halves stay together on every failing path. Recording
    is what `backup_service.freshness` and the operator's history read; the
    notification is what reaches him when the app is closed. Splitting them is
    how the crash branch came to record silently while a refusal on the same
    tick shouted: a60d8d7 (2026-08-04) gave the refusal branch a `news` check
    and a notify.send and gave the crash branch a bare record_attempt, so from
    the moment the attempt history existed the louder outcome was the one
    working as designed.

    Quiet on a repeat, by the same mechanism as before: `record_attempt`
    returns news only when the outcome or the reason CHANGED, so a standing
    condition notifies once rather than every interval — 76 backend starts and
    29 identical refusal notifications in the 24h of 2026-08-04 is what that
    costs. It never raises: a backup that failed is not made worse by failing
    to talk about it.
    """
    from app import backup_service
    news = await backup_service.record_attempt(outcome, reason=reason)
    if not news:
        log.info("...same backup %s as last time; not notifying again", outcome)
        return
    try:
        from app import notify
        await notify.send(f"{lead}: {reason}"[:400], title=title,
                          tags=["warning"])
    except Exception:
        log.exception("could not notify about the %s backup", outcome)


async def _maybe_backup() -> None:
    """A scheduled snapshot, run by code rather than requested of a model.

    Deliberately NOT an automation. An automation hands an instruction to an
    agent, and an agent that declines, forgets, or narrates leaves the
    operator with a cheerful summary and no backup — the exact shape this
    codebase refuses everywhere else. Nothing here consults a model.

    Retention deletes old bundles only AFTER a new one has been written and
    verified, so a failing backup can never reduce how many you have.
    """
    hours = float(settings_store.get("backups.every_hours") or 0)
    if hours <= 0:
        return
    from app import backup_service, backup_snapshot

    # DUE? Asked of the attempt history, not of a module global. The global
    # measured uptime: every restart reset it and re-armed the interval, and
    # under `--reload` every source edit is a restart. Measured 2026-08-04:
    # 76 backend starts in a day, 29 identical refusal notifications.
    last = await backup_service.last_attempt()
    if last and last.get("at"):
        age = (dt.datetime.now(dt.timezone.utc) - last["at"]).total_seconds()
        if age < hours * 3600:
            return

    ok, why = backup_service.store_available()
    if not ok:
        # Log-only was the whole problem. An unmounted bundle store stops
        # backups happening and wrote NO attempt row, so the one condition
        # that silences backups entirely was also the one condition no reader
        # could see — docker logs are not a surface Nova or the operator has.
        # Recorded as 'refused' because that is exactly what snapshot() raises
        # for this same `why`, so a repeat dedupes against itself; recording it
        # also puts the interval clock back in charge, instead of re-checking
        # an unmounted directory every 60 seconds forever.
        log.warning("scheduled backup skipped: %s", why)
        await _record_backup_failure("refused", why, title="Backup refused",
                                     lead="Nova could not back up")
        return
    # Before asking for room, give back what a killed run is still holding.
    backup_service.sweep_partials()
    try:
        man = await backup_service.snapshot()
        log.info("scheduled backup: %s (%.1f MB)",
                 man["path"], man["bytes"] / 1e6)
        await backup_service.record_attempt("ok", bundle=man["path"])
    except backup_snapshot.SnapshotRefused as e:
        # A refusal is news ONCE. Something on this stack is unaccounted for
        # and only the operator can classify it — but telling him the same
        # thing every interval is how he learns to dismiss the alert without
        # reading it, which costs the next, different refusal.
        log.error("scheduled backup REFUSED: %s", e)
        await _record_backup_failure("refused", str(e), title="Backup refused",
                                     lead="Nova could not back up")
        return
    except Exception as e:  # noqa: BLE001 — recorded, told, then dropped
        # An unexpected crash was the QUIETEST outcome here: the row was
        # written and the operator was never told, so a refusal — a control
        # working as designed — shouted while the snapshot code actually
        # breaking said nothing. Same dedupe as a refusal, so a crash that
        # repeats every interval still notifies once.
        log.exception("scheduled backup failed")
        await _record_backup_failure("error", str(e)[:500],
                                     title="Backup failed",
                                     lead="Nova's scheduled backup crashed")
        return
    _prune_bundles()
    # The off-machine copy, AFTER retention so it never copies a bundle the
    # prune is about to delete. Its failure never fails the backup — the
    # local bundle exists — but it goes in her journal, and offsite_state
    # keeps the gap standing in the failure nudge until a later pass heals.
    try:
        from app import backup_service
        off = await asyncio.to_thread(backup_service.offsite_sync)
        if off.get("copied"):
            log.info("off-machine copy: %s", ", ".join(off["copied"]))
        for err in off.get("errors", []):
            log.error("off-machine copy failed: %s", err)
        if off.get("errors"):
            try:
                await memory.write(
                    f"The off-machine backup copy FAILED: "
                    f"{'; '.join(off['errors'])[:300]} — bundles exist only "
                    f"on this machine until this heals.",
                    type="journal", source_type="automation")
            except Exception:
                log.exception("could not journal the offsite failure")
    except Exception:  # noqa: BLE001 — never the backup's problem
        log.exception("off-machine sync crashed")


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


# ── mechanical automations ────────────────────────────────────────────────
#
# A row whose `handler` names an entry here is run as CODE, never handed to
# an agent. This exists for jobs where the outcome must be a fact — the
# weekly restore drill proves a bundle restores, and an agent that declined,
# narrated, or summarised would leave the operator a cheerful sentence and
# no proof. Same reasoning as _maybe_backup below, but as a REAL schedule
# row: the operator can see it, move it to another night, toggle notify —
# and record_run, the run history, auto-disable and notify:true delivery all
# work unchanged because the scheduler cannot tell the difference after
# run_one returns.
#
# The column is written only by migrations (it is not in
# automations.UPDATABLE), so neither a model nor a stray PATCH can point the
# scheduler at code or quietly turn a mechanical job back into a prompt.


async def _restore_drill(automation: dict) -> tuple[bool, str]:
    from app import backup_service
    return await backup_service.drill(automation)


async def _heartbeat(automation: dict) -> tuple[bool, str]:
    # Mechanical about the CONTRACT, not the work: heartbeat.beat runs a
    # real agent turn, but the quiet/notify decision and the delivery are
    # code — which is exactly what the handler column is for.
    from app import heartbeat
    return await heartbeat.beat(automation)


MECHANICAL_HANDLERS: dict = {
    "restore_drill": _restore_drill,
    "heartbeat": _heartbeat,
}


async def run_one(automation: dict) -> tuple[bool, str]:
    """Execute a single automation. Returns (ok, summary)."""
    # per-automation override for legitimately long jobs; NULL = global default
    timeout = (automation.get("timeout_seconds")
               or settings_store.get("automations.run_timeout_seconds"))

    if automation.get("handler"):
        fn = MECHANICAL_HANDLERS.get(automation["handler"])
        if fn is None:
            # NEVER fall through to the agent path: a mechanical row's
            # instruction is documentation, and handing it to a model would
            # run the exact theatre the handler column exists to prevent.
            return False, (f"mechanical handler {automation['handler']!r} is "
                           f"not registered in this build — the run did not "
                           f"happen")
        try:
            return await asyncio.wait_for(fn(automation), timeout=timeout)
        except asyncio.TimeoutError:
            return False, f"timed out after {timeout}s"
        except Exception as e:  # noqa: BLE001 — a crashed drill is a FAILED run
            log.exception("mechanical automation %s crashed", automation["name"])
            return False, f"crashed: {e}"[:500]

    agent = await agent_registry.get_agent_by_name(automation["agent_name"])
    if not agent or not agent["enabled"]:
        return False, f"agent '{automation['agent_name']}' not found or disabled"
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


async def _tournament_night() -> None:
    """The tournament, off the tick.

    Re-asserts leadership itself. `tick()` checks `instances.is_leader()` once
    and then everything below inherits that answer for a few milliseconds —
    fine for work that finishes inside the tick, wrong for a job that can run
    for six hours. A night that outlives its own leadership would have two
    instances driving the same eval slot on a shared database.
    """
    if not instances.is_leader():
        return
    try:
        from app import model_tournament
        await model_tournament.maybe_run()
    except Exception:  # noqa: BLE001 — a tournament never costs the tick
        log.exception("model tournament failed")


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
    from app import backup_passphrase
    # the standing "record your backup passphrase off-machine" card — one
    # per passphrase, self-limits to daily, silent forever once decided
    await backup_passphrase.maybe_nag()
    from app import failures
    await failures.maybe_raise()         # self-limits to 6h, opt-in, deduped
    await sysmon.maybe_evaluate_alerts() # de-dupes via open alert rows
    await _maybe_backup()                # self-limits to backups.every_hours
    # Ranks the local models against the stalest suite. Off by default, and it
    # only ever RECORDS — no binding is swapped and no model is deleted, for
    # the reason in model_tournament's docstring: the same model has scored
    # 2/7 and 3/7 on consecutive runs of the same suite.
    # SPAWNED, never awaited. A night is six models with a 3600s ceiling each;
    # awaited here it sat on the critical path of a 60-second heartbeat, and
    # everything below this line — the entire automation body — never ran again
    # for the life of the process. Measured 2026-08-05: 177 launches, zero
    # finishes, and her followed sources unpolled the whole time. The comment
    # above said "a tournament never costs the tick"; it cost the tick every
    # tick. Migration 093 has the rest.
    #
    # `maybe_run` holds both halves of its own gate (an in-process lock and a
    # durable attempt row), so spawning it once a tick is safe and idempotent.
    bg.spawn(_tournament_night(), name="tournament-night")
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
                started_at=started, schedule=automation.get("schedule"))
            # A REMINDER HAS TO REACH HIM, and the backend is what makes sure.
            # His ByteByteGo reminder was written as "Remind Jeremy to check
            # the price" and said nothing about HOW — so the run would produce
            # text, the text would become the summary, the summary would go to
            # the journal, and the reminder would have reminded nobody.
            #
            # Delivered HERE rather than by the agent calling notify_operator,
            # because whether that call happens is a model's choice and this is
            # a property that has to hold. The agent may still call it; a
            # duplicate push is a far smaller failure than a silent one.
            if automation.get("notify"):
                try:
                    sent = await notify.send(
                        summary[:400] or f"{automation['name']} ran",
                        title=automation["name"])
                except Exception as e:                  # noqa: BLE001
                    log.exception("notify for automation %s failed",
                                  automation["name"])
                    sent = {"ok": False, "error": repr(e)}
                if not sent.get("ok"):
                    # HER JOURNAL, NOT JUST DOCKER LOGS (Jeremy, 2026-08-07).
                    # A notify:true automation exists to reach him; a push
                    # that died only in container logs is a reminder that
                    # never happened as far as any later reader can tell.
                    # And notify.send NEVER RAISES for the common failures —
                    # notifications off, provider unconfigured, ntfy down all
                    # come back as ok:false — so checking only for exceptions
                    # journalled the rare failure and dropped the likely one.
                    try:
                        await memory.write(
                            f"Automation '{automation['name']}' ran but its "
                            f"notification did NOT go out "
                            f"({sent.get('error') or 'notify reported not ok'}) "
                            f"— the operator was never told.",
                            type="journal", source_type="automation")
                    except Exception:
                        log.exception("could not journal the notify failure")
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
                    # NO local import here. `notify` is a module-level
                    # import, and a `from app import notify` inside this
                    # function made the name local to ALL of tick() — so the
                    # reminder-delivery branch above, which runs first, died
                    # with UnboundLocalError on the first real morning. The
                    # ByteByteGo reminder ran, its push crashed, and the
                    # operator got nothing.
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
