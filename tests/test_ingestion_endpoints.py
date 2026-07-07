"""Generalized ingestion endpoint: POST /api/v1/ingest + source registration.

One authenticated HTTP door into memory:ingestion:queue (db0), replacing the
per-source bridge pattern. Tests assert against the REAL queue via redis —
payloads must match the memory-service consumer contract exactly.
"""
from __future__ import annotations

import json
import os
import uuid

import httpx
import pytest
import redis.asyncio as aioredis

ORCHESTRATOR = "http://localhost:8000"
MEMORY = "http://localhost:8002"
QUEUE = "memory:ingestion:queue"


async def _marker_reaches_memory(marker: str, timeout_s: float = 12.0) -> bool:
    """The honest end-to-end assertion: the live memory-service consumer eats
    queue items within milliseconds (BLMOVE), so queue inspection races and
    loses. Instead: poll memory retrieval until the ingested marker is
    findable — proves queued AND consumed AND written AND indexed."""
    import asyncio
    deadline = asyncio.get_event_loop().time() + timeout_s
    async with httpx.AsyncClient(timeout=10.0) as c:
        while asyncio.get_event_loop().time() < deadline:
            r = await c.post(
                f"{MEMORY}/api/v1/memory/context",
                json={"query": marker, "session_id": "nova-test-ingest", "current_turn": 0},
            )
            if r.status_code == 200 and marker in r.text:
                return True
            await asyncio.sleep(1.0)
    return False


@pytest.mark.asyncio
async def test_ingest_requires_auth(orchestrator: httpx.AsyncClient):
    r = await orchestrator.post(
        "/api/v1/ingest",
        json={"source_type": "external", "source_name": "nova-test-app", "raw_text": "x"},
    )
    assert r.status_code in (401, 403)


