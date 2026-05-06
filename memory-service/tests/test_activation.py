"""Contract tests for spreading_activation invariants.

Some tests will FAIL on current code — that's intentional. Task 2.5 fixes
the implementation to satisfy these contracts.
"""

from __future__ import annotations

import pytest
from app.engram.activation import spreading_activation
from sqlalchemy import text


@pytest.mark.asyncio
async def test_terminates_at_max_hops(db_session, graph_builder, monkeypatch):
    """A 10-node chain with max_hops=3 should not return more than 4 nodes (seed + 3 hops)."""
    emb = [0.1] * 768
    nodes = await graph_builder.chain(n=10, embedding=emb)
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub(query, session):
        return emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub)

    result = await spreading_activation(
        db_session, query="x", seed_count=1, max_hops=3, max_results=20
    )
    assert len(result) <= 4


@pytest.mark.asyncio
async def test_no_revisits(db_session, graph_builder, monkeypatch):
    """Each engram appears at most once in the result."""
    emb = [0.3] * 768
    hub, spokes = await graph_builder.hub_and_spoke(k=5, embedding=emb)
    for spoke in spokes:
        await db_session.execute(
            text(
                "INSERT INTO engram_edges (source_id, target_id, relation, weight) "
                "VALUES (CAST(:s AS uuid), CAST(:t AS uuid), 'related_to', 0.6) "
                "ON CONFLICT DO NOTHING"
            ),
            {"s": str(spoke), "t": str(hub)},
        )
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub(query, session):
        return emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub)

    result = await spreading_activation(
        db_session, query="x", seed_count=1, max_hops=3, max_results=50
    )
    ids = [r.id for r in result]
    assert len(ids) == len(set(ids)), f"duplicate IDs: {ids}"


@pytest.mark.asyncio
async def test_tenant_isolation(db_session, graph_builder, monkeypatch):
    """A query in tenant A returns zero engrams in tenant B even when edges link them.

    EXPECTED RED on current code; GREEN after Task 2.5.
    """
    nodes_a, nodes_b = await graph_builder.two_tenant_split(per_tenant=3)
    # Create a high-weight edge from tenant A directly to tenant B to force spread
    await db_session.execute(
        text(
            "INSERT INTO engram_edges (source_id, target_id, relation, weight) "
            "VALUES (CAST(:s AS uuid), CAST(:t AS uuid), 'related_to', 1.0) "
        ),
        {"s": str(nodes_a[0]), "t": str(nodes_b[0])},
    )
    await db_session.flush()

    # Verify the edge exists before running spreading_activation
    edge_count = await db_session.scalar(
        text("SELECT COUNT(*) FROM engram_edges WHERE source_id = CAST(:s AS uuid)"),
        {"s": str(nodes_a[0])},
    )
    assert edge_count >= 1, (
        f"cross-tenant edge not created; edges from nodes_a[0]: {edge_count}"
    )

    from app.engram import activation as act_mod

    emb = [0.5] * 768

    async def _stub(query, session):
        return emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub)

    tenant_a_id = "00000000-0000-0000-0000-00000000000a"
    result = await spreading_activation(
        db_session,
        query="x",
        seed_count=3,
        max_hops=2,
        max_results=20,
        tenant_id=tenant_a_id,
    )
    result_ids = {r.id for r in result}
    nodes_b_ids = {str(n) for n in nodes_b}
    assert nodes_b_ids.isdisjoint(result_ids), (
        f"tenant leak: tenant B engrams in tenant A query result: "
        f"{nodes_b_ids & result_ids}"
    )


@pytest.mark.asyncio
async def test_fan_out_cap(db_session, graph_builder, monkeypatch):
    """A hub with 200 neighbors only spreads to engram_max_fanout_per_hop=50 of them per hop.

    EXPECTED RED on current code; GREEN after Task 2.5.
    """
    emb = [0.4] * 768
    hub, spokes = await graph_builder.hub_and_spoke(k=200, embedding=emb)
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub(query, session):
        return emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub)

    result = await spreading_activation(
        db_session,
        query="x",
        seed_count=1,
        max_hops=1,
        max_results=300,
    )
    assert len(result) <= 51, f"fan-out unbounded: got {len(result)} nodes"


