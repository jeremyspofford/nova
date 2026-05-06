"""
Topic Discovery — HDBSCAN + entity validation + LLM naming.

Three-stage pipeline for creating topic engrams from the engram graph:
1. HDBSCAN clustering on UMAP-reduced embeddings
2. Entity validation and sub-topic splitting
3. LLM naming and summary generation

Called from consolidation Phase 2.5.
"""

from __future__ import annotations

import logging
from uuid import UUID

import httpx
import numpy as np
from app.config import settings
from app.embedding import get_embedding, to_pg_vector
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

log = logging.getLogger(__name__)


async def discover_topics(session: AsyncSession) -> int:
    """Run the full topic discovery pipeline. Returns count of topics created."""
    result = await session.execute(
        text("""
            SELECT id, type, content, embedding::text
            FROM engrams
            WHERE NOT superseded
              AND embedding IS NOT NULL
              AND type IN ('fact', 'preference', 'procedure', 'schema')
            ORDER BY importance DESC
            LIMIT 5000
        """)
    )
    rows = result.fetchall()

    if len(rows) < settings.engram_cluster_min_size * 2:
        log.info("Too few engrams (%d) for topic clustering, skipping", len(rows))
        return 0

    engram_ids = [str(r.id) for r in rows]
    engram_contents = {str(r.id): r.content for r in rows}

    # Parse embeddings from pgvector text format
    embeddings = []
    for r in rows:
        vec_str = r.embedding.strip("[]")
        embeddings.append([float(x) for x in vec_str.split(",")])
    embeddings_np = np.array(embeddings, dtype=np.float32)

    # Stage 1: UMAP + HDBSCAN
    clusters = _cluster_embeddings(embeddings_np, engram_ids)
    if len(clusters) < 2:
        log.info("HDBSCAN produced fewer than 2 clusters, skipping topic creation")
        return 0

    # Stage 2: Entity validation and refinement
    validated_clusters = await _validate_with_entities(
        session, clusters, engram_contents
    )

    # Stage 3: LLM naming and topic creation
    topics_created = 0
    for cluster in validated_clusters:
        created = await _create_topic_engram(session, cluster, engram_contents)
        if created:
            topics_created += 1

    return topics_created


def _cluster_embeddings(
    embeddings: np.ndarray,
    engram_ids: list[str],
) -> list[dict]:
    """Stage 1: Reduce dimensions with UMAP, then cluster with HDBSCAN."""
    from sklearn.cluster import HDBSCAN
    from umap import UMAP

    reducer = UMAP(
        n_components=settings.engram_cluster_umap_dims,
        n_neighbors=settings.engram_cluster_umap_neighbors,
        metric="cosine",
        random_state=42,
    )
    reduced = reducer.fit_transform(embeddings)

    clusterer = HDBSCAN(
        min_cluster_size=settings.engram_cluster_min_size,
        metric="euclidean",
    )
    labels = clusterer.fit_predict(reduced)

    clusters: dict[int, list[str]] = {}
    for idx, label in enumerate(labels):
        if label == -1:
            continue
        clusters.setdefault(label, []).append(engram_ids[idx])

    return [{"engram_ids": ids, "label": label} for label, ids in clusters.items()]


