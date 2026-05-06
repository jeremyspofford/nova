"""Integration tests for the feature_flags system. Hit a real running orchestrator."""
import os

import asyncpg
import pytest

DB_DSN = os.environ.get(
    "DATABASE_URL",
    f"postgresql://nova:{os.getenv('POSTGRES_PASSWORD', 'nova_dev_password')}"
    "@localhost:5432/nova",
).replace("postgresql+asyncpg://", "postgresql://")


@pytest.mark.asyncio
async def test_migration_creates_feature_flags_tables():
    conn = await asyncpg.connect(DB_DSN)
    try:
        flags_cols = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'feature_flags' ORDER BY ordinal_position"
        )
        audit_cols = await conn.fetch(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = 'feature_flag_audit' ORDER BY ordinal_position"
        )
        assert {r["column_name"] for r in flags_cols} == {
            "key", "value", "set_by", "set_at", "notes",
        }
        # 083 ships these; 085 adds the request-metadata trio (A4).
        baseline_audit_cols = {
            "id", "key", "action", "old_value", "new_value",
            "actor", "occurred_at", "notes",
        }
        assert baseline_audit_cols.issubset({r["column_name"] for r in audit_cols})
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_flag_audit_has_request_metadata_columns():
    """A4 (Security blocker S1): every audit row must capture request metadata.

    Shared admin secret means `actor='admin'` literal is useless for incident
    response — IP + UA + request_id give operators something to forensically
    pivot on even before per-user RBAC lands.
    """
    conn = await asyncpg.connect(DB_DSN)
    try:
        cols = await conn.fetch(
            "SELECT column_name, data_type FROM information_schema.columns "
            "WHERE table_name = 'feature_flag_audit'"
        )
        names = {r["column_name"] for r in cols}
        types = {r["column_name"]: r["data_type"] for r in cols}

        assert {"actor_ip", "actor_user_agent", "request_id"}.issubset(names), (
            f"feature_flag_audit must have actor_ip, actor_user_agent, request_id; "
            f"saw {sorted(names)}"
        )
        # Types matter for downstream filtering / dashboards.
        assert types["actor_ip"] == "inet"
        assert types["actor_user_agent"] == "text"
        assert types["request_id"] == "uuid"
    finally:
        await conn.close()