@pytest.mark.asyncio
async def test_personal_general_seed_split(db_session, engram_factory, monkeypatch):
    """seed_count=10 with personal_seed_ratio=0.4 produces 4 personal + 6 general seeds."""
    from app.config import settings

    monkeypatch.setattr(settings, "engram_personal_seed_ratio", 0.4)

    emb = [0.6] * 768
    for i in range(5):
        await engram_factory(content=f"chat-{i}", source_type="chat", embedding=emb)
    for i in range(10):
        await engram_factory(content=f"intel-{i}", source_type="intel", embedding=emb)
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub(query, session):
        return emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub)

    result = await spreading_activation(
        db_session,
        query="x",
        seed_count=10,
        max_hops=0,
        max_results=20,
    )
    chat_count = sum(1 for r in result if r.source_type == "chat")
    intel_count = sum(1 for r in result if r.source_type == "intel")
    assert chat_count == 4, f"expected 4 chat seeds with ratio=0.4, got {chat_count}"
    assert intel_count == 6, f"expected 6 intel seeds with ratio=0.4, got {intel_count}"


@pytest.mark.asyncio
async def test_contradicts_edges_not_traversed(
    db_session, engram_factory, edge_factory, monkeypatch
):
    """Edges with relation='contradicts' do not propagate activation."""
    emb = [0.7] * 768
    seed = await engram_factory(content="seed", embedding=emb)
    contradicting = await engram_factory(content="contradiction", embedding=emb)
    await edge_factory(
        source=seed, target=contradicting, relation="contradicts", weight=0.9
    )
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub(query, session):
        return emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub)

    result = await spreading_activation(
        db_session,
        query="x",
        seed_count=1,
        max_hops=2,
        max_results=10,
    )
    result_ids = {r.id for r in result}
    assert str(contradicting) not in result_ids, "contradicts edge should not propagate"


@pytest.mark.asyncio
async def test_threshold_pruning(db_session, engram_factory, edge_factory, monkeypatch):
    """An edge with weight*decay below threshold doesn't traverse."""
    emb = [0.5] * 768
    seed = await engram_factory(content="seed", embedding=emb)
    far = await engram_factory(content="far", embedding=emb)
    await edge_factory(source=seed, target=far, relation="related_to", weight=0.05)
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub(query, session):
        return emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub)

    result = await spreading_activation(
        db_session,
        query="x",
        seed_count=1,
        max_hops=2,
        activation_threshold=0.1,
        max_results=10,
    )
    result_ids = {r.id for r in result}
    assert str(far) not in result_ids


@pytest.mark.asyncio
async def test_convergence_paths_counted(
    db_session, engram_factory, edge_factory, monkeypatch
):
    """An engram reachable from 3 distinct seeds via different edges has convergence_paths >= 3."""
    emb = [0.5] * 768
    target = await engram_factory(content="target", embedding=emb)
    seeds = []
    # Create 3 chat seeds (personal) + 2 intel seeds (general) to ensure 5 total seeds selected
    for i in range(3):
        s = await engram_factory(
            content=f"seed-chat-{i}", source_type="chat", embedding=emb
        )
        seeds.append(s)
        await edge_factory(source=s, target=target, relation="related_to", weight=0.8)
    for i in range(2):
        s = await engram_factory(
            content=f"seed-intel-{i}", source_type="intel", embedding=emb
        )
        seeds.append(s)
        await edge_factory(source=s, target=target, relation="related_to", weight=0.8)
    await db_session.flush()

    from app.engram import activation as act_mod

    async def _stub(query, session):
        return emb

    monkeypatch.setattr(act_mod, "get_embedding", _stub)

    result = await spreading_activation(
        db_session,
        query="x",
        seed_count=5,
        max_hops=2,
        max_results=10,
    )
    target_row = next((r for r in result if r.id == str(target)), None)
    assert target_row is not None, "target should be in result"
    assert target_row.convergence_paths >= 3
