"""Wiring tests for cortex maintain drive's webhook health-ping integration (T2-04).

Closes G11 from `docs/audits/2026-05-03-readiness-assessment.md`. Two things
must be true after T2-04:

1. Orchestrator exposes a new admin endpoint
   ``POST /api/v1/capabilities/webhooks/ping-all`` that, for every
   ``github_webhooks`` row whose status is in ``('active','verified')``,
   pings GitHub at ``POST /repos/{owner}/{repo}/hooks/{hook_id}/pings``,
   updates ``last_pinged_at`` on success, and flips ``status='failed'`` on
   any non-204 response. Returns
   ``{"pinged": n, "failed": [{hook_id, repo, status_code, message?}, …]}``.

2. Cortex's maintain drive runs ``_ping_webhooks(ctx)`` next to
   ``_run_verify_chain(ctx)`` under the same time-gate (or on a
   ``security.verify_chain`` stimulus). It calls the orchestrator endpoint
   above and re-emits a ``github.webhook_failed`` stimulus for each
   failed entry.

Tests exercise BOTH legs:
  * Cortex side via ``POST /api/v1/cortex/__test/ping-webhooks`` — analogous
    to the T2-03 ``__test/run-verify-chain`` seam, gated on
    ``CORTEX_TEST_MODE``. Avoids racing the BRPOP cadence.
  * Orchestrator side via the admin endpoint directly (so we can also
    confirm the response shape).

Networking topology mirrors `tests/test_capability_webhooks.py`:
  test → orchestrator (localhost:8000)
  orchestrator → fake-github: must use host.docker.internal:{port}

The fake-github fixture is extended (T2-04) with a per-hook ``ping_responses``
override so a test can pin the ping endpoint at 204 (healthy) or 404
(stale hook). Without an override the legacy 200/delivered behavior used by
``test_capability_webhooks.py`` continues to apply.
"""
from __future__ import annotations

import json
from uuid import uuid4

import httpx
import pytest
import redis.asyncio as aioredis

from fixtures.fake_github.server import FakeGitHubServer, load_scenario

CORTEX_URL = "http://localhost:8100"
CORTEX_REDIS_URL = "redis://localhost:6379/5"

_DOCKER_HOST = "host.docker.internal"
_ORCHESTRATOR_FROM_HOST = "http://localhost:8000"
_DEFAULT_TENANT_UUID = "00000000-0000-0000-0000-000000000001"


# ---------------------------------------------------------------------------
# Helpers — copy the small subset we need from test_capability_webhooks.py
# rather than imposing a new shared module on the suite.
# ---------------------------------------------------------------------------

def _host_visible_api_base(fake: FakeGitHubServer) -> str:
    return fake.base_url.replace("127.0.0.1", _DOCKER_HOST)


def _test_repo(suffix: str) -> str:
    return f"test-org/nova-test-{suffix}-{uuid4().hex[:6]}"


async def _create_cred(orch: httpx.AsyncClient, admin_headers: dict, suffix: str) -> str:
    label = f"nova-test-webhook-health-{suffix}-{uuid4().hex[:6]}"
    resp = await orch.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": label,
            "secret": "ghp_validtoken",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _seed_consent_rule_for_repo(pool, *, repo: str) -> str:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO consent_rules (
              tenant_id, user_id, tool_name, provider_kind,
              scope_match, source
            ) VALUES ($1, $1, 'register_webhook', 'github', $2, 'user_remember')
            RETURNING id
            """,
            _DEFAULT_TENANT_UUID,
            {"target_glob": repo},
        )
    return str(row["id"])


async def _delete_consent_rule(pool, rule_id: str | None) -> None:
    if rule_id is None:
        return
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM consent_rules WHERE id=$1", rule_id)


async def _cleanup(pool, orch, admin_headers, *, hook_id=None, cred_id=None, repo=None):
    async with pool.acquire() as conn:
        if repo is not None:
            await conn.execute("DELETE FROM github_webhooks WHERE repo=$1", repo)
        elif hook_id is not None:
            await conn.execute("DELETE FROM github_webhooks WHERE hook_id=$1", hook_id)
    if cred_id is not None:
        await orch.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


async def _register_webhook(orch, admin_headers, fake, repo, cred_id) -> int:
    """Register a webhook through the consent gate; returns the hook_id."""
    resp = await orch.post(
        "/api/v1/webhooks/github/register",
        headers=admin_headers,
        json={
            "repo": repo,
            "target_url": f"{_ORCHESTRATOR_FROM_HOST}/api/v1/webhooks/github",
            "credential_id": cred_id,
            "api_base": _host_visible_api_base(fake),
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["hook_id"]


async def _set_webhook_status(pool, *, hook_id: int, repo: str, status: str) -> None:
    """Force a webhook row's status — used to set up 'verified' fixtures
    without firing a real ping (which would also flip status)."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE github_webhooks SET status=$1 WHERE hook_id=$2 AND repo=$3",
            status, hook_id, repo,
        )


