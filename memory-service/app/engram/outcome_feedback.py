"""Outcome feedback processor — adjusts engram activation, importance, and edges
based on LLM interaction outcome scores from the orchestrator.

Called via POST /api/v1/engrams/outcome-feedback with a batch of
{engram_id, outcome_score, task_type} entries.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from nova_contracts.feature_flags import register_flag
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)

# AQ-002: when enabled, NEGATIVE outcomes also adjust state (decay
# activation, weaken edges). Default ON = symmetric (current shipped
# behavior; matches the in-code defaults at every adjustment site).
# Operators can flip OFF to revert to positive-only for A/B testing or
# to debug a feedback-loop suspected of over-correcting.
SYMMETRIC_FEEDBACK = register_flag(
    key="pipeline.outcome_feedback_symmetric",
    type="bool",
    default=True,
    description=(
        "AQ-002: negative outcomes decay activation and weaken edges "
        "(symmetric reinforcement). Default on = current behavior; flip "
        "off for positive-only mode."
    ),
)

# Thresholds — calibrated to actual chat_scorer distribution (avg ~0.55)
POSITIVE_THRESHOLD = 0.65
NEGATIVE_THRESHOLD = 0.45
ACTIVATION_BOOST = 0.05
IMPORTANCE_NUDGE = 0.05
IMPORTANCE_FLOOR = 0.1
IMPORTANCE_CEILING = 1.0
MIN_OBSERVATIONS = 5
EDGE_WEIGHT_BOOST = 0.02
EDGE_WEIGHT_CEILING = 1.0
EDGE_WEIGHT_FLOOR = 0.01  # Floor for negative-outcome edge decay (AQ-002)


async def process_feedback(
    session: AsyncSession,
    feedback: list[dict],
) -> dict:
    """Process a batch of outcome feedback entries.

    Each entry: {"engram_id": "uuid", "outcome_score": float, "task_type": str}

    Returns stats: {"activations": int, "deactivations": int,
                    "recalibrations": int, "edges": int, "edges_weakened": int}
    """
    stats = {
        "activations": 0,
        "deactivations": 0,
        "recalibrations": 0,
        "edges": 0,
        "edges_weakened": 0,
    }

    # Group by interaction — entries with the same task_type + outcome_score
    # were part of the same LLM call (they share an engram_ids list in one usage_event).
    # Build interaction groups for Hebbian edge reinforcement.
    interactions: dict[str, tuple[float, list[str]]] = {}
    for i, entry in enumerate(feedback):
        score = entry.get("outcome_score", 0.5)
        task_type = entry.get("task_type", "unknown")
        eid = entry.get("engram_id")
        if not eid:
            continue
        # Entries arrive in batch order — consecutive entries with same task_type
        # and score are from the same usage_event
        group_key = f"{task_type}:{score}"
        if group_key not in interactions:
            interactions[group_key] = (score, [])
        interactions[group_key][1].append(eid)

    # Process each entry
    for entry in feedback:
        eid = entry.get("engram_id")
        score = entry.get("outcome_score", 0.5)
        if not eid:
            continue

        try:
            eid_uuid = UUID(eid)
        except ValueError:
            continue

        # 1. Symmetric activation adjustment (AQ-002).
        # Positive outcome → boost toward 1.0; negative outcome → decay toward the
        # floor at the same magnitude. Without the negative branch, a bad engram
        # that retrieves often only gains activation, never loses it, so memory
        # develops a strong positivity bias and can't "unlearn" bad retrievals.
        if score > POSITIVE_THRESHOLD:
            await session.execute(
                text("""
                    UPDATE engrams
                    SET activation = LEAST(1.0, activation + :boost * (1.0 - activation)),
                        updated_at = NOW()
                    WHERE id = :eid
                """),
                {"eid": eid_uuid, "boost": ACTIVATION_BOOST},
            )
            stats["activations"] += 1
        elif score < NEGATIVE_THRESHOLD and SYMMETRIC_FEEDBACK.value():
            await session.execute(
                text("""
                    UPDATE engrams
                    SET activation = GREATEST(:floor, activation - :boost * activation),
                        updated_at = NOW()
                    WHERE id = :eid
                """),
                {"eid": eid_uuid, "boost": ACTIVATION_BOOST, "floor": IMPORTANCE_FLOOR},
            )
            stats["deactivations"] += 1

        # 2. Update rolling outcome stats
        await session.execute(
            text("""
                UPDATE engrams
                SET outcome_avg = CASE
                        WHEN outcome_count = 0 THEN :score
                        ELSE (outcome_avg * outcome_count + :score) / (outcome_count + 1)
                    END,
                    outcome_count = outcome_count + 1,
                    updated_at = NOW()
                WHERE id = :eid
            """),
            {"eid": eid_uuid, "score": score},
        )

        # 3. Importance recalibration (at most once per day per engram)
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        result = await session.execute(
            text("""
                SELECT outcome_avg, outcome_count, last_recalibrated_at, importance
                FROM engrams WHERE id = :eid
            """),
            {"eid": eid_uuid},
        )
        row = result.fetchone()
        if row and row.outcome_count >= MIN_OBSERVATIONS:
            can_recalibrate = (
                row.last_recalibrated_at is None or row.last_recalibrated_at < yesterday
            )
            if can_recalibrate:
                new_importance = row.importance
                if row.outcome_avg > POSITIVE_THRESHOLD:
                    new_importance = min(
                        IMPORTANCE_CEILING, row.importance + IMPORTANCE_NUDGE
                    )
                elif row.outcome_avg < NEGATIVE_THRESHOLD and SYMMETRIC_FEEDBACK.value():
                    new_importance = max(
                        IMPORTANCE_FLOOR, row.importance - IMPORTANCE_NUDGE
                    )
                else:
                    continue  # No change needed

                if new_importance != row.importance:
                    await session.execute(
                        text("""
                            UPDATE engrams
                            SET importance = :imp, last_recalibrated_at = NOW(), updated_at = NOW()
                            WHERE id = :eid
                        """),
                        {"eid": eid_uuid, "imp": new_importance},
                    )
                    stats["recalibrations"] += 1

    # 4. Outcome-driven Hebbian learning (AQ-002).
    # Positive co-retrieval → strengthen edge. Negative co-retrieval → weaken
    # edge (co-activated in a bad outcome, probably less related than thought).
    # Neutral scores leave edges untouched.
    symmetric = SYMMETRIC_FEEDBACK.value()
    for _group_key, (score, eids) in interactions.items():
        if len(eids) < 2:
            continue
        positive = score > POSITIVE_THRESHOLD
        # Negative branch only fires under symmetric mode — without it,
        # bad co-retrievals don't weaken edges (positive-only mode).
        negative = score < NEGATIVE_THRESHOLD and symmetric
        if not (positive or negative):
            continue
        for i, eid_a in enumerate(eids):
            for eid_b in eids[i + 1 :]:
                try:
                    a_uuid, b_uuid = UUID(eid_a), UUID(eid_b)
                except ValueError:
                    continue
                if positive:
                    result = await session.execute(
                        text("""
                            UPDATE engram_edges
                            SET weight = LEAST(:ceiling, weight + :boost),
                                co_activations = co_activations + 1,
                                last_co_activated = NOW()
                            WHERE (source_id = :a AND target_id = :b)
                               OR (source_id = :b AND target_id = :a)
                            RETURNING id
                        """),
                        {
                            "a": a_uuid,
                            "b": b_uuid,
                            "boost": EDGE_WEIGHT_BOOST,
                            "ceiling": EDGE_WEIGHT_CEILING,
                        },
                    )
                    if not result.fetchone():
                        # No existing edge — create one from co-retrieval
                        await session.execute(
                            text("""
                                INSERT INTO engram_edges (source_id, target_id, relation, weight, co_activations, last_co_activated)
                                VALUES (:a, :b, 'related_to', :boost, 2, NOW())
                                ON CONFLICT (source_id, target_id, relation) DO UPDATE
                                SET co_activations = engram_edges.co_activations + 1,
                                    last_co_activated = NOW()
                            """),
                            {"a": a_uuid, "b": b_uuid, "boost": EDGE_WEIGHT_BOOST},
                        )
                    stats["edges"] += 1
                else:  # negative
                    # Weaken existing edges only — don't create new ones for bad outcomes.
                    await session.execute(
                        text("""
                            UPDATE engram_edges
                            SET weight = GREATEST(:floor, weight - :boost),
                                last_co_activated = NOW()
                            WHERE (source_id = :a AND target_id = :b)
                               OR (source_id = :b AND target_id = :a)
                        """),
                        {
                            "a": a_uuid,
                            "b": b_uuid,
                            "boost": EDGE_WEIGHT_BOOST,
                            "floor": EDGE_WEIGHT_FLOOR,
                        },
                    )
                    stats["edges_weakened"] += 1

    await session.commit()
    return stats
