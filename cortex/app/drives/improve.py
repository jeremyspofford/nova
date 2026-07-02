"""Improve drive — investigate contradictions and system improvements.

Reacts to engram.contradiction stimuli (engram backend only) and
self-modification opportunities.
"""
from __future__ import annotations

import logging

from . import DriveContext, DriveResult

log = logging.getLogger(__name__)


async def assess(ctx: DriveContext | None = None) -> DriveResult:
    """Assess improve drive urgency based on contradictions and system signals."""
    urgency = 0.0
    description_parts = []
    context = {}

    # React to contradiction stimuli (only the engram backend emits these;
    # the OKF markdown backend has no contradiction detection)
    if ctx:
        contradictions = ctx.stimuli_of_type("engram.contradiction")
        if contradictions:
            urgency = max(urgency, 0.4)
            description_parts.append(f"{len(contradictions)} contradictions detected")
            context["contradictions"] = [s.get("payload", {}) for s in contradictions]

    # Self-modification opportunity
    if ctx:
        for s in ctx.stimuli:
            if s.get("type") in ("system.selfmod_opportunity", "engram.improvement_suggestion"):
                urgency = max(urgency, 0.5)
                description_parts.append(s.get("description", "Self-modification opportunity detected"))
                context["selfmod_trigger"] = s
                break

    if urgency == 0.0:
        return DriveResult(
            name="improve", priority=3, urgency=0.0,
            description="No improvement signals",
        )

    proposed_action = (
        "Assess the improvement opportunity and create a PR if warranted"
        if "selfmod_trigger" in context
        else "Investigate and resolve detected issues"
    )

    return DriveResult(
        name="improve",
        priority=3,
        urgency=round(urgency, 2),
        description="; ".join(description_parts),
        proposed_action=proposed_action,
        context=context,
    )
