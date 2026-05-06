"""Unit tests for memory-service/app/engram/clustering.py."""

from __future__ import annotations

import json

import numpy as np
import pytest
from app.config import settings
from app.engram import clustering as clust_mod
from sqlalchemy import text

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _unit_vec(pos: int, dim: int = 768) -> list[float]:
    """Return a unit vector with 1.0 at position *pos*, zeros elsewhere."""
    v = [0.0] * dim
    v[pos] = 1.0
    return v


def _near(
    base: list[float], noise_scale: float = 0.05, *, seed: int = 0
) -> list[float]:
    """Perturb *base* by small Gaussian noise and re-normalise."""
    rng = np.random.default_rng(seed)
    v = np.array(base, dtype=np.float64)
    v += rng.normal(0, noise_scale, len(v))
    norm = np.linalg.norm(v)
    if norm > 0:
        v /= norm
    return v.tolist()


def _stub_get_embedding(text_content, session=None):
    """Deterministic stub: always returns [0.5]*768."""
    return [0.5] * 768


def _stub_name_topic(anchor_entities, sample_contents, needs_careful_naming=False):
    """Deterministic stub: returns a short fixed summary string."""
    return "TOPIC: Test Topic\nThis topic covers test knowledge about the cluster."


async def _stub_get_embedding_async(text_content, session=None):
    return [0.5] * 768


async def _stub_name_topic_async(
    anchor_entities, sample_contents, needs_careful_naming=False
):
    return "TOPIC: Test Topic\nThis topic covers test knowledge about the cluster."


def _patch_clustering(monkeypatch):
    """Apply the standard stubs for LLM + embedding calls in clustering.py."""
    _fix_ingestion_text(monkeypatch)
    monkeypatch.setattr(clust_mod, "get_embedding", _stub_get_embedding_async)
    monkeypatch.setattr(clust_mod, "_name_topic", _stub_name_topic_async)


def _overwrite_settings(monkeypatch, **kwargs):
    """Override settings attributes for test isolation."""
    for k, v in kwargs.items():
        monkeypatch.setattr(settings, k, v)


def _fix_ingestion_text(monkeypatch):
    """Re-inject real sqlalchemy.text into app.engram.ingestion if contaminated.

    ``test_source_kind_mapping.py`` loads ingestion.py with a mock sqlalchemy
    at collection time and leaves the mock-text version in sys.modules. Any
    test that calls _create_edge (via discover_topics or assign_new_engrams_to_topics)
    must call this first.

    MagicMock IS callable, so we compare identity rather than using callable().
    """
    import sys

    import sqlalchemy as _sa

    ing_mod = sys.modules.get("app.engram.ingestion")
    if ing_mod is not None and getattr(ing_mod, "text", None) is not _sa.text:
        monkeypatch.setattr(ing_mod, "text", _sa.text)


# ---------------------------------------------------------------------------
# Cluster discovery (sync _cluster_embeddings)
# ---------------------------------------------------------------------------


def test_three_distinct_clusters_produce_three_topics(monkeypatch):
    """Three well-separated embedding regions → exactly 3 clusters discovered."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=5,
        engram_cluster_umap_neighbors=5,
        engram_cluster_min_size=3,
    )

    rng = np.random.default_rng(42)
    c1 = rng.normal(_unit_vec(0), 0.05, (10, 768)).astype(np.float32)
    c2 = rng.normal(_unit_vec(1), 0.05, (10, 768)).astype(np.float32)
    c3 = rng.normal(_unit_vec(2), 0.05, (10, 768)).astype(np.float32)
    X = np.vstack([c1, c2, c3])
    ids = [str(i) for i in range(30)]

    clusters = clust_mod._cluster_embeddings(X, ids)
    assert len(clusters) == 3


def test_homogeneous_cloud_produces_zero_or_one_topic(monkeypatch):
    """All engrams near the same point → HDBSCAN can't distinguish sub-clusters."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=5,
        engram_cluster_umap_neighbors=5,
        engram_cluster_min_size=5,
    )

    rng = np.random.default_rng(99)
    X = rng.normal(_unit_vec(0), 0.01, (20, 768)).astype(np.float32)
    ids = [str(i) for i in range(20)]

    clusters = clust_mod._cluster_embeddings(X, ids)
    # HDBSCAN either labels everything noise (0 clusters) or lumps into 1
    assert len(clusters) <= 1