async def _validate_with_entities(
    session: AsyncSession,
    clusters: list[dict],
    engram_contents: dict[str, str],
) -> list[dict]:
    """Stage 2: Validate clusters with entity co-occurrence, split sub-topics."""
    validated = []

    for cluster in clusters:
        ids = cluster["engram_ids"]

        entity_result = await session.execute(
            text("""
                SELECT ee.source_id::text AS engram_id, e.content AS entity_name
                FROM engram_edges ee
                JOIN engrams e ON e.id = ee.target_id AND e.type = 'entity'
                WHERE ee.source_id = ANY(CAST(:ids AS uuid[]))
                  AND ee.relation = 'related_to'
            """),
            {"ids": ids},
        )
        entity_rows = entity_result.fetchall()

        entity_engrams: dict[str, set[str]] = {}
        engram_entities: dict[str, set[str]] = {}
        for row in entity_rows:
            entity_engrams.setdefault(row.entity_name, set()).add(row.engram_id)
            engram_entities.setdefault(row.engram_id, set()).add(row.entity_name)

        anchor_entities = [
            name for name, engrams in entity_engrams.items() if len(engrams) >= 2
        ]

        if len(anchor_entities) >= 4:
            sub_clusters = _try_split_by_entities(ids, engram_entities, anchor_entities)
            if sub_clusters:
                for sub_ids, sub_anchors in sub_clusters:
                    validated.append(
                        {
                            "engram_ids": sub_ids,
                            "anchor_entities": sub_anchors,
                            "needs_careful_naming": len(sub_anchors) < 2,
                        }
                    )
                continue

        validated.append(
            {
                "engram_ids": ids,
                "anchor_entities": anchor_entities,
                "needs_careful_naming": len(anchor_entities) < 2,
            }
        )

    return validated


def _try_split_by_entities(
    engram_ids: list[str],
    engram_entities: dict[str, set[str]],
    anchor_entities: list[str],
) -> list[tuple[list[str], list[str]]] | None:
    """Try to split a cluster into sub-topics based on entity groups."""
    entity_to_engrams = {}
    for eid in engram_ids:
        for entity in engram_entities.get(eid, set()):
            if entity in anchor_entities:
                entity_to_engrams.setdefault(entity, set()).add(eid)

    if len(entity_to_engrams) < 4:
        return None

    sorted_entities = sorted(entity_to_engrams.items(), key=lambda x: -len(x[1]))
    mid = len(sorted_entities) // 2
    group_a_entities = {e[0] for e in sorted_entities[:mid]}
    group_b_entities = {e[0] for e in sorted_entities[mid:]}

    group_a_engrams = set()
    for e in group_a_entities:
        group_a_engrams |= entity_to_engrams[e]
    group_b_engrams = set()
    for e in group_b_entities:
        group_b_engrams |= entity_to_engrams[e]

    overlap = group_a_engrams & group_b_engrams
    total = group_a_engrams | group_b_engrams
    if not total or len(overlap) / len(total) > 0.5:
        return None

    final_a = list(group_a_engrams - overlap)
    final_b = list(group_b_engrams - overlap)
    for eid in overlap:
        eid_entities = engram_entities.get(eid, set())
        a_matches = len(eid_entities & group_a_entities)
        b_matches = len(eid_entities & group_b_entities)
        if a_matches >= b_matches:
            final_a.append(eid)
        else:
            final_b.append(eid)

    if (
        len(final_a) < settings.engram_cluster_min_size
        or len(final_b) < settings.engram_cluster_min_size
    ):
        return None

    return [
        (final_a, list(group_a_entities)),
        (final_b, list(group_b_entities)),
    ]


