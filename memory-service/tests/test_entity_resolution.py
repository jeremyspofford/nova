"""Unit tests for memory-service/app/engram/entity_resolution.py.

Tests run against a real pgvector Postgres instance (nova_test).
Each test is wrapped in a BEGIN…ROLLBACK transaction so nothing persists.

Embedding notes:
  - halfvec(768) — all factory embeddings must be exactly 768 floats.
  - Cosine similarity between two unit vectors equals their dot product.
    _unit_vec(i) · _unit_vec(i)  = 1.0  (identical)
    _unit_vec(i) · _unit_vec(j)  = 0.0  (orthogonal, maximally dissimilar)
    A blended vector near position i with weight w gives similarity w to _unit_vec(i).
"""

from __future__ import annotations

import math

from app.config import settings
from app.engram.entity_resolution import (
    find_contradiction_candidates,
    find_existing_entity,
    find_similar_engram,
    find_similar_engram_any_type,
    update_existing_engram,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_DIM = 768
_DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001"


def _unit_vec(pos: int, dim: int = _DIM) -> list[float]:
    """Unit vector with 1.0 at *pos*, zeros elsewhere.

    Two unit vectors i and j have cosine similarity 1.0 if i==j, 0.0 if i!=j.
    """
    v = [0.0] * dim
    v[pos] = 1.0
    return v


def _blend(a: list[float], b: list[float], t: float) -> list[float]:
    """Linear blend: result = (1-t)*a + t*b, then L2-normalised.

    cosine_similarity(result, a) ≈ (1-t) when a and b are orthogonal unit vecs.
    Use this to craft a vector with a precise similarity to *a*.
    """
    blended = [(1.0 - t) * ai + t * bi for ai, bi in zip(a, b)]
    norm = math.sqrt(sum(x * x for x in blended))
    return [x / norm for x in blended]


# ---------------------------------------------------------------------------
# find_existing_entity — exact-name dedup
# ---------------------------------------------------------------------------


async def test_exact_name_match_returns_existing_entity(db_session, engram_factory):
    """find_existing_entity returns a matching entity for exact (case-insensitive) name."""
    await engram_factory(content="Alice Smith", type="entity")
    result = await find_existing_entity(db_session, "Alice Smith")
    assert result is not None
    assert result["content"] == "Alice Smith"


async def test_exact_name_match_is_case_insensitive(db_session, engram_factory):
    """Lookup normalises both sides to lowercase before comparing."""
    await engram_factory(content="Bob Jones", type="entity")
    result = await find_existing_entity(db_session, "bob jones")
    assert result is not None
    assert result["content"] == "Bob Jones"


async def test_exact_name_no_match_returns_none(db_session, engram_factory):
    """find_existing_entity returns None when no entity with that name exists."""
    await engram_factory(content="Charlie Brown", type="entity")
    result = await find_existing_entity(db_session, "Charlie White")
    assert result is None


async def test_superseded_entity_not_returned(db_session, engram_factory):
    """Superseded rows are excluded — dedup should not point to dead nodes."""
    await engram_factory(content="Diana Prince", type="entity", superseded=True)
    result = await find_existing_entity(db_session, "Diana Prince")
    assert result is None


async def test_non_entity_type_not_returned_by_exact_match(db_session, engram_factory):
    """find_existing_entity is scoped to type='entity'; facts/episodes are ignored."""
    await engram_factory(content="Eric Cartman", type="fact")
    result = await find_existing_entity(db_session, "Eric Cartman")
    assert result is None


# ---------------------------------------------------------------------------
# find_similar_engram — embedding-similarity dedup (same type)
# ---------------------------------------------------------------------------


async def test_similar_engram_above_threshold_returns_match(db_session, engram_factory):
    """find_similar_engram returns a row when similarity > threshold."""
    vec = _unit_vec(0)
    await engram_factory(content="existing entity A", type="entity", embedding=vec)

    # Query with the identical vector → similarity == 1.0 (well above 0.92)
    result = await find_similar_engram(db_session, vec, "entity", threshold=0.92)
    assert result is not None
    assert result["content"] == "existing entity A"
    assert result["similarity"] >= 0.92


async def test_similar_engram_below_threshold_returns_none(db_session, engram_factory):
    """find_similar_engram returns None when best match is below the threshold."""
    vec_a = _unit_vec(1)
    vec_b = _unit_vec(2)
    # vec_a and vec_b are orthogonal → similarity == 0.0
    await engram_factory(content="existing entity B", type="entity", embedding=vec_a)

    result = await find_similar_engram(db_session, vec_b, "entity", threshold=0.92)
    assert result is None


async def test_similar_engram_just_above_threshold(db_session, engram_factory):
    """A blend that produces similarity ~0.97 is above the 0.92 default threshold.

    Two orthogonal unit vecs (pos 3, pos 4).  blend(t=0.20) gives:
        unnormed = [0.8, 0.2, 0, …]  norm = sqrt(0.64+0.04) ≈ 0.8246
        cosine(blended, vec_base) = 0.8/0.8246 ≈ 0.970  (above 0.92)
    """
    vec_base = _unit_vec(3)
    vec_other = _unit_vec(4)
    query_vec = _blend(vec_base, vec_other, 0.20)
    await engram_factory(content="existing entity C", type="entity", embedding=vec_base)

    result = await find_similar_engram(db_session, query_vec, "entity", threshold=0.92)
    assert result is not None
    assert result["similarity"] >= 0.92


async def test_similar_engram_just_below_threshold(db_session, engram_factory):
    """A blend that produces similarity ~0.85 stays below the 0.92 default threshold."""
    vec_base = _unit_vec(5)
    vec_other = _unit_vec(6)
    # t=0.55 → cosine(blended, vec_base) = 0.45/norm ≈ 0.632  (safely below 0.92)
    query_vec = _blend(vec_base, vec_other, 0.55)
    await engram_factory(content="existing entity D", type="entity", embedding=vec_base)

    result = await find_similar_engram(db_session, query_vec, "entity", threshold=0.92)
    assert result is None


async def test_different_type_not_matched_by_find_similar_engram(
    db_session, engram_factory
):
    """find_similar_engram is type-scoped — a 'fact' is invisible to an 'entity' query."""
    vec = _unit_vec(7)
    await engram_factory(
        content="a fact with same embedding", type="fact", embedding=vec
    )

    # Searching for 'entity' type should not find the 'fact' row
    result = await find_similar_engram(db_session, vec, "entity", threshold=0.80)
    assert result is None


async def test_no_embedding_row_skips_resolution(db_session, engram_factory):
    """An engram with NULL embedding is excluded from similarity search."""
    # Insert an entity WITHOUT an embedding
    await engram_factory(content="entity without embedding", type="entity")

    # Query with any vector — the NULL-embedding row must not be returned
    vec = _unit_vec(8)
    result = await find_similar_engram(db_session, vec, "entity", threshold=0.0)
    assert result is None


# ---------------------------------------------------------------------------
# find_similar_engram_any_type — cross-type dedup
# ---------------------------------------------------------------------------


async def test_find_similar_any_type_crosses_type_boundary(db_session, engram_factory):
    """find_similar_engram_any_type finds a 'fact' when querying with an entity embedding."""
    vec = _unit_vec(9)
    await engram_factory(
        content="The user's name is Jeremy", type="fact", embedding=vec
    )

    result = await find_similar_engram_any_type(db_session, vec, threshold=0.92)
    assert result is not None
    assert result["type"] == "fact"


async def test_find_similar_any_type_below_threshold_returns_none(
    db_session, engram_factory
):
    """Cross-type search also respects the threshold — no false positives."""
    vec_a = _unit_vec(10)
    vec_b = _unit_vec(11)
    await engram_factory(content="some fact", type="fact", embedding=vec_a)

    result = await find_similar_engram_any_type(db_session, vec_b, threshold=0.92)
    assert result is None


# ---------------------------------------------------------------------------
# update_existing_engram — ACT-R access boost
# ---------------------------------------------------------------------------


async def test_update_increments_access_count(db_session, engram_factory):
    """update_existing_engram increments access_count by 1."""
    from sqlalchemy import text

    eid = await engram_factory(content="update-me", type="entity", access_count=3)
    await update_existing_engram(db_session, eid)

    row = await db_session.execute(
        text("SELECT access_count FROM engrams WHERE id = CAST(:id AS uuid)"),
        {"id": str(eid)},
    )
    assert row.scalar() == 4


async def test_update_boosts_activation(db_session, engram_factory):
    """update_existing_engram applies ACT-R formula: new = LEAST(1, old + 0.1*(1-old))."""
    from sqlalchemy import text

    initial_activation = 0.5
    eid = await engram_factory(
        content="activation-test", type="entity", activation=initial_activation
    )
    await update_existing_engram(db_session, eid)

    row = await db_session.execute(
        text("SELECT activation FROM engrams WHERE id = CAST(:id AS uuid)"),
        {"id": str(eid)},
    )
    new_activation = row.scalar()
    expected = initial_activation + 0.1 * (1.0 - initial_activation)
    assert abs(new_activation - expected) < 1e-4


async def test_update_content_when_provided(db_session, engram_factory):
    """update_existing_engram replaces content when new_content is given."""
    from sqlalchemy import text

    eid = await engram_factory(content="old content", type="entity")
    await update_existing_engram(db_session, eid, new_content="new content")

    row = await db_session.execute(
        text("SELECT content FROM engrams WHERE id = CAST(:id AS uuid)"),
        {"id": str(eid)},
    )
    assert row.scalar() == "new content"


# ---------------------------------------------------------------------------
# find_contradiction_candidates
# ---------------------------------------------------------------------------


async def test_contradiction_candidates_above_threshold_returned(
    db_session, engram_factory
):
    """find_contradiction_candidates returns fact-type rows above the threshold."""
    vec = _unit_vec(20)
    await engram_factory(content="The sky is blue", type="fact", embedding=vec)

    # Contradiction threshold is 0.85; querying with identical vector → similarity 1.0
    candidates = await find_contradiction_candidates(
        db_session, vec, content_hint="The sky is green"
    )
    assert len(candidates) >= 1
    assert any(c["content"] == "The sky is blue" for c in candidates)


async def test_contradiction_candidates_non_fact_excluded(db_session, engram_factory):
    """find_contradiction_candidates ignores non-fact engrams."""
    vec = _unit_vec(21)
    await engram_factory(content="Jeremy is a person", type="entity", embedding=vec)

    candidates = await find_contradiction_candidates(
        db_session, vec, content_hint="hint"
    )
    assert all(c["content"] != "Jeremy is a person" for c in candidates)


async def test_contradiction_candidates_below_threshold_excluded(
    db_session, engram_factory
):
    """Fact rows below contradiction_threshold are not returned."""
    vec_a = _unit_vec(22)
    vec_b = _unit_vec(23)  # orthogonal — similarity 0.0
    await engram_factory(content="Some distant fact", type="fact", embedding=vec_a)

    candidates = await find_contradiction_candidates(
        db_session, vec_b, content_hint="hint"
    )
    assert all(c["content"] != "Some distant fact" for c in candidates)


async def test_contradiction_uses_settings_threshold(
    db_session, engram_factory, monkeypatch
):
    """Contradiction search uses settings.engram_contradiction_similarity_threshold."""
    # Set a very high threshold (1.0) — only exact matches qualify
    monkeypatch.setattr(settings, "engram_contradiction_similarity_threshold", 1.0)

    vec_base = _unit_vec(24)
    vec_other = _unit_vec(25)
    # Blend → similarity ~0.95 to vec_base; below the new threshold of 1.0
    query_vec = _blend(vec_base, vec_other, 0.30)
    await engram_factory(content="near-miss fact", type="fact", embedding=vec_base)

    candidates = await find_contradiction_candidates(
        db_session, query_vec, content_hint="hint"
    )
    assert all(c["content"] != "near-miss fact" for c in candidates)
