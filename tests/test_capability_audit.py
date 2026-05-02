"""Audit log: insert, hash chain integrity, tamper detection, RULE enforcement."""
from __future__ import annotations

import sys
sys.path.insert(0, '/home/jeremy/workspace/nova/orchestrator')

from uuid import UUID, uuid4
import pytest

from app.capabilities.audit import write_audit_event, verify_chain


TENANT = UUID("00000000-0000-0000-0000-000000000001")


@pytest.mark.asyncio
async def test_audit_insert_and_chain(pool):
    """Insert N rows, verify chain integrity from genesis.

    The RULE blocks DELETE, so we cannot clean up rows between runs.
    The chain grows monotonically across test runs — verify_chain must
    pass across the whole accumulated history.
    """
    for i in range(5):
        await write_audit_event(
            pool,
            tenant_id=TENANT, actor_kind="system", actor_id="test-chain",
            event_type="tool_call", tool_name=f"test_tool_{i}",
            blast_radius="read", response_status="success",
            args_redacted={"i": i},
        )
    result = await verify_chain(pool, tenant_id=TENANT)
    assert result.is_valid, f"chain broken at {result.broken_at}"
    assert result.row_count >= 5


@pytest.mark.asyncio
async def test_audit_update_blocked_by_rule(pool):
    """The RULE on the table silently rejects UPDATE."""
    audit_id = await write_audit_event(
        pool,
        tenant_id=TENANT, actor_kind="system", actor_id="rule-update-test",
        event_type="tool_call", tool_name="rule_target",
        blast_radius="read", response_status="success",
    )
    async with pool.acquire() as conn:
        # Try to corrupt the row's content_hash; RULE should block silently
        await conn.execute(
            "UPDATE capability_audit SET content_hash=$1 WHERE id=$2",
            b'\x00' * 32, audit_id,
        )
        row = await conn.fetchrow(
            "SELECT content_hash FROM capability_audit WHERE id=$1", audit_id
        )
        # Should NOT be all zeros — UPDATE was blocked
        assert row["content_hash"] != b'\x00' * 32


@pytest.mark.asyncio
async def test_audit_delete_blocked_by_rule(pool):
    """The RULE on the table silently rejects DELETE."""
    audit_id = await write_audit_event(
        pool,
        tenant_id=TENANT, actor_kind="system", actor_id="rule-delete-test",
        event_type="tool_call", tool_name="delete_target",
        blast_radius="read", response_status="success",
    )
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM capability_audit WHERE id=$1", audit_id)
        # Row should still exist — RULE blocked the DELETE
        row = await conn.fetchrow(
            "SELECT id FROM capability_audit WHERE id=$1", audit_id
        )
        assert row is not None, "RULE should have blocked the DELETE"
