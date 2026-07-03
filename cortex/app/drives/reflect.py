"""Reflect drive — learn from experience, review past patterns.

Urgency rises after many cycles without reflection, or on budget exhaustion.
"""
from __future__ import annotations

import logging

from . import DriveContext, DriveResult

log = logging.getLogger(__name__)

# Track cycles since last reflection (reset when reflect drive wins)
_cycles_since_reflect: int = 0


def reset_reflect_counter() -> None:
    """Call after reflect drive executes."""
    global _cycles_since_reflect
    _cycles_since_reflect = 0


async def assess(ctx: DriveContext | None = None) -> DriveResult:
    """Assess reflect drive urgency based on cycle count and budget state."""
    global _cycles_since_reflect
    _cycles_since_reflect += 1

    urgency = 0.0
    description_parts = []

    # Urgency rises with cycles since last reflection (0.1 per 10 cycles, cap 0.8)
    cycle_urgency = min(0.8, (_cycles_since_reflect // 10) * 0.1)
    if cycle_urgency > 0:
        urgency = max(urgency, cycle_urgency)
        description_parts.append(f"{_cycles_since_reflect} cycles since last reflection")

    # Budget tier change to "none" — good time to reflect on spend
    if ctx and ctx.stimuli_of_type("budget.tier_change"):
        for s in ctx.stimuli_of_type("budget.tier_change"):
            if s.get("payload", {}).get("new_tier") == "none":
                urgency = max(urgency, 0.6)
                description_parts.append("Budget exhausted — time to reflect on spending")

    if urgency == 0.0:
        return DriveResult(
            name="reflect", priority=3, urgency=0.0,
            description="No reflection needed yet",
        )

    return DriveResult(
        name="reflect",
        priority=3,
        urgency=round(urgency, 2),
        description="; ".join(description_parts),
        proposed_action="Review recent drive patterns and outcomes, write reflection memory",
        context={"cycles_since_reflect": _cycles_since_reflect},
    )