async def _create_topic_engram(
    session: AsyncSession,
    cluster: dict,
    engram_contents: dict[str, str],
) -> bool:
    """Stage 3: Create a topic engram with LLM-generated name and summary."""
    import json as _json

    from .ingestion import _create_edge

    ids = cluster["engram_ids"]
    anchors = cluster.get("anchor_entities", [])

    sample_contents = [
        engram_contents[eid] for eid in ids[:10] if eid in engram_contents
    ]
    if not sample_contents:
        return False

    representative_text = " ".join(sample_contents)

    # Check for existing topic with similar content
    rep_embedding = await get_embedding(representative_text[:500], session)
    existing = await session.execute(
        text("""
            SELECT id FROM engrams
            WHERE type = 'topic'
              AND embedding IS NOT NULL
              AND (NOT superseded OR updated_at > NOW() - INTERVAL '6 hours')
              AND 1 - (embedding <=> CAST(:emb AS halfvec)) > 0.75
            LIMIT 1
        """),
        {"emb": to_pg_vector(rep_embedding)},
    )
    if existing.fetchone():
        log.debug("Similar topic already exists, skipping cluster")
        return False

    # LLM: generate topic name and summary
    topic_content = await _name_topic(
        anchors, sample_contents, cluster.get("needs_careful_naming", False)
    )
    if not topic_content:
        return False

    topic_embedding = await get_embedding(topic_content, session)

    # Compute centroid in numpy (avg() on halfvec unsupported in pgvector)
    member_embeddings = await session.execute(
        text("""
            SELECT embedding::text FROM engrams
            WHERE id = ANY(CAST(:ids AS uuid[]))
              AND embedding IS NOT NULL
        """),
        {"ids": ids},
    )
    emb_rows = member_embeddings.fetchall()
    if emb_rows:
        emb_arrays = []
        for r in emb_rows:
            vec_str = r.embedding.strip("[]")
            emb_arrays.append([float(x) for x in vec_str.split(",")])
        centroid = np.mean(emb_arrays, axis=0).tolist()
        centroid_str = to_pg_vector(centroid)
    else:
        centroid_str = to_pg_vector(topic_embedding)

    meta = {
        "member_count": len(ids),
        "entity_anchors": anchors[:10],
        "cluster_method": "hdbscan+entity+llm",
        "centroid": centroid_str,
    }

    topic_row = await session.execute(
        text("""
            INSERT INTO engrams (type, content, embedding, embedding_model,
                                importance, source_type, confidence, source_meta)
            VALUES ('topic', :content, CAST(:embedding AS halfvec), :model,
                    0.8, 'consolidation', 0.8,
                    CAST(:meta AS jsonb))
            RETURNING id
        """),
        {
            "content": topic_content,
            "embedding": to_pg_vector(topic_embedding),
            "model": settings.embedding_model,
            "meta": _json.dumps(meta),
        },
    )
    topic_id = topic_row.scalar()

    # Create part_of edges from members to topic
    edges_created = 0
    for engram_id in ids:
        try:
            await _create_edge(session, UUID(engram_id), topic_id, "part_of", 0.7)
            edges_created += 1
        except Exception:
            log.warning(
                "Failed to create part_of edge for topic %s", topic_id, exc_info=True
            )

    # Create related_to edges to anchor entities
    for entity_name in anchors[:5]:
        entity_row = await session.execute(
            text("""
                SELECT id FROM engrams
                WHERE type = 'entity' AND content = :name AND NOT superseded
                LIMIT 1
            """),
            {"name": entity_name},
        )
        entity = entity_row.fetchone()
        if entity:
            try:
                await _create_edge(session, topic_id, entity.id, "related_to", 0.6)
            except Exception:
                pass

    log.info(
        "Created topic '%s' with %d members, %d edges",
        topic_content[:60],
        len(ids),
        edges_created,
    )
    return True


async def _name_topic(
    anchor_entities: list[str],
    sample_contents: list[str],
    needs_careful_naming: bool,
) -> str | None:
    """Use LLM to generate a topic name and summary paragraph."""
    from .decomposition import resolve_model

    anchors_text = (
        ", ".join(anchor_entities[:10])
        if anchor_entities
        else "no clear anchor entities"
    )
    samples_text = "\n".join(f"- {c[:200]}" for c in sample_contents[:10])

    careful_note = ""
    if needs_careful_naming:
        careful_note = (
            "\nNote: This cluster has few shared entities, so take extra care to "
            "identify the unifying theme from the content rather than entity names."
        )

    try:
        model = await resolve_model(settings.engram_consolidation_model)
        async with httpx.AsyncClient(
            base_url=settings.llm_gateway_url, timeout=30.0
        ) as client:
            resp = await client.post(
                "/complete",
                json={
                    "model": model,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                "You are naming a knowledge topic cluster. Generate a short topic name "
                                "(2-5 words) followed by a summary paragraph describing what this "
                                "knowledge domain covers.\n\n"
                                "Format:\n"
                                "TOPIC: <name>\n"
                                "<summary paragraph>" + careful_note
                            ),
                        },
                        {
                            "role": "user",
                            "content": f"Anchor entities: {anchors_text}\n\nSample knowledge:\n{samples_text}",
                        },
                    ],
                    "temperature": 0.3,
                    "max_tokens": settings.engram_schema_max_tokens,
                },
            )
            resp.raise_for_status()
            data = resp.json()

            stop_reason = data.get("stop_reason") or data.get("finish_reason", "")
            if stop_reason in ("length", "max_tokens"):
                log.warning("Topic naming truncated, discarding")
                return None

            content = data.get("content", "")
            if isinstance(content, list):
                content = content[0].get("text", "") if content else ""
            content = content.strip()

            if len(content) < 10:
                return None

            return content
    except Exception:
        log.warning("Topic naming failed", exc_info=True)
        return None