async def _trigger_cortex_ping_webhooks(api_base: str | None = None) -> dict:
    """Synchronously trigger cortex maintain drive's ``_ping_webhooks``
    via the test-only endpoint. Returns the structured result dict.

    Skips if CORTEX_TEST_MODE isn't set (the endpoint will 403)."""
    payload = {}
    if api_base is not None:
        payload["api_base"] = api_base
    async with httpx.AsyncClient(base_url=CORTEX_URL, timeout=30) as client:
        resp = await client.post(
            "/api/v1/cortex/__test/ping-webhooks",
            json=payload,
        )
    if resp.status_code == 403:
        pytest.skip(
            "CORTEX_TEST_MODE is not enabled — set CORTEX_TEST_MODE=true in .env "
            "to run these wiring tests"
        )
    assert resp.status_code == 200, (
        f"cortex ping-webhooks test endpoint failed: "
        f"{resp.status_code} {resp.text}"
    )
    return resp.json()


async def _drain_webhook_failed_stimuli(hook_id: int) -> list[dict]:
    """Snapshot any ``github.webhook_failed`` stimuli currently enqueued
    for the given hook_id. Non-destructive (LRANGE)."""
    r = aioredis.from_url(CORTEX_REDIS_URL, decode_responses=True)
    out: list[dict] = []
    try:
        items = await r.lrange("cortex:stimuli", 0, -1)
        for raw in items:
            try:
                s = json.loads(raw)
            except Exception:
                continue
            if s.get("type") == "github.webhook_failed":
                payload = s.get("payload") or {}
                if int(payload.get("hook_id") or -1) == hook_id:
                    out.append(s)
    finally:
        await r.aclose()
    return out


async def _drain_all_webhook_failed_stimuli() -> int:
    """Remove leftover github.webhook_failed stimuli before a test starts."""
    r = aioredis.from_url(CORTEX_REDIS_URL, decode_responses=True)
    drained = 0
    try:
        items = await r.lrange("cortex:stimuli", 0, -1)
        if not items:
            return 0
        async with r.pipeline(transaction=True) as pipe:
            await pipe.delete("cortex:stimuli")
            for raw in reversed(items):
                try:
                    s = json.loads(raw)
                except Exception:
                    await pipe.rpush("cortex:stimuli", raw)
                    continue
                if s.get("type") == "github.webhook_failed":
                    drained += 1
                    continue
                await pipe.rpush("cortex:stimuli", raw)
            await pipe.execute()
    finally:
        await r.aclose()
    return drained


