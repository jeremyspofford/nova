"""Tests for engram_factory and edge_factory."""

from __future__ import annotations

import pytest
from sqlalchemy import text


@pytest.mark.asyncio
async def test_engram_factory_inserts_with_defaults(db_session, engram_factory):
    eid = await engram_factory(content="hello world")
    row = await db_session.execute(
        text(
            "SELECT type, content, source_type, importance FROM engrams WHERE id = :id"
        ),
        {"id": str(eid)},
    )
    fetched = row.fetchone()
    assert fetched.content == "hello world"
    assert fetched.type == "fact"
    assert fetched.source_type == "chat"
    assert fetched.importance == 0.5


@pytest.mark.asyncio
async def test_engram_factory_overrides_apply(db_session, engram_factory):
    eid = await engram_factory(
        content="goal text",
        type="goal",
        source_type="cortex",
        importance=0.9,
        embedding=[0.1] * 768,
    )
    row = await db_session.execute(
        text("SELECT type, source_type, importance FROM engrams WHERE id = :id"),
        {"id": str(eid)},
    )
    fetched = row.fetchone()
    assert fetched.type == "goal"
    assert fetched.source_type == "cortex"
    assert abs(fetched.importance - 0.9) < 1e-5


@pytest.mark.asyncio
async def test_engram_factory_assigns_tenant(db_session, engram_factory):
    eid = await engram_factory(
        content="tenant scoped",
        tenant_id="00000000-0000-0000-0000-000000000099",
    )
    row = await db_session.execute(
        text("SELECT tenant_id::text FROM engrams WHERE id = :id"),
        {"id": str(eid)},
    )
    assert row.scalar() == "00000000-0000-0000-0000-000000000099"


@pytest.mark.asyncio
async def test_edge_factory_links_engrams(db_session, engram_factory, edge_factory):
    src = await engram_factory(content="source")
    tgt = await engram_factory(content="target")
    edge_id = await edge_factory(
        source=src, target=tgt, relation="related_to", weight=0.7
    )
    row = await db_session.execute(
        text("SELECT relation, weight FROM engram_edges WHERE id = :id"),
        {"id": str(edge_id)},
    )
    fetched = row.fetchone()
    assert fetched.relation == "related_to"
    assert abs(fetched.weight - 0.7) < 1e-5