async def assign_new_engrams_to_topics(session: AsyncSession) -> int:
    """Assign recently ingested engrams to existing topics by centroid similarity."""
    import json as _json

    from .ingestion import _create_edge

    unassigned = await session.execute(
        text("""
            SELECT e.id, e.embedding::text
            FROM engrams e
            WHERE NOT e.superseded
              AND e.embedding IS NOT NULL
              AND e.type IN ('fact', 'preference', 'procedure', 'schema')
              AND NOT EXISTS (
                  SELECT 1 FROM engram_edges ee
                  WHERE ee.source_id = e.id AND ee.relation = 'part_of'
              )
              AND e.created_at > NOW() - INTERVAL '7 days'
            LIMIT 100
        """)
    )
    unassigned_rows = unassigned.fetchall()
    if not unassigned_rows:
        return 0

    topics = await session.execute(
        text("""
            SELECT id, content, source_meta
            FROM engrams
            WHERE type = 'topic' AND NOT superseded
        """)
    )
    topic_rows = topics.fetchall()
    if not topic_rows:
        return 0

    topic_centroids = []
    for t in topic_rows:
        meta = (
            t.source_meta
            if isinstance(t.source_meta, dict)
            else _json.loads(t.source_meta or "{}")
        )
        centroid_str = meta.get("centroid")
        if centroid_str:
            topic_centroids.append((t.id, centroid_str))

    if not topic_centroids:
        return 0

    assigned = 0
    for engram_row in unassigned_rows:
        best_topic_id = None
        best_sim = 0.0

        for topic_id, centroid_str in topic_centroids:
            sim_result = await session.execute(
                text("""
                    SELECT 1 - (CAST(:e_emb AS halfvec) <=> CAST(:centroid AS halfvec)) AS sim
                """),
                {"e_emb": engram_row.embedding, "centroid": centroid_str},
            )
            sim = sim_result.scalar() or 0.0
            if sim > best_sim:
                best_sim = sim
                best_topic_id = topic_id

        if best_topic_id and best_sim > settings.engram_topic_assignment_threshold:
            try:
                await _create_edge(
                    session, engram_row.id, best_topic_id, "part_of", 0.7
                )
                assigned += 1
            except Exception:
                pass

    return assigned