def test_clusters_below_min_size_not_promoted(monkeypatch):
    """HDBSCAN noise points (label=-1) are excluded from the returned clusters."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=5,
        engram_cluster_umap_neighbors=5,
        engram_cluster_min_size=8,  # high — most small groups won't qualify
    )

    rng = np.random.default_rng(42)
    # 2 clusters of 10, plus 3 isolated outliers
    c1 = rng.normal(_unit_vec(0), 0.05, (10, 768)).astype(np.float32)
    c2 = rng.normal(_unit_vec(1), 0.05, (10, 768)).astype(np.float32)
    outliers = rng.normal(_unit_vec(2), 0.5, (3, 768)).astype(np.float32)
    X = np.vstack([c1, c2, outliers])
    ids = [str(i) for i in range(23)]

    clusters = clust_mod._cluster_embeddings(X, ids)
    # Each returned cluster must have at least min_cluster_size members
    for c in clusters:
        assert len(c["engram_ids"]) >= 8


# ---------------------------------------------------------------------------
# UMAP shape (sync, deterministic — random_state=42 already pinned in prod)
# ---------------------------------------------------------------------------


def test_umap_reduces_768d_to_configured_dims(monkeypatch):
    """UMAP output has shape (N, engram_cluster_umap_dims)."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=5,
        engram_cluster_umap_neighbors=5,
        engram_cluster_min_size=3,
    )

    from umap import UMAP

    n_samples = 20
    X = np.random.default_rng(0).normal(0, 1, (n_samples, 768)).astype(np.float32)
    reducer = UMAP(
        n_components=settings.engram_cluster_umap_dims,
        n_neighbors=settings.engram_cluster_umap_neighbors,
        metric="cosine",
        random_state=42,
    )
    reduced = reducer.fit_transform(X)
    assert reduced.shape == (n_samples, settings.engram_cluster_umap_dims)


def test_umap_uses_configured_neighbors(monkeypatch):
    """UMAP reads n_neighbors from settings — verify output shape is still (N, dims)."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=3,
        engram_cluster_umap_neighbors=3,
        engram_cluster_min_size=3,
    )

    from umap import UMAP

    X = np.random.default_rng(7).normal(0, 1, (15, 768)).astype(np.float32)
    reducer = UMAP(
        n_components=settings.engram_cluster_umap_dims,
        n_neighbors=settings.engram_cluster_umap_neighbors,
        metric="cosine",
        random_state=42,
    )
    reduced = reducer.fit_transform(X)
    assert reduced.shape[1] == settings.engram_cluster_umap_dims


# ---------------------------------------------------------------------------
# Topic engram creation (DB-backed)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_topic_engram_has_type_topic(db_session, engram_factory, monkeypatch):
    """discover_topics() creates engrams with type='topic'."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=5,
        engram_cluster_umap_neighbors=5,
        engram_cluster_min_size=5,
    )
    _patch_clustering(monkeypatch)

    rng = np.random.default_rng(42)
    for i in range(10):
        cluster_idx = i % 2
        emb = rng.normal(_unit_vec(cluster_idx), 0.05, (768,)).tolist()
        await engram_factory(content=f"fact-{i}", type="fact", embedding=emb)
    await db_session.flush()

    topics_created = await clust_mod.discover_topics(db_session)
    assert topics_created >= 1

    row = await db_session.execute(
        text("SELECT count(*) FROM engrams WHERE type = 'topic'")
    )
    assert row.scalar() >= 1


