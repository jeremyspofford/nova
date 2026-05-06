"""Contract tests for consolidation merge + schema-synth (P2 + P4 invariants)."""

from __future__ import annotations

import pytest
from sqlalchemy import text


class _ExecuteSpy:
    """Wraps an AsyncSession to record execute() calls without mocking it.

    The wrapped session is real (no mock); .execute() forwards to the real
    session and records the statement. Used by P4 contract test to assert
    schema synthesis makes 1 batched call instead of N.
    """

    def __init__(self, real_session):
        self._session = real_session
        self.calls: list[str] = []

    async def execute(self, statement, params=None):
        self.calls.append(str(statement))
        if params is None:
            return await self._session.execute(statement)
        return await self._session.execute(statement, params)

    def __getattr__(self, name):
        return getattr(self._session, name)


@pytest.mark.asyncio
async def test_merge_correctness_highest_access_wins(db_session, engram_factory):
    """Of three near-duplicates, the one with highest access_count survives (rest superseded)."""
    emb_base = [0.5] * 768
    a = await engram_factory(content="a", embedding=emb_base, access_count=10)
    b = await engram_factory(
        content="b", embedding=[0.5] * 767 + [0.501], access_count=5
    )
    c = await engram_factory(
        content="c", embedding=[0.5] * 766 + [0.501, 0.501], access_count=2
    )
    await db_session.flush()

    from app.engram.consolidation import _merge_duplicates

    await _merge_duplicates(db_session)
    await db_session.flush()

    rows = await db_session.execute(
        text(
            "SELECT content, superseded FROM engrams WHERE content IN ('a', 'b', 'c') ORDER BY content"
        )
    )
    state = {r.content: r.superseded for r in rows}
    assert state["a"] is False
    assert state["b"] is True
    assert state["c"] is True


@pytest.mark.asyncio
async def test_edge_repointing_no_unique_violation(
    db_session, engram_factory, edge_factory
):
    """When a loser's edges re-point to the winner, existing edges with same (source, target, relation) are skipped."""
    emb_base = [0.5] * 768
    winner = await engram_factory(content="winner", embedding=emb_base, access_count=10)
    loser = await engram_factory(
        content="loser", embedding=[0.5] * 767 + [0.501], access_count=1
    )
    sink = await engram_factory(content="sink", embedding=[0.0] * 767 + [1.0])

    # Both winner and loser already have edges to sink — re-pointing loser's edge
    # would create a duplicate, but the function's NOT EXISTS guard should skip it.
    await edge_factory(source=winner, target=sink, relation="related_to", weight=0.5)
    await edge_factory(source=loser, target=sink, relation="related_to", weight=0.5)
    await db_session.flush()

    from app.engram.consolidation import _merge_duplicates

    await _merge_duplicates(db_session)
    await db_session.flush()

    # After merge: only ONE edge from winner→sink should exist
    edges = await db_session.execute(
        text(
            "SELECT count(*) FROM engram_edges "
            "WHERE source_id = CAST(:w AS uuid) AND target_id = CAST(:s AS uuid) AND relation = 'related_to'"
        ),
        {"w": str(winner), "s": str(sink)},
    )
    assert edges.scalar() == 1


@pytest.mark.asyncio
async def test_no_false_merges_below_threshold(db_session, engram_factory):
    """Pairs with similarity <= engram_merge_similarity_threshold (default 0.88) are not merged."""
    # Two engrams with VERY different embeddings (cosine sim ~0.0)
    emb_a = [1.0] + [0.0] * 767
    emb_b = [0.0] + [1.0] + [0.0] * 766
    a = await engram_factory(content="distant-a", embedding=emb_a)
    b = await engram_factory(content="distant-b", embedding=emb_b)
    await db_session.flush()

    from app.engram.consolidation import _merge_duplicates

    await _merge_duplicates(db_session)
    await db_session.flush()

    rows = await db_session.execute(
        text(
            "SELECT content, superseded FROM engrams WHERE content LIKE 'distant-%' ORDER BY content"
        )
    )
    state = {r.content: r.superseded for r in rows}
    # NEITHER should be superseded — they're not similar enough
    assert state["distant-a"] is False
    assert state["distant-b"] is False


