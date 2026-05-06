"""Characterization tests for spreading_activation — lock current behavior.

These tests run BEFORE the P1 refactor to capture output snapshots,
and AFTER to confirm no semantic drift. New behavior assertions go in
test_activation.py (next task).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from app.engram.activation import spreading_activation
from sqlalchemy import text

from ._snapshot import assert_snapshot

SNAPSHOT_DIR = Path(__file__).parent / "fixtures" / "snapshots"


def _summarize_activation(result):
    """Convert ActivatedEngram list → JSON-friendly summary for snapshotting.

    IMPORTANT: sort by content (deterministic tiebreaker) before snapshotting.
    Native ORDER BY final_score DESC produces ties when many engrams share
    activation × importance products (common in synthetic fixtures). Without a
    tiebreaker, Postgres may return rows in any order across runs.
    """
    summarized = [
        {
            "type": e.type,
            "content": e.content,
            "convergence_paths": e.convergence_paths,
            "source_type": e.source_type,
            "activation": round(e.activation, 4),
            "importance": round(e.importance, 4),
            "final_score": round(e.final_score, 4),
        }
        for e in result
    ]
    summarized.sort(key=lambda d: (-d["final_score"], d["content"]))
    return summarized


@pytest.mark.asyncio
async def test_chain_topology_activation_snapshot(
    db_session, graph_builder, monkeypatch
):
    """5-node chain seeded by content of node 0 produces a stable activation list."""
    base_emb = [0.1] * 768
    nodes = await graph_builder.chain(n=5, embedding=base_emb)
    await db_session.execute(
        text("UPDATE engrams SET activation = 1.0 WHERE id = CAST(:id AS uuid)"),
        {"id": str(nodes[0])},
    )
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub_get_embedding(query, session):
        return base_emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub_get_embedding)

    result = await spreading_activation(
        db_session,
        query="seed query",
        seed_count=1,
        max_hops=3,
        max_results=10,
    )
    summary = _summarize_activation(result)
    assert_snapshot(summary, path=SNAPSHOT_DIR / "activation_chain_5_seed1.json")


@pytest.mark.asyncio
async def test_hub_spoke_activation_snapshot(db_session, graph_builder, monkeypatch):
    """Hub-and-spoke with seed=hub produces snapshot of all reachable nodes."""
    base_emb = [0.2] * 768
    hub, spokes = await graph_builder.hub_and_spoke(k=8, embedding=base_emb)
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub_get_embedding(query, session):
        return base_emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub_get_embedding)

    result = await spreading_activation(
        db_session,
        query="anything",
        seed_count=1,
        max_hops=2,
        max_results=20,
    )
    summary = _summarize_activation(result)
    assert_snapshot(summary, path=SNAPSHOT_DIR / "activation_hub_8_spokes.json")
