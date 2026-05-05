"""Integration tests for the feature_flags system. Hit a real running orchestrator."""
import pytest
import asyncpg
import os

DB_DSN = os.environ.get("DATABASE_URL")  # provided by docker-compose.test


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
        assert {r["column_name"] for r in audit_cols} == {
            "id", "key", "action", "old_value", "new_value",
            "actor", "occurred_at", "notes",
        }
    finally:
        await conn.close()