async def maintain_topics(session: AsyncSession) -> dict:
    """Maintain existing topics: dissolve small ones, regenerate stale summaries."""
    stats = {"dissolved": 0, "regenerated": 0}

    topics = await session.execute(
        text("""
            SELECT e.id, e.content, e.source_meta,
                   (SELECT count(*) FROM engram_edges ee
                    WHERE ee.target_id = e.id AND ee.relation = 'part_of') AS member_count
            FROM engrams e
            WHERE e.type = 'topic' AND NOT e.superseded
        """)
    )

    import json as _json

    for topic in topics.fetchall():
        if topic.member_count < settings.engram_cluster_min_size:
            await session.execute(
                text("""
                    UPDATE engrams SET superseded = TRUE, updated_at = NOW()
                    WHERE id = CAST(:id AS uuid)
                """),
                {"id": str(topic.id)},
            )
            edge_result = await session.execute(
                text("""
                    DELETE FROM engram_edges
                    WHERE target_id = CAST(:id AS uuid) AND relation = 'part_of'
                """),
                {"id": str(topic.id)},
            )
            edges_removed = edge_result.rowcount
            stats["dissolved"] += 1
            log.info(
                "Dissolved topic '%s' (only %d members, removed %d part_of edges)",
                topic.content[:40],
                topic.member_count,
                edges_removed,
            )
            continue

        meta = (
            topic.source_meta
            if isinstance(topic.source_meta, dict)
            else _json.loads(topic.source_meta or "{}")
        )
        original_count = meta.get("member_count", topic.member_count)
        if original_count > 0:
            change_pct = abs(topic.member_count - original_count) / original_count
            if change_pct > settings.engram_topic_regeneration_pct:
                members = await session.execute(
                    text("""
                        SELECT e.content FROM engram_edges ee
                        JOIN engrams e ON e.id = ee.source_id
                        WHERE ee.target_id = CAST(:tid AS uuid)
                          AND ee.relation = 'part_of'
                          AND NOT e.superseded
                        ORDER BY e.importance DESC
                        LIMIT 10
                    """),
                    {"tid": str(topic.id)},
                )
                sample_contents = [r.content for r in members.fetchall()]
                anchors = meta.get("entity_anchors", [])

                new_content = await _name_topic(
                    anchors, sample_contents, len(anchors) < 2
                )
                if new_content:
                    new_embedding = await get_embedding(new_content, session)
                    meta["member_count"] = topic.member_count

                    # Recompute centroid from current members
                    member_embs = await session.execute(
                        text("""
                            SELECT e.embedding::text FROM engram_edges ee
                            JOIN engrams e ON e.id = ee.source_id
                            WHERE ee.target_id = CAST(:tid AS uuid)
                              AND ee.relation = 'part_of'
                              AND NOT e.superseded
                              AND e.embedding IS NOT NULL
                        """),
                        {"tid": str(topic.id)},
                    )
                    emb_rows = member_embs.fetchall()
                    if emb_rows:
                        emb_arrays = []
                        for r in emb_rows:
                            vec_str = r.embedding.strip("[]")
                            emb_arrays.append([float(x) for x in vec_str.split(",")])
                        centroid = np.mean(emb_arrays, axis=0).tolist()
                        meta["centroid"] = to_pg_vector(centroid)

                    # Check if regenerated embedding now overlaps with another living topic
                    overlap = await session.execute(
                        text("""
                            SELECT id FROM engrams
                            WHERE type = 'topic'
                              AND NOT superseded
                              AND id != CAST(:topic_id AS uuid)
                              AND embedding IS NOT NULL
                              AND 1 - (embedding <=> CAST(:new_emb AS halfvec)) > 0.88
                            LIMIT 1
                        """),
                        {
                            "topic_id": str(topic.id),
                            "new_emb": to_pg_vector(new_embedding),
                        },
                    )
                    overlap_row = overlap.fetchone()
                    if overlap_row:
                        # Dissolve this topic — it now overlaps with an existing one
                        await session.execute(
                            text(
                                "UPDATE engrams SET superseded = TRUE WHERE id = CAST(:id AS uuid)"
                            ),
                            {"id": str(topic.id)},
                        )
                        edge_result = await session.execute(
                            text("""
                                DELETE FROM engram_edges
                                WHERE target_id = CAST(:id AS uuid) AND relation = 'part_of'
                            """),
                            {"id": str(topic.id)},
                        )
                        stats.setdefault("merged_on_regen", 0)
                        stats["merged_on_regen"] += 1
                        log.info(
                            "Dissolved regenerated topic '%s' — overlaps with topic %s",
                            new_content[:40],
                            overlap_row.id,
                        )
                        continue

                    await session.execute(
                        text("""
                            UPDATE engrams
                            SET content = :content,
                                embedding = CAST(:emb AS halfvec),
                                source_meta = CAST(:meta AS jsonb),
                                updated_at = NOW()
                            WHERE id = CAST(:id AS uuid)
                        """),
                        {
                            "id": str(topic.id),
                            "content": new_content,
                            "emb": to_pg_vector(new_embedding),
                            "meta": _json.dumps(meta),
                        },
                    )
                    stats["regenerated"] += 1
                    log.info("Regenerated topic summary: '%s'", new_content[:60])

    return stats
