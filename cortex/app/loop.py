"""Background thinking loop — BRPOP hybrid with adaptive timeout.

Wakes immediately on stimulus, or after timeout for periodic drive evaluation.
Replaces the fixed-interval sleep loop with event-driven reactivity.
"""
from __future__ import annotations

import asyncio
import logging

from .clients import get_orchestrator
from .config import settings
from .cycle import run_cycle
from .db import get_pool
from .stimulus import brpop_stimulus, close_redis

log = logging.getLogger(__name__)

_task: asyncio.Task | None = None


async def _is_brain_enabled() -> bool:
    """Read features.brain_enabled from orchestrator. Default false on any
    failure — safer to over-sleep than to over-spend LLM cycles when the
    config plane is unreachable.
    """
    try:
        orch = get_orchestrator()
        resp = await orch.get(
            "/api/v1/config/features.brain_enabled",
            headers={"X-Admin-Secret": settings.admin_secret},
            timeout=5.0,
        )
        if resp.status_code == 200:
            value = resp.json().get("value")
            return value is True or str(value).lower() == "true"
        # 404 = key not set yet → treat as off (default)
        return False
    except Exception as e:
        log.debug("Failed to read features.brain_enabled: %s — treating as off", e)
        return False


async def start() -> None:
    """Start the thinking loop as a background task."""
    global _task
    if _task is not None:
        log.warning("Thinking loop already running")
        return
    _task = asyncio.create_task(_loop(), name="cortex-thinking-loop")
    log.info("Thinking loop started (initial_interval=%ds, enabled=%s)",
             settings.cycle_interval_seconds, settings.enabled)


async def stop() -> None:
    """Stop the thinking loop gracefully."""
    global _task
    if _task is None:
        return
    _task.cancel()
    try:
        await _task
    except asyncio.CancelledError:
        pass
    _task = None
    await close_redis()
    log.info("Thinking loop stopped")


from nova_contracts.feature_flags import register_flag

# B-Task 9: kill switch — pauses autonomous thinking. Distinct from
# the runtime features.brain_enabled toggle: that's "is the brain
# turned on for this install at all?" (config); this is "stop now,
# ignore queued stimuli, no restart" (operational kill switch).
KILL_THINKING = register_flag(
    key="kill.cortex.thinking_loop",
    type="bool",
    default=False,
    description="Pause autonomous cortex thinking loop without container restart.",
)


async def _loop() -> None:
    """Main loop — BRPOP for stimuli, run cycle, adapt timeout."""
    # Initial delay: let other services finish starting
    await asyncio.sleep(15)

    timeout = settings.cycle_interval_seconds  # Start with configured interval
    _last_kill_state = False

    while True:
        try:
            # Operational kill-switch (B9): runs ahead of brain-enabled
            # check so an operator can shut down even a misbehaving
            # brain that's failing the enable check itself.
            if KILL_THINKING.value():
                if not _last_kill_state:
                    log.warning(
                        "kill.cortex.thinking_loop=True — pausing thinking loop "
                        "(no cycles will fire until flag cleared)"
                    )
                    _last_kill_state = True
                await asyncio.sleep(timeout)
                continue
            elif _last_kill_state:
                log.info("kill.cortex.thinking_loop cleared — resuming thinking loop")
                _last_kill_state = False

            # Check the runtime UI toggle (features.brain_enabled). Default off
            # so a fresh install / unconfigured Nova doesn't burn LLM cycles
            # before the operator opts in via /settings#brain.
            if not await _is_brain_enabled():
                log.debug("Brain disabled — sleeping %ds", timeout)
                await asyncio.sleep(timeout)
                continue

            # Check if paused
            pool = get_pool()
            async with pool.acquire() as conn:
                status = await conn.fetchval(
                    "SELECT status FROM cortex_state WHERE id = true"
                )

            if status == "paused":
                log.debug("Cortex paused — sleeping %ds", timeout)
                await asyncio.sleep(timeout)
                continue

            # Block until stimulus arrives or timeout expires
            stimuli = await brpop_stimulus(timeout)

            if stimuli:
                log.info("Woke on %d stimulus(i): %s",
                         len(stimuli),
                         ", ".join(s.get("type", "?") for s in stimuli[:5]))
            else:
                log.debug("Woke on timeout (%ds) — periodic check", timeout)

            # Run one cycle with stimuli
            state = await run_cycle(stimuli=stimuli)
            log.info(
                "Cycle %d complete: drive=%s, outcome=%s",
                state.cycle_number,
                state.action_taken,
                (state.outcome[:80] if state.outcome else "none"),
            )

            # Adaptive timeout
            if stimuli or state.action_taken not in ("idle", "none"):
                timeout = settings.active_interval
            elif state.error:
                timeout = min(timeout * 3, settings.max_idle_interval)
            elif any(r.urgency > 0.3 for r in state.drive_results):
                timeout = settings.moderate_interval
            else:
                timeout = min(timeout * 2, settings.max_idle_interval)

        except asyncio.CancelledError:
            raise
        except Exception as e:
            log.error("Thinking loop error: %s", e, exc_info=True)
            # On unexpected error, fall back to fixed interval to avoid tight loops
            timeout = settings.cycle_interval_seconds
            await asyncio.sleep(60)