@pytest.mark.asyncio
async def test_bounded_merge_churn_second_run(db_session, engram_factory):
    """A second consolidation run produces no merges that violate the threshold contract.

    NOTE: The current cartesian implementation may produce a non-zero merged_count
    on a second run if the pairs were processed but not all converged. The
    HNSW-shortlist refactor (Task 3.3) tightens this. This test asserts the
    weaker invariant: any merges in the second run must satisfy the threshold.
    """
    emb_base = [0.5] * 768
    await engram_factory(content="x", embedding=emb_base, access_count=10)
    await engram_factory(content="y", embedding=[0.5] * 767 + [0.501], access_count=5)
    await db_session.flush()

    from app.engram.consolidation import _merge_duplicates

    # First run merges
    first = await _merge_duplicates(db_session)
    await db_session.flush()
    assert first >= 1, "first run should merge at least once"

    # Second run: any further merges must still respect threshold (no false merges)
    second = await _merge_duplicates(db_session)
    await db_session.flush()

    # The current cartesian implementation excludes superseded engrams at SELECT,
    # so a second run finds no candidates → second == 0. Lock that.
    assert second == 0, (
        f"second run produced {second} merges; expected 0 after first run drained candidates"
    )


@pytest.mark.asyncio
async def test_schema_synthesis_single_batched_query(
    db_session, engram_factory, edge_factory, monkeypatch
):
    """P4 CONTRACT: schema-synthesis coherence-gate makes 1 batched query for embeddings,
    not N round-trips per source.

    EXPECTED RED on current code; GREEN after Task 3.4."""
    from app.engram import consolidation as cons_mod

    # Stub out the LLM call so this test doesn't need fake_llm fixtures
    async def _stub_synthesize(entity_name, items_text):
        return f"Schema for {entity_name}: composite of {items_text[:30]}..."

    monkeypatch.setattr(cons_mod, "_synthesize_schema", _stub_synthesize)

    # Also stub get_embedding to return a deterministic vector without calling the gateway
    async def _stub_get_embedding(text_content, session):
        return [0.5] * 768

    monkeypatch.setattr(cons_mod, "get_embedding", _stub_get_embedding)

    # Build a fixture that triggers the coherence-gate path:
    # - One entity engram (type=entity, source_type=chat)
    # - 5 fact engrams that each point TO the entity via edge
    #   (source_type=chat to match entity's source_type for the related query)
    emb = [0.5] * 768
    entity = await engram_factory(
        content="entity-foo", type="entity", embedding=emb, source_type="chat"
    )

    for i in range(5):
        src = await engram_factory(
            content=f"source-{i}",
            type="fact",
            embedding=emb,
            importance=0.7,
            access_count=3,
            source_type="chat",
        )
        # source → entity (each source points TO the entity)
        await edge_factory(source=src, target=entity, relation="related_to", weight=0.7)

    await db_session.flush()

    # Wrap session in spy
    spy = _ExecuteSpy(db_session)
    await cons_mod._extract_patterns(spy)

    # The coherence-gate makes per-source-engram queries currently (N+1).
    # Count queries that look like the per-source embedding-similarity check.
    # The coherence query contains both "schema_emb" (the bound param name) and "<=>".
    coherence_queries = [c for c in spy.calls if "schema_emb" in c and "<=>" in c]
    # CURRENT code: 5 calls (one per source). EXPECTED after Task 3.4: 1 batched call.
    # This test FAILS on current code (asserts <= 1) — that's intentional RED.
    assert len(coherence_queries) <= 1, (
        f"P4 contract: expected <=1 batched coherence query, got {len(coherence_queries)}"
    )
