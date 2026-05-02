"""GitHub polling worker — singleton lease + stimulus push for new runs."""
from __future__ import annotations

import json
import os
import sys
from uuid import UUID, uuid4

import pytest
import pytest_asyncio
from redis.asyncio import Redis

sys.path.insert(0, "/home/jeremy/workspace/nova/orchestrator")
sys.path.insert(0, "/home/jeremy/workspace/nova/nova-contracts")
sys.path.insert(0, "/home/jeremy/workspace/nova/nova-worker-common")

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_REDIS_URL = os.environ.get("REDIS_URL", "redis://localhost:6379/2")
_CORTEX_REDIS_URL = os.environ.get("CORTEX_REDIS_URL", "redis://localhost:6379/5")


# ---------------------------------------------------------------------------
# Lease tests (no DB required — only Redis)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_lease_acquisition_singleton():
    """Two pollers contend for the lease; only one acquires."""
    from app.polling_worker import GitHubPoller, LEASE_KEY

    r = Redis.from_url(_REDIS_URL, decode_responses=True)
    await r.delete(LEASE_KEY)
    try:
        p1 = GitHubPoller(redis_url=_REDIS_URL)
        p2 = GitHubPoller(redis_url=_REDIS_URL)
        p1.redis = r
        p2.redis = r

        ok1 = await p1._acquire_or_refresh_lease()
        ok2 = await p2._acquire_or_refresh_lease()

        assert ok1 is True, "first poller should acquire the lease"
        assert ok2 is False, "second poller should be denied — lease already held"
    finally:
        await r.delete(LEASE_KEY)
        await r.aclose()


@pytest.mark.asyncio
async def test_lease_self_refresh_returns_true():
    """The same instance can refresh its own lease."""
    from app.polling_worker import GitHubPoller, LEASE_KEY

    r = Redis.from_url(_REDIS_URL, decode_responses=True)
    await r.delete(LEASE_KEY)
    try:
        p = GitHubPoller(redis_url=_REDIS_URL)
        p.redis = r

        ok1 = await p._acquire_or_refresh_lease()
        ok2 = await p._acquire_or_refresh_lease()  # same instance — should refresh

        assert ok1 is True
        assert ok2 is True, "same instance should be able to refresh its lease"
    finally:
        await r.delete(LEASE_KEY)
        await r.aclose()


@pytest.mark.asyncio
async def test_non_holder_cannot_steal_lease():
    """A third poller cannot acquire a lease held by a different instance."""
    from app.polling_worker import GitHubPoller, LEASE_KEY

    r = Redis.from_url(_REDIS_URL, decode_responses=True)
    await r.delete(LEASE_KEY)
    try:
        p1 = GitHubPoller(redis_url=_REDIS_URL)
        p2 = GitHubPoller(redis_url=_REDIS_URL)
        p3 = GitHubPoller(redis_url=_REDIS_URL)
        p1.redis = r
        p2.redis = r
        p3.redis = r

        await p1._acquire_or_refresh_lease()    # p1 holds it
        ok2 = await p2._acquire_or_refresh_lease()
        ok3 = await p3._acquire_or_refresh_lease()

        assert ok2 is False
        assert ok3 is False
    finally:
        await r.delete(LEASE_KEY)
        await r.aclose()


