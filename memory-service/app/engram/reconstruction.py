"""
Memory reconstruction engine — Phase 2 of the Engram Network.

Assembles coherent memories from activated engram fragments. Two modes:
  - Template assembly (fast, no LLM, default)
  - Narrative reconstruction (LLM-powered, for dense clusters)

Reconstruction is ephemeral — the output is injected into the prompt
but never stored back to the graph. The engram fragments remain the
source of truth.
"""

from __future__ import annotations

import logging
from collections import defaultdict

from app.config import settings
from app.http_client import get_http_client
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .activation import ActivatedEngram

log = logging.getLogger(__name__)

# Edge relation → natural language connector
RELATION_CONNECTORS = {
    "caused_by": "because",
    "preceded": "before that",
    "enables": "which enables",
    "part_of": "as part of",
    "instance_of": "as an example of",
    "contradicts": "however",
    "related_to": "also",
    "analogous_to": "similarly",
}


async def _semantic_dedup(
    session: AsyncSession, engrams: list[ActivatedEngram]
) -> list[ActivatedEngram]:
    """Remove semantic duplicates by embedding cosine similarity.

    Fetches embeddings for activated engrams, groups by >0.85 similarity,
    keeps only the highest-scored engram per group.
    """
    if len(engrams) <= 1:
        return engrams

    ids = [e.id for e in engrams]
    id_to_engram = {e.id: e for e in engrams}

    # Fetch embeddings for all activated engrams
    # Use IN clause with individual CAST params (asyncpg doesn't handle list→uuid[])
    placeholders = ", ".join(f"CAST(:id_{i} AS uuid)" for i in range(len(ids)))
    params = {f"id_{i}": ids[i] for i in range(len(ids))}
    result = await session.execute(
        text(f"""
            SELECT id::text, embedding::text
            FROM engrams
            WHERE id IN ({placeholders})
              AND embedding IS NOT NULL
        """),
        params,
    )
    rows = result.fetchall()

    # Parse embeddings into float arrays
    id_to_emb: dict[str, list[float]] = {}
    for row in rows:
        try:
            # pgvector text format: "[0.1,0.2,...]"
            emb_str = row.embedding.strip("[]")
            id_to_emb[row.id] = [float(x) for x in emb_str.split(",")]
        except Exception:
            continue

    if len(id_to_emb) < 2:
        return engrams

    # Group by similarity — simple greedy clustering
    # Sorted by final_score so the best engram becomes the cluster representative
    sorted_engrams = sorted(engrams, key=lambda e: e.final_score, reverse=True)
    kept: list[ActivatedEngram] = []
    consumed: set[str] = set()

    for e in sorted_engrams:
        if e.id in consumed:
            continue
        kept.append(e)
        consumed.add(e.id)

        if e.id not in id_to_emb:
            continue

        # Mark similar engrams as consumed
        e_emb = id_to_emb[e.id]
        e_mag = sum(x * x for x in e_emb) ** 0.5
        if e_mag < 1e-9:
            continue
        for other in sorted_engrams:
            if other.id in consumed or other.id not in id_to_emb:
                continue
            o_emb = id_to_emb[other.id]
            o_mag = sum(x * x for x in o_emb) ** 0.5
            if o_mag < 1e-9:
                continue
            # Cosine similarity (halfvec embeddings are NOT L2-normalized)
            cos_sim = sum(a * b for a, b in zip(e_emb, o_emb)) / (e_mag * o_mag)
            if cos_sim > 0.80:
                consumed.add(other.id)

    return kept


async def reconstruct(
    session: AsyncSession,
    activated: list[ActivatedEngram],
    context: str = "",
    self_model_summary: str = "",
) -> str:
    """Reconstruct coherent memory text from activated engrams.

    Template assembly only — LLM narrative reconstruction was removed
    (it hallucinated false connections between unrelated memories).
    """
    if not activated:
        return ""

    # Semantic dedup — remove near-duplicate engrams by embedding similarity
    activated = await _semantic_dedup(session, activated)

    # Find clusters of interconnected engrams
    clusters = await _find_clusters(session, activated)

    parts: list[str] = []
    for cluster in clusters:
        assembled = _template_assemble(cluster)
        if assembled:
            parts.append(assembled)

    return "\n\n".join(parts)


