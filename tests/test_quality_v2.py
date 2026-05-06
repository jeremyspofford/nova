"""Integration tests for AI Quality v2 endpoints — real services, no mocks."""
from __future__ import annotations

import os
import uuid

import httpx
import pytest

ORCHESTRATOR_URL = os.getenv("NOVA_ORCHESTRATOR_URL", "http://localhost:8000")
ADMIN_SECRET = os.getenv("NOVA_ADMIN_SECRET", "")


async def _trigger_benchmark_get_snapshot_id(client) -> str:
    """Kick off a benchmark just to get a snapshot captured. We don't wait for completion."""
    r = await client.post(
        "/api/v1/quality/benchmarks/run",
        headers={"X-Admin-Secret": ADMIN_SECRET},
    )
    assert r.status_code == 202
    run_id = r.json()["run_id"]

    # Snapshot is captured synchronously before kickoff returns.
    # Read the run row to get the snapshot id.
    list_r = await client.get(
        "/api/v1/quality/benchmarks/runs?limit=5",
        headers={"X-Admin-Secret": ADMIN_SECRET},
    )
    runs = list_r.json()
    for r in runs:
        if r["id"] == run_id:
            return r["config_snapshot_id"]
    pytest.fail(f"could not find run {run_id} in list response")


@pytest.mark.asyncio
async def test_snapshot_get_returns_404_for_missing():
    if not ADMIN_SECRET:
        pytest.skip("NOVA_ADMIN_SECRET not set")
    fake_uuid = str(uuid.uuid4())
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=10.0) as client:
        r = await client.get(
            f"/api/v1/quality/snapshots/{fake_uuid}",
            headers={"X-Admin-Secret": ADMIN_SECRET},
        )
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_snapshot_get_real():
    """Trigger a benchmark to capture a snapshot, then GET it."""
    if not ADMIN_SECRET:
        pytest.skip("NOVA_ADMIN_SECRET not set")
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=30.0) as client:
        snapshot_id = await _trigger_benchmark_get_snapshot_id(client)
        r = await client.get(
            f"/api/v1/quality/snapshots/{snapshot_id}",
            headers={"X-Admin-Secret": ADMIN_SECRET},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["id"] == snapshot_id
        assert "config_hash" in body
        assert "config" in body
        assert "captured_at" in body


@pytest.mark.asyncio
async def test_snapshot_diff_self_returns_empty():
    """Diffing a snapshot against itself returns no changed_keys."""
    if not ADMIN_SECRET:
        pytest.skip("NOVA_ADMIN_SECRET not set")
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=30.0) as client:
        snapshot_id = await _trigger_benchmark_get_snapshot_id(client)
        r = await client.get(
            f"/api/v1/quality/snapshots/diff?from={snapshot_id}&to={snapshot_id}",
            headers={"X-Admin-Secret": ADMIN_SECRET},
        )
        assert r.status_code == 200
        body = r.json()
        assert body["changed_keys"] == []


@pytest.mark.asyncio
async def test_snapshot_diff_404_on_missing():
    if not ADMIN_SECRET:
        pytest.skip("NOVA_ADMIN_SECRET not set")
    fake1 = str(uuid.uuid4())
    fake2 = str(uuid.uuid4())
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=10.0) as client:
        r = await client.get(
            f"/api/v1/quality/snapshots/diff?from={fake1}&to={fake2}",
            headers={"X-Admin-Secret": ADMIN_SECRET},
        )
        assert r.status_code == 404


@pytest.mark.asyncio
@pytest.mark.slow
async def test_retrieval_tuning_loop_full_lifecycle():
    """End-to-end: switch loop A to auto_apply, trigger run-now, verify session persists.

    Slow test (~8 min minimum because each benchmark takes 60-120s and the
    full loop lifecycle is sense (1 benchmark) + verify (1 benchmark)).
    With a broken LLM gateway, each benchmark will time out per case (~14 min
    per benchmark × 2 benchmarks = ~28 min) — but the loop will still complete
    with decision='revert' and outcome='no_change' because composite delta = 0.
    Skip this test in CI by default; run manually when validating closed-loop
    behavior end-to-end.

    Use NOVA_RUN_SLOW_QUALITY_TESTS=1 to opt in:
        NOVA_RUN_SLOW_QUALITY_TESTS=1 pytest tests/test_quality_v2.py -v -m slow
    """
    if os.getenv("NOVA_RUN_SLOW_QUALITY_TESTS") != "1":
        pytest.skip("Slow test — set NOVA_RUN_SLOW_QUALITY_TESTS=1 to run")
    if not ADMIN_SECRET:
        pytest.skip("NOVA_ADMIN_SECRET not set")

    import asyncio as aio
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=600.0) as client:
        h = {"X-Admin-Secret": ADMIN_SECRET}

        # 1. Switch loop A to auto_apply for the test
        r = await client.patch(
            "/api/v1/quality/loops/retrieval_tuning/agency",
            headers=h, json={"agency": "auto_apply"},
        )
        assert r.status_code == 200

        try:
            # 2. Run-now
            r = await client.post(
                "/api/v1/quality/loops/retrieval_tuning/run-now", headers=h,
            )
            assert r.status_code == 200

            # 3. Wait up to 30 minutes for full lifecycle (covers slow LLM timeouts)
            sessions: list[dict] = []
            for _ in range(180):  # 180 × 10s = 30 min
                await aio.sleep(10)
                r = await client.get(
                    "/api/v1/quality/loops/retrieval_tuning/sessions?limit=1", headers=h,
                )
                sessions = r.json()
                if sessions and sessions[0].get("completed_at"):
                    break

            assert sessions, "loop session never recorded"
            session = sessions[0]
            assert session["completed_at"], "loop session never completed"
            # Decision must be one of the terminal states the auto_apply path produces
            assert session["decision"] in ("persist", "revert", "alert_only", "auto"), (
                f"unexpected decision: {session['decision']}"
            )
            assert session["outcome"] in ("improved", "no_change", "regressed", "aborted"), session["outcome"]

        finally:
            # 4. Restore alert_only agency
            await client.patch(
                "/api/v1/quality/loops/retrieval_tuning/agency",
                headers=h, json={"agency": "alert_only"},
            )
