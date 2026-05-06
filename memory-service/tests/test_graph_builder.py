"""Tests for graph_builder fixture."""

from __future__ import annotations

import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_chain_topology(db_session, graph_builder):
    """N engrams in a chain: e0 → e1 → e2 → ... → e(n-1)."""
    nodes = await graph_builder.chain(n=5)
    assert len(nodes) == 5

    edge_count = await db_session.execute(
        text(
            "SELECT count(*) FROM engram_edges WHERE source_id = ANY(CAST(:ids AS uuid[]))"
        ),
        {"ids": [str(i) for i in nodes]},
    )
    assert edge_count.scalar() == 4  # n-1 edges in a chain


@pytest.mark.asyncio
async def test_hub_and_spoke(db_session, graph_builder):
    """One hub node with k spoke nodes connected to it."""
    hub, spokes = await graph_builder.hub_and_spoke(k=10)
    assert len(spokes) == 10
    edge_count = await db_session.execute(
        text(
            "SELECT count(*) FROM engram_edges WHERE source_id = CAST(:h AS uuid) OR target_id = CAST(:h AS uuid)"
        ),
        {"h": str(hub)},
    )
    assert edge_count.scalar() == 10


@pytest.mark.asyncio
async def test_two_tenant_split(db_session, graph_builder):
    """Two disjoint subgraphs in separate tenants."""
    tenant_a, tenant_b = await graph_builder.two_tenant_split(per_tenant=3)
    assert len(tenant_a) == 3
    assert len(tenant_b) == 3

    rows = await db_session.execute(
        text(
            "SELECT id, tenant_id::text FROM engrams WHERE id = ANY(CAST(:ids AS uuid[]))"
        ),
        {"ids": [str(n) for n in tenant_a + tenant_b]},
    )
    by_tenant: dict[str, set[str]] = {}
    for row in rows:
        by_tenant.setdefault(row.tenant_id, set()).add(str(row.id))
    assert len(by_tenant) == 2