async def _find_clusters(
    session: AsyncSession,
    activated: list[ActivatedEngram],
) -> list[list[ActivatedEngram]]:
    """Group activated engrams into connected clusters using their edges.

    Returns list of clusters, each a list of ActivatedEngrams.
    Isolated engrams form singleton clusters.
    """
    if not activated:
        return []

    ids = [a.id for a in activated]
    id_to_engram = {a.id: a for a in activated}

    # Fetch edges between activated engrams
    result = await session.execute(
        text("""
            SELECT source_id::text, target_id::text, relation, weight
            FROM engram_edges
            WHERE source_id = ANY(CAST(:ids AS uuid[]))
              AND target_id = ANY(CAST(:ids AS uuid[]))
        """),
        {"ids": ids},
    )
    edges = result.fetchall()

    # Union-Find for clustering
    parent: dict[str, str] = {id: id for id in ids}

    def find(x: str) -> str:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: str, b: str) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for edge in edges:
        src, tgt = str(edge.source_id), str(edge.target_id)
        if src in id_to_engram and tgt in id_to_engram:
            union(src, tgt)

    # Group by cluster root
    groups: dict[str, list[ActivatedEngram]] = defaultdict(list)
    for id in ids:
        root = find(id)
        groups[root].append(id_to_engram[id])

    # Sort clusters by max activation (most relevant first)
    clusters = sorted(
        groups.values(),
        key=lambda c: max(e.final_score for e in c),
        reverse=True,
    )
    return clusters


def _template_assemble(cluster: list[ActivatedEngram]) -> str:
    """Fast template-based assembly. No LLM call.

    Groups by type, orders by activation, uses first-person perspective.
    """
    if not cluster:
        return ""

    # Sort by activation (most relevant first)
    ordered = sorted(cluster, key=lambda e: e.final_score, reverse=True)

    # Deduplicate near-identical content within the cluster
    seen_fingerprints: set[str] = set()
    deduped: list[ActivatedEngram] = []
    for e in ordered:
        fp = e.content[:100].strip().lower()
        if fp not in seen_fingerprints:
            seen_fingerprints.add(fp)
            deduped.append(e)
    ordered = deduped

    # Source attribution — personal sources render clean, others get a tag
    def _fmt(e: ActivatedEngram) -> str:
        if e.source_type in ("chat", "consolidation", "self_reflection"):
            return f"- {e.content}"
        return f"- [{e.source_type}] {e.content}"

    # Group by type for structured output
    by_type: dict[str, list[ActivatedEngram]] = defaultdict(list)
    for engram in ordered:
        by_type[engram.type].append(engram)

    lines: list[str] = []

    # Facts first
    if "fact" in by_type:
        for e in by_type["fact"]:
            lines.append(_fmt(e))

    # Preferences
    if "preference" in by_type:
        for e in by_type["preference"]:
            lines.append(_fmt(e))

    # Episodes (with temporal framing)
    if "episode" in by_type:
        for e in by_type["episode"]:
            lines.append(_fmt(e))

    # Procedures
    if "procedure" in by_type:
        for e in by_type["procedure"]:
            lines.append(_fmt(e))

    # Schemas (generalized patterns)
    if "schema" in by_type:
        for e in by_type["schema"]:
            if e.source_type in ("chat", "consolidation", "self_reflection"):
                lines.append(f"- Pattern: {e.content}")
            else:
                lines.append(f"- [{e.source_type}] Pattern: {e.content}")

    # Entities (brief mentions)
    if "entity" in by_type:
        entities = by_type["entity"][:5]
        if entities:
            # Tag with source if any non-personal entities are present
            has_external = any(
                e.source_type not in ("chat", "consolidation", "self_reflection")
                for e in entities
            )
            entity_names = [e.content for e in entities]
            if has_external:
                lines.append(f"- [mixed] Related: {', '.join(entity_names)}")
            else:
                lines.append(f"- Related: {', '.join(entity_names)}")

    # Goals
    if "goal" in by_type:
        for e in by_type["goal"]:
            if e.source_type in ("chat", "consolidation", "self_reflection"):
                lines.append(f"- Goal: {e.content}")
            else:
                lines.append(f"- [{e.source_type}] Goal: {e.content}")

    # Self-model entries
    if "self_model" in by_type:
        for e in by_type["self_model"]:
            lines.append(_fmt(e))

    return "\n".join(lines)


async def get_self_model_summary(session: AsyncSession) -> str:
    """Retrieve a concise summary of Nova's self-model engrams."""
    result = await session.execute(
        text("""
            SELECT content FROM engrams
            WHERE type = 'self_model'
              AND NOT superseded
            ORDER BY importance DESC, activation DESC
            LIMIT 10
        """)
    )
    rows = result.fetchall()
    if not rows:
        return "I am Nova, a helpful AI assistant with persistent memory."

    return " ".join(row.content for row in rows)