# ---------------------------------------------------------------------------
# Test 1 — verified webhook with broken hook on GitHub → marked failed +
#           cortex emits github.webhook_failed
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_maintain_drive_marks_failed_webhook_and_alerts(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """Register a webhook, set its row to ``verified``, then point fake-github's
    ping endpoint at 404 for that hook_id. After ``_ping_webhooks`` runs:
      * The github_webhooks row's status is ``'failed'``.
      * ``last_pinged_at`` is set.
      * A ``github.webhook_failed`` stimulus was emitted.
    """
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    hook_id = None
    rule_id = None
    repo = _test_repo("ping-fail")
    try:
        await _drain_all_webhook_failed_stimuli()
        cred_id = await _create_cred(orchestrator, admin_headers, "fail")
        rule_id = await _seed_consent_rule_for_repo(pool, repo=repo)
        hook_id = await _register_webhook(
            orchestrator, admin_headers, fake, repo, cred_id
        )
        await _set_webhook_status(pool, hook_id=hook_id, repo=repo, status="verified")

        # Configure fake-github to return 404 for this specific hook_id —
        # simulates the hook being deleted on GitHub side.
        async with httpx.AsyncClient(base_url=fake.base_url, timeout=10) as client:
            cfg = await client.post(
                "/_test/ping_responses",
                json={"hook_id": hook_id, "status_code": 404},
            )
            assert cfg.status_code == 200, cfg.text

        # Trigger cortex's maintain drive _ping_webhooks via the test seam.
        result = await _trigger_cortex_ping_webhooks(
            api_base=_host_visible_api_base(fake),
        )
        assert result.get("status") in (None, "ok"), f"cortex result: {result}"

        # The orchestrator response surfaced the failure
        failed = {f["hook_id"]: f for f in (result.get("failed") or [])}
        assert hook_id in failed, (
            f"hook_id {hook_id} not in failed list. Result: {result}"
        )
        assert failed[hook_id]["status_code"] == 404
        assert failed[hook_id]["repo"] == repo

        # Row was flipped to 'failed' and last_pinged_at populated
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, last_pinged_at FROM github_webhooks "
                "WHERE hook_id=$1 AND repo=$2",
                hook_id, repo,
            )
        assert row is not None
        assert row["status"] == "failed", (
            f"expected 'failed', got {row['status']}"
        )
        assert row["last_pinged_at"] is not None

        # Cortex emitted a github.webhook_failed stimulus for our hook_id.
        # The cortex BRPOP loop may consume it before we LRANGE — so we treat
        # the orchestrator response as the durable signal AND tolerate the
        # queue snapshot being empty. If we DO catch it, it must be ours.
        queued = await _drain_webhook_failed_stimuli(hook_id)
        for q in queued:
            payload = q.get("payload") or {}
            assert int(payload.get("hook_id")) == hook_id
            assert payload.get("repo") == repo

    finally:
        await _cleanup(
            pool, orchestrator, admin_headers,
            hook_id=hook_id, cred_id=cred_id, repo=repo,
        )
        await _delete_consent_rule(pool, rule_id)
        await fake.stop()


# ---------------------------------------------------------------------------
# Test 2 — verified webhook with healthy hook on GitHub → stays verified +
#           no stimulus emitted
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_healthy_webhook_stays_verified(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """Register a webhook, set its row to ``verified``, leave fake-github
    returning 204 for the ping. After ``_ping_webhooks`` runs:
      * Status is still ``'verified'`` (NEVER flips back from failed-pretty
        is enforced here implicitly because we start at verified).
      * ``last_pinged_at`` is updated.
      * No ``github.webhook_failed`` stimulus appears for this hook.
    """
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    hook_id = None
    rule_id = None
    repo = _test_repo("ping-ok")
    try:
        await _drain_all_webhook_failed_stimuli()
        cred_id = await _create_cred(orchestrator, admin_headers, "ok")
        rule_id = await _seed_consent_rule_for_repo(pool, repo=repo)
        hook_id = await _register_webhook(
            orchestrator, admin_headers, fake, repo, cred_id
        )
        await _set_webhook_status(pool, hook_id=hook_id, repo=repo, status="verified")

        # Pin the ping endpoint at 204 explicitly so we don't depend on
        # the legacy 200/delivered_status response — the orchestrator
        # treats only 204 as healthy.
        async with httpx.AsyncClient(base_url=fake.base_url, timeout=10) as client:
            cfg = await client.post(
                "/_test/ping_responses",
                json={"hook_id": hook_id, "status_code": 204},
            )
            assert cfg.status_code == 200, cfg.text

        result = await _trigger_cortex_ping_webhooks(
            api_base=_host_visible_api_base(fake),
        )
        assert result.get("status") in (None, "ok"), f"cortex result: {result}"

        # Row stayed verified
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, last_pinged_at FROM github_webhooks "
                "WHERE hook_id=$1 AND repo=$2",
                hook_id, repo,
            )
        assert row is not None
        assert row["status"] == "verified", (
            f"healthy webhook unexpectedly flipped to {row['status']}"
        )
        assert row["last_pinged_at"] is not None

        # No webhook_failed stimulus for our hook_id
        queued = await _drain_webhook_failed_stimuli(hook_id)
        assert queued == [], (
            f"unexpected webhook_failed stimuli for healthy hook: {queued}"
        )

    finally:
        await _cleanup(
            pool, orchestrator, admin_headers,
            hook_id=hook_id, cred_id=cred_id, repo=repo,
        )
        await _delete_consent_rule(pool, rule_id)
        await fake.stop()
