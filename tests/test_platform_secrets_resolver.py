"""SEC-006a — PlatformSecretsResolver behavior against the live orchestrator.

The resolver is the helper every non-orchestrator service (gateway, chat-bridge)
imports to fetch a platform secret with env-fallback semantics. Tests cover:

  1. Platform-secret hit returns the stored value.
  2. Env fallback fires when platform_secrets has no entry but os.environ does.
  3. Returns None when neither source has the key.
  4. Env-fallback logs a WARN exactly once per key.
  5. Caching: a value seeded once is served from cache after deletion (within TTL).

No mocks per project rule — hits the real orchestrator at localhost:8000.
"""
from __future__ import annotations

import logging
import os

import pytest

from nova_worker_common.platform_secrets import (
    PlatformSecretsResolver,
    fetch_platform_secrets_sync,
)

# Use a key prefix that test cleanup recognizes and that no real consumer reads.
_TEST_PREFIX = "nova-test-resolver"


@pytest.fixture
def resolver(admin_secret: str) -> PlatformSecretsResolver:
    """Fresh resolver per test, pointed at the local orchestrator."""
    return PlatformSecretsResolver(
        orchestrator_url="http://localhost:8000",
        admin_secret=admin_secret,
        cache_ttl_seconds=30,
    )


@pytest.fixture
def admin_secret() -> str:
    val = os.getenv("NOVA_ADMIN_SECRET", "")
    if not val:
        pytest.skip("NOVA_ADMIN_SECRET not set in test env")
    return val


async def _seed_secret(orchestrator, admin_headers, key: str, value: str) -> None:
    r = await orchestrator.patch(
        "/api/v1/admin/secrets",
        headers=admin_headers,
        json={"updates": {key: value}},
    )
    assert r.status_code == 200, r.text


async def _clear_secret(orchestrator, admin_headers, key: str) -> None:
    await orchestrator.delete(
        f"/api/v1/admin/secrets/{key}",
        headers=admin_headers,
    )


@pytest.mark.asyncio
async def test_returns_platform_secret_when_present(
    resolver, orchestrator, admin_headers
):
    key = f"{_TEST_PREFIX}-hit"
    expected = "sk-fake-resolver-hit-001"
    await _seed_secret(orchestrator, admin_headers, key, expected)
    try:
        got = await resolver.get(key)
        assert got == expected
    finally:
        await _clear_secret(orchestrator, admin_headers, key)
        await resolver.aclose()


@pytest.mark.asyncio
async def test_falls_back_to_env_when_platform_secret_missing(
    resolver, monkeypatch
):
    key = f"{_TEST_PREFIX}-env-fallback"
    monkeypatch.setenv(key, "from-env-12345")
    try:
        got = await resolver.get(key)
        assert got == "from-env-12345"
    finally:
        await resolver.aclose()


@pytest.mark.asyncio
async def test_returns_none_when_neither_source_has_key(
    resolver, monkeypatch
):
    key = f"{_TEST_PREFIX}-truly-missing"
    monkeypatch.delenv(key, raising=False)
    try:
        got = await resolver.get(key)
        assert got is None
    finally:
        await resolver.aclose()


@pytest.mark.asyncio
async def test_env_fallback_logs_warn_once_per_key(
    resolver, monkeypatch, caplog
):
    key = f"{_TEST_PREFIX}-warn-once"
    monkeypatch.setenv(key, "from-env-warn-test")
    try:
        with caplog.at_level(logging.WARNING, logger="nova_worker_common.platform_secrets"):
            await resolver.get(key)
            await resolver.get(key)
            await resolver.get(key)
        warns = [r for r in caplog.records if key in r.getMessage() and r.levelno == logging.WARNING]
        assert len(warns) == 1, f"expected exactly 1 WARN, got {len(warns)}: {[w.getMessage() for w in warns]}"
    finally:
        await resolver.aclose()


@pytest.mark.asyncio
async def test_cache_serves_value_after_backend_deletion(
    resolver, orchestrator, admin_headers
):
    """A value seeded then deleted should still be served from cache (TTL > 0)."""
    key = f"{_TEST_PREFIX}-cache"
    await _seed_secret(orchestrator, admin_headers, key, "cached-value-001")
    try:
        first = await resolver.get(key)
        assert first == "cached-value-001"

        # Delete from platform_secrets — cache should still serve the old value.
        await _clear_secret(orchestrator, admin_headers, key)

        second = await resolver.get(key)
        assert second == "cached-value-001", "cache should serve the prior value within TTL"
    finally:
        await _clear_secret(orchestrator, admin_headers, key)
        await resolver.aclose()


# ─── fetch_platform_secrets_sync ──────────────────────────────────────────────
# Sync batch helper for service startup (gateway/bridge), where module-level
# code runs before any event loop exists. Returns {key: value} for every key
# present in platform_secrets; missing keys are simply absent from the dict.


@pytest.mark.asyncio
async def test_sync_fetch_returns_seeded_values_only(
    orchestrator, admin_headers, admin_secret
):
    present = f"{_TEST_PREFIX}-sync-present"
    missing = f"{_TEST_PREFIX}-sync-missing"
    await _seed_secret(orchestrator, admin_headers, present, "sync-hit-001")
    try:
        got = fetch_platform_secrets_sync(
            orchestrator_url="http://localhost:8000",
            admin_secret=admin_secret,
            keys=[present, missing],
        )
        assert got == {present: "sync-hit-001"}
    finally:
        await _clear_secret(orchestrator, admin_headers, present)


def test_sync_fetch_returns_empty_on_unreachable_orchestrator(admin_secret):
    """If the orchestrator is down, the helper must NOT crash boot — empty dict."""
    got = fetch_platform_secrets_sync(
        orchestrator_url="http://127.0.0.1:1",  # nothing listening
        admin_secret=admin_secret,
        keys=["whatever"],
        timeout=0.5,
    )
    assert got == {}


def test_sync_fetch_returns_empty_on_bad_admin_secret():
    """Wrong admin secret → 401 from orchestrator → empty dict, not raise."""
    got = fetch_platform_secrets_sync(
        orchestrator_url="http://localhost:8000",
        admin_secret="not-the-real-secret",
        keys=["nova-test-resolver-anything"],
        timeout=2.0,
    )
    assert got == {}