# ---------------------------------------------------------------------------
# Polling integration test — requires running orchestrator + DB
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_poll_one_repo_pushes_stimuli_for_new_runs(orchestrator, admin_headers, pool):
    """Configure a watched repo + credential, run _poll_one_repo against fake-github,
    verify a stimulus appeared on cortex:stimuli."""
    from fixtures.fake_github import FakeGitHubServer, load_scenario

    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()

    cred_id = None
    wid = None
    try:
        # Create a test credential via the API
        cred_resp = await orchestrator.post(
            "/api/v1/capabilities/credentials",
            headers=admin_headers,
            json={
                "provider_kind": "github",
                "auth_method": "pat",
                "label": f"nova-test-poll-{uuid4().hex[:8]}",
                "secret": "ghp_validtoken",
            },
        )
        assert cred_resp.status_code == 201, cred_resp.text
        cred_id = cred_resp.json()["id"]

        # Insert a watched repo directly — no HTTP endpoint for this yet
        async with pool.acquire() as conn:
            wid = await conn.fetchval(
                """
                INSERT INTO cortex_watched_repos
                  (tenant_id, credential_id, repo, trigger_mode, polling_interval_min)
                VALUES ($1, $2, $3, 'polling_only', 15)
                ON CONFLICT (tenant_id, repo) DO UPDATE
                  SET credential_id = EXCLUDED.credential_id,
                      trigger_mode = EXCLUDED.trigger_mode
                RETURNING id
                """,
                UUID("00000000-0000-0000-0000-000000000001"),
                UUID(cred_id),
                "test-org/test-repo",
            )

        # Drain any pre-existing stimuli so the assertion is clean
        cortex_redis = Redis.from_url(_CORTEX_REDIS_URL, decode_responses=True)
        await cortex_redis.delete("cortex:stimuli")
        await cortex_redis.aclose()

        # Run the poller against fake-github.
        # Override the settings singleton so _poll_one_repo talks to fake-github instead.
        from app.polling_worker import GitHubPoller
        from app.config import settings

        original_base = settings.github_api_base_url
        settings.github_api_base_url = fake.base_url
        try:
            poller = GitHubPoller(redis_url=_REDIS_URL, cortex_redis_url=_CORTEX_REDIS_URL)
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT id, tenant_id, credential_id, repo, polling_interval_min "
                    "FROM cortex_watched_repos WHERE id=$1",
                    wid,
                )
            await poller._poll_one_repo(row, _pool=pool)
        finally:
            settings.github_api_base_url = original_base

        # The lint_failure_in_pr scenario has run id=12345 with conclusion=failure.
        # last_seen_id starts at 0 so it's new → exactly 1 stimulus should appear.
        cortex_redis = Redis.from_url(_CORTEX_REDIS_URL, decode_responses=True)
        try:
            count = await cortex_redis.llen("cortex:stimuli")
            assert count >= 1, f"Expected at least 1 stimulus on cortex:stimuli; got {count}"

            # Inspect the stimulus shape
            raw = await cortex_redis.rpop("cortex:stimuli")
            assert raw is not None
            stimulus = json.loads(raw)
            assert stimulus["type"] == "ci.workflow_run.failure"
            assert stimulus["repo"] == "test-org/test-repo"
            assert stimulus["source"] == "polling"
            assert stimulus["run_id"] == 12345
        finally:
            await cortex_redis.aclose()

        # poll_state should now record last_run_id = 12345
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT last_run_id FROM cortex_poll_state WHERE watched_repo_id=$1", wid
            )
        assert row is not None, "poll_state row was not created"
        assert row["last_run_id"] == 12345

        # Running again should push 0 new stimuli (dedup by last_seen_id)
        cortex_redis = Redis.from_url(_CORTEX_REDIS_URL, decode_responses=True)
        await cortex_redis.delete("cortex:stimuli")
        await cortex_redis.aclose()

        settings.github_api_base_url = fake.base_url
        try:
            async with pool.acquire() as conn:
                row = await conn.fetchrow(
                    "SELECT id, tenant_id, credential_id, repo, polling_interval_min "
                    "FROM cortex_watched_repos WHERE id=$1",
                    wid,
                )
            await poller._poll_one_repo(row, _pool=pool)
        finally:
            settings.github_api_base_url = original_base

        cortex_redis = Redis.from_url(_CORTEX_REDIS_URL, decode_responses=True)
        try:
            count_after = await cortex_redis.llen("cortex:stimuli")
            assert count_after == 0, (
                f"Poller should not re-emit already-seen run; got {count_after} stimuli"
            )
        finally:
            await cortex_redis.aclose()

    finally:
        # Cleanup: poll_state cascades on DELETE of watched_repo
        if wid:
            async with pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM cortex_watched_repos WHERE id=$1", wid
                )
        if cred_id:
            await orchestrator.delete(
                f"/api/v1/capabilities/credentials/{cred_id}",
                headers=admin_headers,
            )
        await fake.stop()