@pytest.mark.asyncio
async def test_topic_engram_summary_is_non_empty(
    db_session, engram_factory, monkeypatch
):
    """Topics created by discover_topics() have non-empty content."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=5,
        engram_cluster_umap_neighbors=5,
        engram_cluster_min_size=5,
    )
    _patch_clustering(monkeypatch)

    rng = np.random.default_rng(42)
    for i in range(10):
        cluster_idx = i % 2
        emb = rng.normal(_unit_vec(cluster_idx), 0.05, (768,)).tolist()
        await engram_factory(content=f"fact-{i}", type="fact", embedding=emb)
    await db_session.flush()

    await clust_mod.discover_topics(db_session)

    rows = await db_session.execute(
        text("SELECT content FROM engrams WHERE type = 'topic'")
    )
    for r in rows.fetchall():
        assert r.content and len(r.content) > 0


@pytest.mark.asyncio
async def test_topic_engram_links_to_member_engrams_via_part_of_edges(
    db_session, engram_factory, monkeypatch
):
    """Each member engram gets a part_of edge pointing to the created topic."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=5,
        engram_cluster_umap_neighbors=5,
        engram_cluster_min_size=5,
    )
    _patch_clustering(monkeypatch)

    rng = np.random.default_rng(42)
    member_ids = []
    for i in range(10):
        cluster_idx = i % 2
        emb = rng.normal(_unit_vec(cluster_idx), 0.05, (768,)).tolist()
        eid = await engram_factory(content=f"fact-{i}", type="fact", embedding=emb)
        member_ids.append(eid)
    await db_session.flush()

    topics_created = await clust_mod.discover_topics(db_session)
    assert topics_created >= 1

    # At least some members should have part_of edges
    part_of_rows = await db_session.execute(
        text("SELECT count(*) FROM engram_edges WHERE relation = 'part_of'")
    )
    assert part_of_rows.scalar() >= 1


# ---------------------------------------------------------------------------
# Reassignment (assign_new_engrams_to_topics)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_new_engram_near_centroid_joined_to_topic(
    db_session, engram_factory, monkeypatch
):
    """An unassigned engram whose embedding is close to a topic centroid gets assigned."""
    _fix_ingestion_text(monkeypatch)
    _overwrite_settings(monkeypatch, engram_topic_assignment_threshold=0.5)

    # Create a topic engram with a centroid in source_meta
    centroid = _unit_vec(0)
    centroid_str = "[" + ",".join(f"{v:.6f}" for v in centroid) + "]"
    topic_id = await engram_factory(
        content="TOPIC: Test\nSome topic.",
        type="topic",
        embedding=centroid,
        source_type="consolidation",
    )
    # Write source_meta with centroid (simulate what _create_topic_engram stores)
    meta = {
        "member_count": 6,
        "entity_anchors": [],
        "cluster_method": "hdbscan+entity+llm",
        "centroid": centroid_str,
    }
    await db_session.execute(
        text(
            "UPDATE engrams SET source_meta = CAST(:m AS jsonb) WHERE id = CAST(:id AS uuid)"
        ),
        {"m": json.dumps(meta), "id": str(topic_id)},
    )
    await db_session.flush()

    # New fact engram, very close to the topic centroid, no part_of edge yet
    near_emb = _near(centroid, noise_scale=0.01, seed=1)
    fact_id = await engram_factory(
        content="new fact near topic", type="fact", embedding=near_emb
    )
    await db_session.flush()

    assigned = await clust_mod.assign_new_engrams_to_topics(db_session)
    assert assigned >= 1

    edge_row = await db_session.execute(
        text(
            "SELECT count(*) FROM engram_edges "
            "WHERE source_id = CAST(:src AS uuid) AND relation = 'part_of'"
        ),
        {"src": str(fact_id)},
    )
    assert edge_row.scalar() == 1


