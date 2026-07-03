"""Memory integration for Cortex (neutral /api/v1/memory/* API).

Three integration points:
1. PERCEIVE — query memory context for drive-informed decisions
2. REFLECT — write cycle outcomes to memory for long-term learning
3. IDLE — trigger backend consolidation when nothing else to do
"""
from __future__ import annotations

import json
import logging
import time

from .clients import get_memory
from .config import settings

log = logging.getLogger(__name__)


async def perceive_with_memory(stimuli: list[dict], goal_context: str = "") -> dict:
    """Query memory for context relevant to current cycle.

    Returns dict with memory_context (str), memory_ids (list), retrieval_log_id (str|None).
    """
    if not settings.memory_enabled:
        return {"memory_context": "", "memory_ids": [], "retrieval_log_id": None}

    # Build a query from stimuli + goal context
    query_parts = []
    if goal_context:
        query_parts.append(f"Current goal: {goal_context}")
    for s in stimuli[:5]:
        query_parts.append(f"{s.get('type', 'unknown')}: {json.dumps(s.get('payload', {}))}")

    query = " | ".join(query_parts) or "general system status and pending work"

    try:
        mem = get_memory()
        resp = await mem.post(
            "/api/v1/memory/context",
            json={"query": query, "session_id": "cortex-perceive"},
            timeout=10.0,
        )
        if resp.status_code == 200:
            data = resp.json()
            return {
                "memory_context": data.get("context", ""),
                "memory_ids": data.get("memory_ids", []),
                "retrieval_log_id": data.get("retrieval_log_id"),
            }
        log.warning("Memory context request returned %d", resp.status_code)
    except Exception as e:
        log.warning("Failed to get memory context: %s", e)

    return {"memory_context": "", "memory_ids": [], "retrieval_log_id": None}


async def reflect_to_memory(
    cycle_number: int,
    drive: str,
    urgency: float,
    action_summary: str,
    outcome: str,
    goal_id: str | None = None,
    budget_tier: str = "best",
) -> None:
    """Ingest cycle outcome into memory for long-term learning.

    Only ingests when an action was actually taken (not idle cycles).
    """
    if not settings.reflect_to_memory:
        return

    raw_text = (
        f"Cortex cycle #{cycle_number}: "
        f"Drive '{drive}' won (urgency {urgency:.2f}). "
        f"Action: {action_summary}. "
        f"Outcome: {outcome}."
    )

    try:
        mem = get_memory()
        await mem.post(
            "/api/v1/memory/ingest",
            json={
                "raw_text": raw_text,
                "source_type": "cortex",
                "source_id": "cortex-reflect",
                "metadata": {
                    "drive": drive,
                    "goal_id": goal_id,
                    "budget_tier": budget_tier,
                    "cycle": cycle_number,
                },
            },
            timeout=10.0,
        )
        log.debug("Reflected cycle %d to memory", cycle_number)
    except Exception as e:
        log.debug("Failed to reflect to memory: %s", e)


async def ingest_lesson(
    goal_title: str,
    maturation_phase: str | None,
    approach: str,
    outcome: str,
    lesson: str,
    goal_id: str | None = None,
    failure_mode: str | None = None,
) -> None:
    """Ingest a reflection lesson into memory for cross-goal learning.

    Only called for reflections with non-null lessons (mid/best budget tier).
    Routine successes without surprising lessons are not ingested.
    """
    if not settings.reflect_to_memory:
        return

    # Skip routine successes with no surprising lesson
    if outcome == "success" and not lesson:
        return

    phase_ctx = f" (phase: {maturation_phase})" if maturation_phase else ""
    raw_text = (
        f"Working on goal '{goal_title}'{phase_ctx}: "
        f"tried {approach[:200]}. "
        f"Result: {outcome}. "
        f"Lesson: {lesson}"
    )

    metadata = {"drive": "serve", "outcome": outcome}
    if goal_id:
        metadata["goal_id"] = goal_id
    if failure_mode:
        metadata["failure_mode"] = failure_mode

    try:
        mem = get_memory()
        await mem.post(
            "/api/v1/memory/ingest",
            json={
                "raw_text": raw_text,
                "source_type": "cortex",
                "source_id": "cortex-lesson",
                "metadata": metadata,
            },
            timeout=10.0,
        )
        log.debug("Ingested lesson for goal '%s'", goal_title)
    except Exception as e:
        log.debug("Failed to ingest lesson: %s", e)


# Process-local cooldown — the neutral API has no consolidation log to query.
_last_consolidation_at: float = 0.0


async def maybe_consolidate() -> bool:
    """Trigger backend consolidation if enough time has passed since last run.

    Returns True if consolidation was triggered.
    """
    global _last_consolidation_at
    if not settings.idle_consolidation:
        return False

    if time.monotonic() - _last_consolidation_at < settings.consolidation_cooldown:
        return False

    try:
        mem = get_memory()
        await mem.post("/api/v1/memory/consolidate", timeout=5.0)
        _last_consolidation_at = time.monotonic()
        log.info("Triggered idle consolidation")
        return True
    except Exception as e:
        log.debug("Consolidation trigger failed: %s", e)
        return False


async def mark_memories_used(retrieval_log_id: str, memory_ids: list[str]) -> None:
    """Report which memories were used during planning."""
    if not retrieval_log_id or not memory_ids:
        return
    try:
        mem = get_memory()
        await mem.post(
            "/api/v1/memory/mark-used",
            json={"retrieval_log_id": retrieval_log_id, "used_ids": memory_ids},
            timeout=5.0,
        )
    except Exception as e:
        log.debug("Failed to mark memories used: %s", e)
