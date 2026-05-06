"""Integration tests for the feature_flags system. Hit a real running orchestrator."""
import os

import asyncpg
import pytest

DB_DSN = os.environ.get(
    "DATABASE_URL",
    f"postgresql://nova:{os.getenv('POSTGRES_PASSWORD', 'nova_dev_password')}"
    "@localhost:5432/nova",
).replace("postgresql+asyncpg://", "postgresql://")


@pytest.fixture(autouse=True)
async def _flags_clean():
    """Truncate flag tables AFTER each test so failure state is inspectable.

    File-scoped autouse — only applies to tests in this integration file. Unit
    tests under test_feature_flags_resolver.py never touch the DB and
    intentionally aren't covered by this fixture.

    Per CICD blocker CI2 in the prod-readiness memo: cleanup runs *after*
    each test (not before) so a failed test's residual rows can be inspected
    in a paused debug session before the next test obliterates them. Cleanup
    is best-effort — DB connection failures during teardown log a warning
    rather than failing the test that already ran.
    """
    yield
    try:
        conn = await asyncpg.connect(DB_DSN)
    except (OSError, asyncpg.PostgresError):
        # DB unreachable — skip cleanup; the tests would have failed at
        # connect time anyway, so there's nothing to truncate.
        return
    try:
        await conn.execute(
            "TRUNCATE feature_flags, feature_flag_audit RESTART IDENTITY CASCADE"
        )
    finally:
        await conn.close()


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
async def test_a_polluter_writes_row_without_cleanup():
    """Pair partner for test_b. Order-dependent: pytest runs in file order,
    so this writes a row that test_b would see if the autouse fixture didn't
    clean up between tests.
    """
    conn = await asyncpg.connect(DB_DSN)
    try:
        await conn.execute(
            "INSERT INTO feature_flags (key, value, set_by) "
            "VALUES ('a3.polluter', '\"sentinel\"'::jsonb, 'a3-pair-test')"
        )
        await conn.execute(
            "INSERT INTO feature_flag_audit (key, action, new_value, actor) "
            "VALUES ('a3.polluter', 'set', '\"sentinel\"'::jsonb, 'a3-pair-test')"
        )
        # Confirm the polluter actually wrote.
        n = await conn.fetchval(
            "SELECT count(*) FROM feature_flags WHERE key = 'a3.polluter'"
        )
        assert n == 1
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_b_starts_with_clean_state():
    """Pair partner for test_a. The autouse _flags_clean fixture must
    truncate between tests so this sees an empty table even though test_a
    just wrote two rows.
    """
    conn = await asyncpg.connect(DB_DSN)
    try:
        flags_count = await conn.fetchval("SELECT count(*) FROM feature_flags")
        audit_count = await conn.fetchval("SELECT count(*) FROM feature_flag_audit")
        assert flags_count == 0, (
            f"feature_flags must be empty at test start; saw {flags_count} rows. "
            "If this fails, the _flags_clean autouse fixture is not running."
        )
        assert audit_count == 0, (
            f"feature_flag_audit must be empty at test start; saw {audit_count} rows."
        )
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