@pytest.mark.asyncio
async def test_new_engram_far_from_all_centroids_not_assigned(
    db_session, engram_factory, monkeypatch
):
    """An unassigned engram whose embedding is far from all topic centroids stays unassigned."""
    _fix_ingestion_text(monkeypatch)
    _overwrite_settings(monkeypatch, engram_topic_assignment_threshold=0.5)

    # Topic centroid at unit vec 0
    centroid = _unit_vec(0)
    centroid_str = "[" + ",".join(f"{v:.6f}" for v in centroid) + "]"
    topic_id = await engram_factory(
        content="TOPIC: Test\nSome topic.",
        type="topic",
        embedding=centroid,
        source_type="consolidation",
    )
    meta = {
        "member_count": 6,
        "entity_anchors": [],
        "cluster_method": "hdbscan+entity+llm",
        "centroid": centroid_str,
    }
    await db_session.execute(
        text(
            "UPDATE engrams SET source_meta = CAST(:m AS jsonb) WHERE id = CAST(:id AS uuid)"
        ),
        {"m": json.dumps(meta), "id": str(topic_id)},
    )
    await db_session.flush()

    # Engram in completely orthogonal direction (unit vec 1) — cosine sim ≈ 0
    far_emb = _unit_vec(1)
    fact_id = await engram_factory(
        content="distant fact", type="fact", embedding=far_emb
    )
    await db_session.flush()

    assigned = await clust_mod.assign_new_engrams_to_topics(db_session)
    assert assigned == 0

    edge_row = await db_session.execute(
        text(
            "SELECT count(*) FROM engram_edges "
            "WHERE source_id = CAST(:src AS uuid) AND relation = 'part_of'"
        ),
        {"src": str(fact_id)},
    )
    assert edge_row.scalar() == 0


@pytest.mark.asyncio
async def test_topic_assignment_threshold_respected(
    db_session, engram_factory, monkeypatch
):
    """Lowering the threshold to 0.9 rejects an engram that 0.5 would accept."""
    _fix_ingestion_text(monkeypatch)
    # Engram at moderate angle from centroid — sim ~0.7
    centroid = _unit_vec(0)
    centroid_str = "[" + ",".join(f"{v:.6f}" for v in centroid) + "]"

    # Construct an embedding that has cosine sim ~0.7 with centroid
    # Mix of dim0 and dim1: [cos(theta), sin(theta), 0, ...]
    import math

    theta = math.acos(0.7)
    moderate_emb = [0.0] * 768
    moderate_emb[0] = math.cos(theta)
    moderate_emb[1] = math.sin(theta)

    topic_id = await engram_factory(
        content="TOPIC: Test\nSome topic.",
        type="topic",
        embedding=centroid,
        source_type="consolidation",
    )
    meta = {
        "member_count": 6,
        "entity_anchors": [],
        "cluster_method": "hdbscan+entity+llm",
        "centroid": centroid_str,
    }
    await db_session.execute(
        text(
            "UPDATE engrams SET source_meta = CAST(:m AS jsonb) WHERE id = CAST(:id AS uuid)"
        ),
        {"m": json.dumps(meta), "id": str(topic_id)},
    )
    await db_session.flush()

    fact_id = await engram_factory(
        content="moderate angle fact", type="fact", embedding=moderate_emb
    )
    await db_session.flush()

    # With threshold=0.5: should assign (sim ~0.7 > 0.5)
    _overwrite_settings(monkeypatch, engram_topic_assignment_threshold=0.5)
    assigned = await clust_mod.assign_new_engrams_to_topics(db_session)
    assert assigned == 1

    # Remove the edge so we can test the other direction
    await db_session.execute(
        text(
            "DELETE FROM engram_edges WHERE source_id = CAST(:src AS uuid) AND relation = 'part_of'"
        ),
        {"src": str(fact_id)},
    )
    await db_session.flush()

    # With threshold=0.9: should NOT assign (sim ~0.7 < 0.9)
    _overwrite_settings(monkeypatch, engram_topic_assignment_threshold=0.9)
    assigned2 = await clust_mod.assign_new_engrams_to_topics(db_session)
    assert assigned2 == 0


