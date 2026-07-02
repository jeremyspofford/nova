"""Quality drive — monitor AI quality, trigger loops on regressions.

Polls the orchestrator's quality summary endpoint. If composite has
dropped or any watched dimension shows sustained regression, urgency
rises and the drive can trigger /api/v1/quality/loops/{name}/run-now.
"""
from __future__ import annotations

import logging

from ..clients import get_orchestrator
from . import DriveContext, DriveResult

log = logging.getLogger(__name__)

# Composite below this triggers urgency, scaled by how far below
_HEALTHY_COMPOSITE = 75.0
# A dim avg below this is a candidate for action
_DIM_REGRESSION_THRESHOLD = 0.6


async def assess(ctx: DriveContext | None = None) -> DriveResult:
    """Read /api/v1/quality/summary; return urgency + watched-dim context."""
    urgency = 0.0
    description_parts: list[str] = []
    context: dict = {}

    try:
        client = get_orchestrator()
        resp = await client.get("/api/v1/quality/summary?period=7d", timeout=10.0)
        if resp.status_code != 200:
            log.debug("Quality drive: summary returned %s", resp.status_code)
            return DriveResult(
                name="quality",
                priority=3,
                urgency=0.0,
                description="quality summary unavailable",
                context={},
            )
        data = resp.json()
    except Exception as e:
        log.debug("Quality drive: failed to fetch summary: %s", e)
        return DriveResult(
            name="quality",
            priority=3,
            urgency=0.0,
            description="quality summary error",
            context={},
        )

    composite = float(data.get("composite", 100.0))
    dimensions = data.get("dimensions", {})

    # No quality data yet → no signal. Without this guard, an empty summary
    # ({"dimensions": {}, "composite": 0.0}) reads as "maximum regression"
    # and the drive wins every cycle while having nothing real to do.
    if not dimensions and composite == 0.0:
        return DriveResult(
            name="quality",
            priority=3,
            urgency=0.0,
            description="no quality data yet",
            context={},
        )

    if composite < _HEALTHY_COMPOSITE:
        gap = (_HEALTHY_COMPOSITE - composite) / _HEALTHY_COMPOSITE
        urgency = max(urgency, min(0.8, gap * 1.5))
        description_parts.append(f"composite {composite:.0f} below {_HEALTHY_COMPOSITE:.0f}")
        context["composite"] = composite

    weak_dims = [
        d for d, info in dimensions.items()
        if info.get("avg", 1.0) < _DIM_REGRESSION_THRESHOLD and info.get("count", 0) >= 5
    ]
    if weak_dims:
        urgency = max(urgency, 0.4)
        description_parts.append(f"weak dimensions: {', '.join(weak_dims)}")
        context["weak_dimensions"] = weak_dims

    desc = "; ".join(description_parts) or "quality healthy"

    proposed_action = None
    if context.get("weak_dimensions"):
        # Loop A watches memory_relevance / memory_usage
        if any(d in ("memory_relevance", "memory_usage") for d in weak_dims):
            proposed_action = "Trigger retrieval_tuning loop to address weak memory dimensions"

    return DriveResult(
        name="quality",
        priority=3,
        urgency=urgency,
        description=desc,
        proposed_action=proposed_action,
        context=context,
    )


async def react(ctx: DriveContext, result: DriveResult) -> None:
    """If quality is regressed on a memory dimension, kick a memory reindex.

    Called by the cycle when this drive wins. The retrieval_tuning loop was
    engram-specific (neural-router tuning); under the backend-agnostic memory
    API this reduces to asking the active backend to rebuild its retrieval
    index (no-op for backends that don't maintain one).
    """
    weak_dims = result.context.get("weak_dimensions", [])
    if not weak_dims:
        return
    if any(d in ("memory_relevance", "memory_usage") for d in weak_dims):
        from ..clients import get_memory

        try:
            await get_memory().post("/api/v1/memory/reindex", timeout=30.0)
            log.info("Quality drive: triggered memory reindex (weak: %s)", weak_dims)
        except Exception as e:
            log.warning("Quality drive: reindex trigger failed: %s", e)
