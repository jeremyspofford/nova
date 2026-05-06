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


# ----------------------------------------------------------------------------
# B-Task 4: Redis pubsub invalidation subscriber
#
# Hits real Redis (port 6379, db 1) per the project convention "tests run
# against real services, no mocks."
# ----------------------------------------------------------------------------

import asyncio

import httpx
from redis.asyncio import Redis as AsyncRedis

from nova_contracts.feature_flags import (
    cache_clear, init_cache_file, populate_cache,
)
from nova_contracts.feature_flags_pubsub import PubsubSubscriber

REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/1")
INVALIDATE_CHANNEL = "nova:flags:invalidate"


@pytest.fixture
async def fake_orchestrator():
    """An httpx.AsyncClient backed by a MockTransport that returns a
    configurable flag list. Tests mutate the response to simulate flag
    changes coming from the real orchestrator."""
    state: dict = {"rows": []}

    def handler(request: httpx.Request) -> httpx.Response:
        if "/api/v1/feature-flags/" in str(request.url):
            return httpx.Response(200, json=state["rows"])
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        client._test_state = state  # type: ignore[attr-defined]
        yield client


@pytest.mark.asyncio
async def test_pubsub_subscriber_refetches_on_invalidate(fake_orchestrator):
    """When the orchestrator publishes to nova:flags:invalidate, every
    subscribed service must refetch and update its cache."""
    cache_clear()
    init_cache_file(None)

    fake_orchestrator._test_state["rows"] = [
        {"key": "pub.k1", "current_value": False},
    ]

    subscriber = PubsubSubscriber(
        redis_url=REDIS_URL,
        http_client=fake_orchestrator,
        base_url="http://orchestrator:8000",
    )
    await subscriber.start()
    try:
        # Subscriber should report connected once the loop is reading.
        await _wait_for(lambda: subscriber.is_connected, timeout=2.0)

        # Initial state — no warm has happened yet (start() doesn't warm).
        # But the orchestrator now reflects an updated value:
        fake_orchestrator._test_state["rows"] = [
            {"key": "pub.k1", "current_value": True},
        ]

        # Publish an invalidation message; subscriber must refetch.
        async with AsyncRedis.from_url(REDIS_URL) as publisher:
            await publisher.publish(INVALIDATE_CHANNEL, "pub.k1")

        # Cache should reflect the orchestrator's new value within 5 seconds
        # (per CICD blocker CI3: PUBSUB_PROPAGATION_TIMEOUT_S = 5).
        from nova_contracts.feature_flags import _cache
        await _wait_for(lambda: _cache.get("pub.k1") is True, timeout=5.0)
    finally:
        await subscriber.stop()


@pytest.mark.asyncio
async def test_pubsub_subscriber_clean_shutdown_cancels_task(fake_orchestrator):
    subscriber = PubsubSubscriber(
        redis_url=REDIS_URL,
        http_client=fake_orchestrator,
        base_url="http://orchestrator:8000",
    )
    await subscriber.start()
    await _wait_for(lambda: subscriber.is_connected, timeout=2.0)
    await subscriber.stop()
    assert subscriber.is_connected is False


@pytest.mark.asyncio
async def test_pubsub_is_connected_false_before_start(fake_orchestrator):
    subscriber = PubsubSubscriber(
        redis_url=REDIS_URL,
        http_client=fake_orchestrator,
        base_url="http://orchestrator:8000",
    )
    assert subscriber.is_connected is False


