"""
Spreading activation engine — Phase 2 of the Engram Network.

Replaces cosine similarity search with graph-based associative retrieval.
Activation flows from seed engrams through weighted edges, with convergent
amplification boosting engrams reached by multiple independent paths.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from datetime import datetime, timezone

from app.config import settings
from app.embedding import get_embedding, to_pg_vector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)


@dataclass
class ActivatedEngram:
    """An engram with its computed activation score."""

    id: str
    type: str
    content: str
    activation: float
    importance: float
    confidence: float
    convergence_paths: int
    final_score: float
    access_count: int
    last_accessed: datetime | None = None
    created_at: datetime | None = None
    fragments: dict | None = None
    source_type: str = "chat"


async def spreading_activation(
    session: AsyncSession,
    query: str,
    seed_count: int | None = None,
    max_hops: int | None = None,
    decay_factor: float | None = None,
    activation_threshold: float | None = None,
    max_results: int | None = None,
    depth: str = "standard",  # shallow, standard, deep
    tenant_id: str = "00000000-0000-0000-0000-000000000001",
) -> list[ActivatedEngram]:
    """Run spreading activation over the engram graph.

    1. Embed query → find top-N seeds by cosine similarity
    2. Spread activation through edges (recursive CTE)
    3. Apply convergent amplification
    4. Rank by final_score = activation × importance × recency_boost
    """
    seed_count = seed_count or settings.engram_seed_count
    max_hops = max_hops or settings.engram_max_hops
    decay_factor = decay_factor or settings.engram_decay_factor
    activation_threshold = activation_threshold or settings.engram_activation_threshold
    max_results = max_results or settings.engram_max_results

    # Get query embedding
    query_embedding = await get_embedding(query, session)
    embedding_str = to_pg_vector(query_embedding)

    # Stratified seed selection: reserve a fraction of slots for personal sources
    # so intel volume can't drown out chat/consolidation memories.
    personal_seed_count = math.ceil(seed_count * settings.engram_personal_seed_ratio)
    general_seed_count = seed_count - personal_seed_count

    # Run the spreading activation CTE
    # The CTE spreads activation through edges, tracking paths for convergence.
    # We also follow edges in reverse (target→source) since associations are bidirectional.
    result = await session.execute(
        text("""
            WITH RECURSIVE activation_spread AS (
                -- Personal seeds (guaranteed chat/consolidation representation)
                SELECT id, boosted_sim AS activation, 0 AS hop, ARRAY[id] AS path
                FROM (
                    SELECT e.id,
                           (
                               (1 - (e.embedding <=> CAST(:embedding AS halfvec)))
                               * CASE e.source_type
                                   WHEN 'chat' THEN 1.5
                                   WHEN 'consolidation' THEN 1.2
                                   WHEN 'knowledge' THEN 0.7
                                   WHEN 'intel' THEN 0.5
                                   ELSE 1.0
                                 END
                               * COALESCE(e.confidence, 0.5)
                           )::real AS boosted_sim
                    FROM engrams e
                    WHERE NOT e.superseded
                      AND e.embedding IS NOT NULL
                      AND e.tenant_id = CAST(:tenant_id AS uuid)
                      AND e.source_type IN ('chat', 'consolidation', 'self_reflection')
                      AND e.activation >= :activation_floor
                    ORDER BY boosted_sim DESC
                    LIMIT :personal_seed_count
                ) personal

                UNION ALL

                -- General seeds (best non-personal sources)
                SELECT id, boosted_sim AS activation, 0 AS hop, ARRAY[id] AS path
                FROM (
                    SELECT e.id,
                           (
                               (1 - (e.embedding <=> CAST(:embedding AS halfvec)))
                               * CASE e.source_type
                                   WHEN 'chat' THEN 1.5
                                   WHEN 'consolidation' THEN 1.2
                                   WHEN 'knowledge' THEN 0.7
                                   WHEN 'intel' THEN 0.5
                                   ELSE 1.0
                                 END
                               * COALESCE(e.confidence, 0.5)
                           )::real AS boosted_sim
                    FROM engrams e
                    WHERE NOT e.superseded
                      AND e.embedding IS NOT NULL
                      AND e.tenant_id = CAST(:tenant_id AS uuid)
                      AND e.activation >= :activation_floor
                      AND e.source_type NOT IN ('chat', 'consolidation', 'self_reflection')
                    ORDER BY boosted_sim DESC
                    LIMIT :general_seed_count
                ) general

                UNION ALL

                -- Spread through edges (both directions — bidirectional graph)
                SELECT
                    neighbor.id,
                    LEAST(1.0, spread.activation * edge.weight * :decay_factor)::real AS activation,
                    spread.hop + 1,
                    spread.path || neighbor.id
                FROM activation_spread spread
                JOIN engram_edges edge ON (edge.source_id = spread.id OR edge.target_id = spread.id)
                JOIN engrams neighbor ON neighbor.id = CASE
                    WHEN edge.source_id = spread.id THEN edge.target_id
                    ELSE edge.source_id
                END
                WHERE spread.hop < :max_hops
                  AND NOT neighbor.superseded
                  AND edge.relation != 'contradicts'
                  AND NOT (neighbor.id = ANY(spread.path))
                  AND (spread.activation * edge.weight * :decay_factor) > :threshold
            )
            SELECT
                a.id,
                e.type,
                e.content,
                e.importance,
                e.confidence,
                e.access_count,
                e.last_accessed,
                e.created_at,
                e.fragments::text,
                e.source_type,
                MAX(a.activation) AS activation,
                COUNT(DISTINCT a.path[1]) AS convergence_paths
            FROM activation_spread a
            JOIN engrams e ON e.id = a.id
            GROUP BY a.id, e.type, e.content, e.importance, e.confidence,
                     e.access_count, e.last_accessed, e.created_at, e.fragments, e.source_type
            ORDER BY
                MAX(a.activation)
                * (1 + 0.2 * GREATEST(0, COUNT(DISTINCT a.path[1]) - 1))
                * e.importance
                DESC
            LIMIT :max_results
        """),
        {
            "embedding": embedding_str,
            "tenant_id": tenant_id,
            "personal_seed_count": personal_seed_count,
            "general_seed_count": general_seed_count,
            "max_hops": max_hops,
            "decay_factor": decay_factor,
            "threshold": activation_threshold,
            "max_results": max_results,
            "activation_floor": settings.engram_prune_activation_floor,
        },
    )

    now = datetime.now(timezone.utc)
    activated = []
    for row in result:
        # Recency boost: 1.0 + 0.5 * max(0, 1 - days/30)
        days = 30.0
        if row.last_accessed:
            la = row.last_accessed
            if la.tzinfo is None:
                la = la.replace(tzinfo=timezone.utc)
            days = max((now - la).total_seconds() / 86400, 0.001)
        recency_boost = 1.0 + 0.5 * max(0, 1 - days / 30)

        # Convergent amplification
        convergence_bonus = 1.0 + 0.2 * max(0, row.convergence_paths - 1)

        confidence = row.confidence if row.confidence else 0.5
        final_score = (
            row.activation
            * row.importance
            * confidence
            * recency_boost
            * convergence_bonus
        )

        import json as _json

        fragments = None
        if row.fragments:
            try:
                fragments = _json.loads(row.fragments)
            except Exception:
                pass

        activated.append(
            ActivatedEngram(
                id=str(row.id),
                type=row.type,
                content=row.content,
                activation=row.activation,
                importance=row.importance,
                confidence=row.confidence,
                convergence_paths=row.convergence_paths,
                final_score=final_score,
                access_count=row.access_count,
                last_accessed=row.last_accessed,
                created_at=row.created_at,
                fragments=fragments,
                source_type=row.source_type,
            )
        )

    # Shallow mode: only return topic and schema engrams
    if depth == "shallow":
        activated = [a for a in activated if a.type in ("topic", "schema")]

    # Update last_accessed and access_count for retrieved engrams
    if activated:
        ids = [a.id for a in activated]
        await _touch_accessed(session, ids)

    # Deep mode: follow all instance_of/part_of edges from activated nodes
    if depth == "deep" and activated:
        pre_deep_count = len(activated)
        activated_ids = {a.id for a in activated}
        structural_result = await session.execute(
            text("""
                SELECT DISTINCT e.id::text, e.type, e.content, e.importance,
                       e.confidence, e.access_count, e.last_accessed, e.created_at,
                       e.fragments::text, e.source_type
                FROM engram_edges ee
                JOIN engrams e ON e.id = CASE
                    WHEN ee.source_id = ANY(CAST(:ids AS uuid[])) THEN ee.target_id
                    ELSE ee.source_id
                END
                WHERE (ee.source_id = ANY(CAST(:ids AS uuid[]))
                    OR ee.target_id = ANY(CAST(:ids AS uuid[])))
                  AND ee.relation IN ('instance_of', 'part_of')
                  AND NOT e.superseded
                  AND e.id != ALL(CAST(:ids AS uuid[]))
            """),
            {"ids": list(activated_ids)},
        )

        for row in structural_result:
            if str(row.id) not in activated_ids:
                import json as _json

                fragments = None
                if row.fragments:
                    try:
                        fragments = _json.loads(row.fragments)
                    except Exception:
                        pass

                activated.append(
                    ActivatedEngram(
                        id=str(row.id),
                        type=row.type,
                        content=row.content,
                        activation=0.5,
                        importance=row.importance,
                        confidence=row.confidence,
                        convergence_paths=1,
                        final_score=0.5 * row.importance,
                        access_count=row.access_count,
                        last_accessed=row.last_accessed,
                        created_at=row.created_at,
                        fragments=fragments,
                        source_type=row.source_type,
                    )
                )
                activated_ids.add(str(row.id))

        # Touch the newly added structural neighbors
        new_ids = [a.id for a in activated[pre_deep_count:]]
        if new_ids:
            await _touch_accessed(session, new_ids)

    activated.sort(key=lambda a: a.final_score, reverse=True)
    return activated


async def _touch_accessed(session: AsyncSession, ids: list[str]) -> None:
    """Bump access_count and last_accessed for retrieved engrams."""
    try:
        await session.execute(
            text("""
                UPDATE engrams
                SET access_count = access_count + 1,
                    last_accessed = NOW(),
                    activation = LEAST(1.0, activation + 0.1 * (1.0 - activation))
                WHERE id = ANY(CAST(:ids AS uuid[]))
            """),
            {"ids": ids},
        )
    except Exception:
        log.warning("Failed to touch accessed engrams", exc_info=True)