@pytest.mark.asyncio
async def test_ingest_rejects_empty_text(orchestrator: httpx.AsyncClient, admin_headers: dict):
    r = await orchestrator.post(
        "/api/v1/ingest",
        headers=admin_headers,
        json={"source_type": "external", "source_name": "nova-test-app", "raw_text": "   "},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_ingest_pushes_consumer_contract_to_queue(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    marker = f"nova-test-ingest-{uuid.uuid4().hex[:8]}"
    r = await orchestrator.post(
        "/api/v1/ingest",
        headers=admin_headers,
        json={
            "source_type": "external",
            "source_name": "nova-test-app",
            "raw_text": f"the quick brown fox {marker}",
            "source_title": "test ingest",
            "metadata": {"k": "v"},
        },
    )
    r.raise_for_status()
    body = r.json()
    assert body["queued"] is True
    assert body["source"] == "nova-test-app"

    # End-to-end: the payload was consumed by memory-service and is retrievable.
    assert await _marker_reaches_memory(marker), (
        "ingested payload never became retrievable from memory — "
        "queue push or consumer contract broken"
    )


@pytest.mark.asyncio
async def test_source_register_token_push_revoke(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    name = f"nova-test-src-{uuid.uuid4().hex[:8]}"
    reg = await orchestrator.post(
        "/api/v1/ingest/sources",
        headers=admin_headers,
        json={"name": name, "source_type": "external", "trust": 0.9,
              "rate_limit_per_minute": 60},
    )
    assert reg.status_code == 201, reg.text
    body = reg.json()
    token = body["token"]
    source_id = body["id"]
    assert token.startswith("sk-nova-ingest-")

    try:
        # Listing never leaks tokens
        listing = await orchestrator.get("/api/v1/ingest/sources", headers=admin_headers)
        mine = next(s for s in listing.json() if s["name"] == name)
        assert mine["has_token"] is True and "token" not in mine and "api_key_hash" not in mine

        # Token authenticates a push, and the registered identity wins
        marker = f"nova-test-token-{uuid.uuid4().hex[:8]}"
        push = await orchestrator.post(
            "/api/v1/ingest",
            headers={"Authorization": f"Bearer {token}"},
            json={"raw_text": f"pushed by token {marker}"},
        )
        assert push.status_code == 200, push.text
        assert push.json()["source"] == name
        assert await _marker_reaches_memory(marker), "token push never reached memory"

        # Bad token is rejected
        bad = await orchestrator.post(
            "/api/v1/ingest",
            headers={"Authorization": "Bearer sk-nova-ingest-not-a-real-token"},
            json={"raw_text": "nope"},
        )
        assert bad.status_code == 401

        # Revoke → token stops working
        rev = await orchestrator.delete(
            f"/api/v1/ingest/sources/{source_id}", headers=admin_headers
        )
        assert rev.status_code == 204
        after = await orchestrator.post(
            "/api/v1/ingest",
            headers={"Authorization": f"Bearer {token}"},
            json={"raw_text": "revoked"},
        )
        assert after.status_code == 401
    finally:
        await orchestrator.delete(f"/api/v1/ingest/sources/{source_id}", headers=admin_headers)


@pytest.mark.asyncio
async def test_per_source_rate_limit(orchestrator: httpx.AsyncClient, admin_headers: dict):
    name = f"nova-test-rl-{uuid.uuid4().hex[:8]}"
    reg = await orchestrator.post(
        "/api/v1/ingest/sources",
        headers=admin_headers,
        json={"name": name, "rate_limit_per_minute": 3},
    )
    token = reg.json()["token"]
    source_id = reg.json()["id"]

    try:
        codes = []
        for i in range(5):
            r = await orchestrator.post(
                "/api/v1/ingest",
                headers={"Authorization": f"Bearer {token}"},
                json={"raw_text": f"rl probe {i}"},
            )
            codes.append(r.status_code)
        assert 429 in codes, f"rate limit never engaged: {codes}"
        assert codes[:3] == [200, 200, 200], f"limit engaged too early: {codes}"
        # Queued probes are consumed by the live pipeline — journal-bound
        # test noise, acceptable in the integration suite.
    finally:
        await orchestrator.delete(f"/api/v1/ingest/sources/{source_id}", headers=admin_headers)


@pytest.mark.asyncio
async def test_denylist_drops_matching_payloads(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    name = f"nova-test-dl-{uuid.uuid4().hex[:8]}"
    reg = await orchestrator.post(
        "/api/v1/ingest/sources",
        headers=admin_headers,
        json={"name": name, "denylist_apps": ["1password"],
              "denylist_url_patterns": ["bank.example"]},
    )
    token = reg.json()["token"]
    source_id = reg.json()["id"]
    try:
        r = await orchestrator.post(
            "/api/v1/ingest",
            headers={"Authorization": f"Bearer {token}"},
            json={"raw_text": "secret vault contents", "metadata": {"app": "1Password"}},
        )
        assert r.status_code == 200
        assert r.json()["queued"] is False and "denylist" in r.json()["reason"]

        r2 = await orchestrator.post(
            "/api/v1/ingest",
            headers={"Authorization": f"Bearer {token}"},
            json={"raw_text": "statement page", "metadata": {"url": "https://bank.example/acct"}},
        )
        assert r2.json()["queued"] is False
    finally:
        await orchestrator.delete(f"/api/v1/ingest/sources/{source_id}", headers=admin_headers)


@pytest.mark.asyncio
async def test_backpressure_503_when_saturated(
    orchestrator: httpx.AsyncClient, admin_headers: dict, pool
):
    # Force the threshold to 0 via platform_config (cache TTL is 3s).
    import asyncio
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO platform_config (key, value, description)
               VALUES ('ingestion.max_queue_depth', '0'::jsonb, 'test')
               ON CONFLICT (key) DO UPDATE SET value = '0'::jsonb"""
        )
    try:
        await asyncio.sleep(3.2)
        r = await orchestrator.post(
            "/api/v1/ingest",
            headers=admin_headers,
            json={"raw_text": "should be refused", "source_name": "nova-test-bp"},
        )
        assert r.status_code == 503
        assert "Retry-After" in r.headers
    finally:
        async with pool.acquire() as conn:
            await conn.execute(
                "DELETE FROM platform_config WHERE key = 'ingestion.max_queue_depth'"
            )
        await asyncio.sleep(3.2)