# ---------------------------------------------------------------------------
# Regeneration trigger (maintain_topics)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_30pct_membership_change_triggers_resummary(
    db_session, engram_factory, edge_factory, monkeypatch
):
    """When current member count differs from stored member_count by >30%, resummary fires."""
    _patch_clustering(monkeypatch)

    # Create a topic with stored member_count=10
    centroid = _unit_vec(3)
    centroid_str = "[" + ",".join(f"{v:.6f}" for v in centroid) + "]"
    topic_id = await engram_factory(
        content="TOPIC: OldName\nOld summary.",
        type="topic",
        embedding=centroid,
        source_type="consolidation",
    )
    meta = {
        "member_count": 10,
        "entity_anchors": ["foo"],
        "cluster_method": "hdbscan+entity+llm",
        "centroid": centroid_str,
    }
    await db_session.execute(
        text(
            "UPDATE engrams SET source_meta = CAST(:m AS jsonb) WHERE id = CAST(:id AS uuid)"
        ),
        {"m": json.dumps(meta), "id": str(topic_id)},
    )
    await db_session.flush()

    # Give it 15 actual members via part_of edges (change = |15-10|/10 = 50% > 30%)
    for i in range(15):
        member_id = await engram_factory(
            content=f"member-{i}", type="fact", embedding=_unit_vec(3)
        )
        await edge_factory(source=member_id, target=topic_id, relation="part_of")
    await db_session.flush()

    stats = await clust_mod.maintain_topics(db_session)
    assert stats["regenerated"] >= 1


@pytest.mark.asyncio
async def test_under_30pct_change_does_not_trigger(
    db_session, engram_factory, edge_factory, monkeypatch
):
    """When membership change is <30%, resummary does NOT fire."""
    _patch_clustering(monkeypatch)

    centroid = _unit_vec(4)
    centroid_str = "[" + ",".join(f"{v:.6f}" for v in centroid) + "]"
    topic_id = await engram_factory(
        content="TOPIC: StableName\nStable summary.",
        type="topic",
        embedding=centroid,
        source_type="consolidation",
    )
    # stored member_count=10; actual=11 → change=10% < 30%
    meta = {
        "member_count": 10,
        "entity_anchors": ["bar"],
        "cluster_method": "hdbscan+entity+llm",
        "centroid": centroid_str,
    }
    await db_session.execute(
        text(
            "UPDATE engrams SET source_meta = CAST(:m AS jsonb) WHERE id = CAST(:id AS uuid)"
        ),
        {"m": json.dumps(meta), "id": str(topic_id)},
    )
    await db_session.flush()

    for i in range(11):
        member_id = await engram_factory(
            content=f"stable-member-{i}", type="fact", embedding=_unit_vec(4)
        )
        await edge_factory(source=member_id, target=topic_id, relation="part_of")
    await db_session.flush()

    stats = await clust_mod.maintain_topics(db_session)
    assert stats.get("regenerated", 0) == 0


# ---------------------------------------------------------------------------
# Edge cases
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_engram_set_returns_no_topics(db_session, monkeypatch):
    """With no eligible engrams, discover_topics() returns 0."""
    _patch_clustering(monkeypatch)
    result = await clust_mod.discover_topics(db_session)
    assert result == 0


@pytest.mark.asyncio
async def test_all_identical_embeddings_produces_zero_topics(
    db_session, engram_factory, monkeypatch
):
    """Engrams with near-identical embeddings yield 0 distinguishable clusters."""
    _overwrite_settings(
        monkeypatch,
        engram_cluster_umap_dims=5,
        engram_cluster_umap_neighbors=5,
        engram_cluster_min_size=5,
    )
    _patch_clustering(monkeypatch)

    base = _unit_vec(0)
    rng = np.random.default_rng(0)
    for i in range(15):
        emb = rng.normal(base, 0.001, (768,)).tolist()
        await engram_factory(content=f"identical-{i}", type="fact", embedding=emb)
    await db_session.flush()

    topics_created = await clust_mod.discover_topics(db_session)
    assert topics_created == 0