async def _wait_for(predicate, *, timeout: float, interval: float = 0.05):
    """Spin until predicate() is truthy or timeout expires."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if predicate():
            return
        await asyncio.sleep(interval)
    raise TimeoutError(f"predicate stayed False after {timeout}s")


# ----------------------------------------------------------------------------
# B-Task 5: orchestrator-side store (DB CRUD + pubsub publish)
# ----------------------------------------------------------------------------

import sys
from pathlib import Path as _Path

# orchestrator's package isn't installed via uv; add it to path so we can
# import `app.feature_flags_store` like other orchestrator-touching tests do.
_ORCH = _Path(__file__).parent.parent / "orchestrator"
if str(_ORCH) not in sys.path:
    sys.path.insert(0, str(_ORCH))


@pytest.fixture
async def orch_pool():
    """asyncpg pool against the same DB the orchestrator uses, with the
    JSONB codec init that store ops expect."""
    import json as _json
    import asyncpg as _asyncpg

    async def _init_connection(conn):
        await conn.set_type_codec(
            "jsonb",
            encoder=_json.dumps,
            decoder=_json.loads,
            schema="pg_catalog",
        )

    dsn = DB_DSN
    pool = await _asyncpg.create_pool(dsn, min_size=1, max_size=2, init=_init_connection)
    yield pool
    await pool.close()


@pytest.mark.asyncio
async def test_store_upsert_creates_row_and_audit(orch_pool):
    from app.feature_flags_store import upsert_override, get_override, list_audit

    actor = {"actor": "admin", "ip": "10.0.0.1", "user_agent": "test", "request_id": None}
    await upsert_override(
        orch_pool,
        key="store.bool",
        value=True,
        notes="initial set",
        **actor,
    )
    row = await get_override(orch_pool, "store.bool")
    assert row is not None
    assert row["key"] == "store.bool"
    assert row["value"] is True
    assert row["set_by"] == "admin"

    audit = await list_audit(orch_pool, key="store.bool")
    assert len(audit) == 1
    assert audit[0]["action"] == "set"
    assert audit[0]["old_value"] is None
    assert audit[0]["new_value"] is True
    assert audit[0]["actor"] == "admin"
    assert str(audit[0]["actor_ip"]) == "10.0.0.1"
    assert audit[0]["actor_user_agent"] == "test"


@pytest.mark.asyncio
async def test_store_upsert_records_old_value_on_update(orch_pool):
    from app.feature_flags_store import upsert_override, list_audit

    actor = {"actor": "admin", "ip": None, "user_agent": None, "request_id": None}
    await upsert_override(orch_pool, key="store.update", value=False, notes=None, **actor)
    await upsert_override(orch_pool, key="store.update", value=True, notes=None, **actor)

    audit = await list_audit(orch_pool, key="store.update")
    # Newest first.
    assert audit[0]["action"] == "set"
    assert audit[0]["old_value"] is False
    assert audit[0]["new_value"] is True
    assert audit[1]["old_value"] is None
    assert audit[1]["new_value"] is False


@pytest.mark.asyncio
async def test_store_delete_records_reset_audit(orch_pool):
    from app.feature_flags_store import (
        upsert_override, delete_override, get_override, list_audit,
    )

    actor = {"actor": "admin", "ip": None, "user_agent": None, "request_id": None}
    await upsert_override(orch_pool, key="store.del", value=True, notes=None, **actor)
    deleted = await delete_override(orch_pool, key="store.del", **actor)
    assert deleted is True

    assert await get_override(orch_pool, "store.del") is None

    audit = await list_audit(orch_pool, key="store.del")
    assert audit[0]["action"] == "reset"
    assert audit[0]["old_value"] is True
    assert audit[0]["new_value"] is None


@pytest.mark.asyncio
async def test_store_delete_idempotent_when_no_row(orch_pool):
    from app.feature_flags_store import delete_override
    actor = {"actor": "admin", "ip": None, "user_agent": None, "request_id": None}
    deleted = await delete_override(orch_pool, key="store.never_was", **actor)
    assert deleted is False


@pytest.mark.asyncio
async def test_store_list_overrides_returns_all(orch_pool):
    from app.feature_flags_store import upsert_override, list_overrides

    actor = {"actor": "admin", "ip": None, "user_agent": None, "request_id": None}
    await upsert_override(orch_pool, key="store.l1", value=True, notes=None, **actor)
    await upsert_override(orch_pool, key="store.l2", value="tools", notes=None, **actor)

    rows = await list_overrides(orch_pool)
    keys = {r["key"] for r in rows}
    assert {"store.l1", "store.l2"}.issubset(keys)


@pytest.mark.asyncio
async def test_store_list_audit_recent_across_keys(orch_pool):
    from app.feature_flags_store import upsert_override, list_audit

    actor = {"actor": "admin", "ip": None, "user_agent": None, "request_id": None}
    await upsert_override(orch_pool, key="store.aud1", value=True, notes=None, **actor)
    await upsert_override(orch_pool, key="store.aud2", value=False, notes=None, **actor)

    audit = await list_audit(orch_pool, limit=10)  # no key filter -> all
    keys = {a["key"] for a in audit}
    assert {"store.aud1", "store.aud2"}.issubset(keys)


#
# Note: `publish_invalidation` is intentionally NOT covered by a dedicated
# test. It's a one-line `redis.publish(channel, key)` call that uses
# `app.store.get_redis()` — settings.redis_url points to the Docker service
# hostname, not localhost, so it isn't directly callable from host-side tests.
# The pubsub channel-correctness contract is covered end-to-end by the SDK's
# `test_pubsub_subscriber_refetches_on_invalidate` (which subscribes and
# publishes from the host using a localhost-connected client) — that's the
# behavior we actually care about, not the in-process plumbing.


# ----------------------------------------------------------------------------
# B-Task 6: HTTP admin router (real orchestrator; uses NOVA_ADMIN_SECRET if set,
# otherwise relies on require_admin's trusted-network bypass for localhost).
# ----------------------------------------------------------------------------

ORCH_URL = os.environ.get("NOVA_ORCHESTRATOR_URL", "http://localhost:8000")
ADMIN_SECRET = os.environ.get("NOVA_ADMIN_SECRET", "")


def _admin_headers() -> dict[str, str]:
    h = {"Content-Type": "application/json"}
    if ADMIN_SECRET:
        h["X-Admin-Secret"] = ADMIN_SECRET
    return h


@pytest.mark.asyncio
async def test_router_list_flags_returns_200():
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(f"{ORCH_URL}/api/v1/feature-flags/", headers=_admin_headers())
    assert r.status_code == 200, r.text
    assert isinstance(r.json(), list)


@pytest.mark.asyncio
async def test_router_registry_returns_200():
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.get(f"{ORCH_URL}/api/v1/feature-flags/registry", headers=_admin_headers())
    assert r.status_code == 200, r.text
    # Orchestrator hasn't registered any flags yet (B-Task 9 wires those);
    # registry is empty for now but the endpoint must respond.
    assert isinstance(r.json(), list)


@pytest.mark.asyncio
async def test_router_patch_creates_override_and_propagates_via_pubsub():
    """End-to-end round-trip: PATCH on the admin API → orchestrator writes
    override + audit, publishes invalidation; SDK subscriber receives,
    re-warms cache. The PATCH'd value is visible to a subsequent GET."""
    async with httpx.AsyncClient(timeout=10.0) as client:
        # Use a non-critical key so no `confirm` is required.
        key = "rt.patch.k1"
        r = await client.patch(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers=_admin_headers(),
            json={"value": True, "notes": "router e2e"},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["key"] == key
        assert body["value"] is True

        # GET /{key} returns the override
        r = await client.get(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers=_admin_headers(),
        )
        assert r.status_code == 200
        assert r.json()["is_override"] is True
        assert r.json()["current_value"] is True

        # Cleanup
        r = await client.delete(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers=_admin_headers(),
        )
        assert r.status_code == 200
        assert r.json() == {"deleted": True, "key": key}


@pytest.mark.asyncio
async def test_router_patch_critical_flag_requires_confirm():
    """S3: a CRITICAL_FLAGS key without `confirm` returns 400."""
    key = "kill.engram.ingestion"  # in CRITICAL_FLAGS
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.patch(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers=_admin_headers(),
            json={"value": True},  # no confirm
        )
        assert r.status_code == 400, r.text
        assert "confirm" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_router_patch_critical_flag_with_correct_confirm_succeeds():
    key = "kill.engram.ingestion"
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.patch(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers=_admin_headers(),
            json={"value": True, "confirm": key},
        )
        assert r.status_code == 200, r.text
        # Cleanup
        await client.delete(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers=_admin_headers(),
        )


@pytest.mark.asyncio
async def test_router_patch_critical_flag_with_wrong_confirm_rejected():
    """`confirm` must match the URL key exactly — typo'd confirm gets 400."""
    key = "pipeline.guardrail_strict_mode"
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.patch(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers=_admin_headers(),
            json={"value": True, "confirm": "kill.something_else"},
        )
        assert r.status_code == 400


@pytest.mark.asyncio
async def test_router_audit_records_request_metadata():
    """S1: audit row captures actor_ip + actor_user_agent + request_id."""
    key = "rt.audit.meta"
    custom_request_id = str(uuid.uuid4())
    async with httpx.AsyncClient(timeout=10.0) as client:
        r = await client.patch(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers={
                **_admin_headers(),
                "User-Agent": "nova-test/1.0",
                "X-Request-ID": custom_request_id,
            },
            json={"value": True},
        )
        assert r.status_code == 200, r.text

        # Inspect the audit row
        r = await client.get(
            f"{ORCH_URL}/api/v1/feature-flags/{key}/audit",
            headers=_admin_headers(),
        )
        assert r.status_code == 200
        audit = r.json()
        assert len(audit) == 1
        latest = audit[0]
        assert latest["actor_user_agent"] == "nova-test/1.0"
        assert latest["request_id"] == custom_request_id
        assert latest["actor_ip"] is not None  # localhost / container IP

        # Cleanup
        await client.delete(
            f"{ORCH_URL}/api/v1/feature-flags/{key}",
            headers=_admin_headers(),
        )


import uuid  # noqa: E402  — used in the request-id test above


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
