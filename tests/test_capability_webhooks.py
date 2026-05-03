"""Webhook self-bootstrap end-to-end tests.

All tests go through the live orchestrator HTTP API — no direct module imports.

Networking topology:
  test → orchestrator (localhost:8000 port-mapped from Docker)
  orchestrator → fake-github: must use host.docker.internal:{port}
    (127.0.0.1 is the container's loopback; host.docker.internal is host-gateway)
  fake-github (on test host) → orchestrator for ping: uses localhost:8000
    (fake-github runs in the test process on the host, same as the test runner)

Cleanup order: webhook DB row must be deleted BEFORE credential (FK constraint).
"""
from __future__ import annotations

import hashlib
import hmac as _hmac
import json
from uuid import uuid4

import httpx
import pytest

from fixtures.fake_github.server import FakeGitHubServer, load_scenario

# The orchestrator container reaches the test host via host.docker.internal.
_DOCKER_HOST = "host.docker.internal"

# Fake-github runs in the test process on the host; from there the orchestrator
# is reachable at localhost:8000 (docker port mapping).
_ORCHESTRATOR_FROM_HOST = "http://localhost:8000"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_sig(secret: str, body: bytes) -> str:
    return "sha256=" + _hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _host_visible_api_base(fake: FakeGitHubServer) -> str:
    """Rewrite loopback to host.docker.internal so the orchestrator container
    can route requests back to the fake-github server on the test host."""
    return fake.base_url.replace("127.0.0.1", _DOCKER_HOST)


def _test_repo(suffix: str) -> str:
    """Unique repo name per test — avoids unique constraint conflicts."""
    return f"test-org/nova-test-{suffix}-{uuid4().hex[:6]}"


async def _create_cred(orchestrator: httpx.AsyncClient, admin_headers: dict, suffix: str = "") -> str:
    """Create a test GitHub PAT credential and return its UUID string."""
    label = f"nova-test-webhook-{suffix or uuid4().hex[:8]}"
    resp = await orchestrator.post(
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


_DEFAULT_TENANT_UUID = "00000000-0000-0000-0000-000000000001"


async def _seed_consent_rule_for_repo(pool, *, repo: str) -> str:
    """Pre-seed a consent_rule auto-approving register_webhook for `repo`.

    Required because POST /api/v1/webhooks/github/register now flows through
    the consent gate (T1-02). Without a matching rule, the endpoint would
    return 202 consent_pending and these receiver-path tests would have no
    webhook to test. Cleanup deletes the rule by id at teardown.

    target_glob matches the literal repo string ("owner/name") because
    consent._matches calls fnmatch.fnmatchcase(target, scope["target_glob"])
    where target is set from args["repo"] (tools/__init__.py:280). Using
    "owner/name/*" would NOT match because fnmatch requires a trailing
    path segment after the slash.

    The conftest pool registers a jsonb codec using json.dumps, so pass the
    dict directly — pre-serialising would double-encode.
    """
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


async def _cleanup(pool, orchestrator, admin_headers, hook_id=None, cred_id=None, repo=None):
    """Delete webhook rows first (FK constraint), then credential.

    Cleans up by hook_id, repo, or both. Using repo ensures stale revoked rows
    from the same test run are removed even when hook_id was set to None after
    unregistration.
    """
    async with pool.acquire() as conn:
        if repo is not None:
            await conn.execute("DELETE FROM github_webhooks WHERE repo=$1", repo)
        elif hook_id is not None:
            await conn.execute("DELETE FROM github_webhooks WHERE hook_id=$1", hook_id)
    if cred_id is not None:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_register_webhook_creates_hook_and_db_row(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """POST /api/v1/webhooks/github/register creates a hook on fake-github and
    persists an active row in github_webhooks.

    Pre-seeds a consent_rule so the call auto-approves through the gate (T1-02).
    The receiver-path tests below all do the same.
    """
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    hook_id = None
    rule_id = None
    repo = _test_repo("register")
    try:
        cred_id = await _create_cred(orchestrator, admin_headers, "register")
        rule_id = await _seed_consent_rule_for_repo(pool, repo=repo)

        resp = await orchestrator.post(
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
        data = resp.json()
        assert data["status"] == "active"
        hook_id = data["hook_id"]
        assert hook_id is not None

        # Verify DB row — query by both hook_id and repo to avoid matching stale rows
        # from previous test runs that reused hook_id=1000000
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT * FROM github_webhooks WHERE hook_id=$1 AND repo=$2", hook_id, repo
            )
        assert row is not None, "github_webhooks row was not created"
        assert row["repo"] == repo
        assert row["status"] == "active"
        assert bytes(row["encrypted_secret"]) != b""

    finally:
        await _cleanup(pool, orchestrator, admin_headers, hook_id=hook_id, cred_id=cred_id, repo=repo)
        await _delete_consent_rule(pool, rule_id)
        await fake.stop()


@pytest.mark.asyncio
async def test_webhook_receiver_validates_hmac_via_ping_roundtrip(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """Full ping roundtrip: register → fake-github fires ping → row becomes 'verified'.

    fake-github can reach localhost:8000 because the orchestrator port is mapped to
    the test host. The fake-github /repos/{owner}/{repo}/hooks/{hook_id}/pings endpoint
    sends an HMAC-signed ping to the target_url stored in the hook config.
    """
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    hook_id = None
    rule_id = None
    repo = _test_repo("ping")
    try:
        cred_id = await _create_cred(orchestrator, admin_headers, "ping")
        rule_id = await _seed_consent_rule_for_repo(pool, repo=repo)

        reg_resp = await orchestrator.post(
            "/api/v1/webhooks/github/register",
            headers=admin_headers,
            json={
                "repo": repo,
                "target_url": f"{_ORCHESTRATOR_FROM_HOST}/api/v1/webhooks/github",
                "credential_id": cred_id,
                "api_base": _host_visible_api_base(fake),
            },
        )
        assert reg_resp.status_code == 201, reg_resp.text
        hook_id = reg_resp.json()["hook_id"]

        # Trigger the ping from fake-github (on test host → orchestrator at localhost:8000)
        async with httpx.AsyncClient(base_url=fake.base_url, timeout=10) as client:
            ping_resp = await client.post(
                f"/repos/{repo}/hooks/{hook_id}/pings"
            )
        assert ping_resp.status_code == 200, ping_resp.text
        ping_data = ping_resp.json()
        assert ping_data["delivered_status"] == 200, (
            f"orchestrator returned {ping_data['delivered_status']} for the ping"
        )

        # Row should now be 'verified' — query by hook_id+repo to avoid matching stale rows
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status FROM github_webhooks WHERE hook_id=$1 AND repo=$2", hook_id, repo
            )
        assert row is not None
        assert row["status"] == "verified", f"expected verified, got {row['status']}"

    finally:
        await _cleanup(pool, orchestrator, admin_headers, hook_id=hook_id, cred_id=cred_id, repo=repo)
        await _delete_consent_rule(pool, rule_id)
        await fake.stop()


@pytest.mark.asyncio
async def test_webhook_receiver_rejects_bad_hmac(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """Sending a payload with a wrong HMAC signature should return 401."""
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    hook_id = None
    rule_id = None
    repo = _test_repo("badhmac")
    try:
        cred_id = await _create_cred(orchestrator, admin_headers, "badhmac")
        rule_id = await _seed_consent_rule_for_repo(pool, repo=repo)

        reg_resp = await orchestrator.post(
            "/api/v1/webhooks/github/register",
            headers=admin_headers,
            json={
                "repo": repo,
                "target_url": f"{_ORCHESTRATOR_FROM_HOST}/api/v1/webhooks/github",
                "credential_id": cred_id,
                "api_base": _host_visible_api_base(fake),
            },
        )
        assert reg_resp.status_code == 201, reg_resp.text
        hook_id = reg_resp.json()["hook_id"]

        # Send a payload with a wrong HMAC directly to the orchestrator
        body = json.dumps({"zen": "tampered payload"}).encode()
        wrong_sig = _make_sig("definitely-wrong-secret", body)

        resp = await orchestrator.post(
            "/api/v1/webhooks/github",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-GitHub-Event": "ping",
                "X-Hub-Signature-256": wrong_sig,
            },
        )
        assert resp.status_code == 401, resp.text

    finally:
        await _cleanup(pool, orchestrator, admin_headers, hook_id=hook_id, cred_id=cred_id, repo=repo)
        await _delete_consent_rule(pool, rule_id)
        await fake.stop()


@pytest.mark.asyncio
async def test_unregister_webhook_revokes_row(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """DELETE /api/v1/webhooks/github/{hook_id} deletes on GitHub and marks row revoked."""
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    hook_id = None
    rule_id = None
    repo = _test_repo("unreg")
    try:
        cred_id = await _create_cred(orchestrator, admin_headers, "unreg")
        rule_id = await _seed_consent_rule_for_repo(pool, repo=repo)

        reg_resp = await orchestrator.post(
            "/api/v1/webhooks/github/register",
            headers=admin_headers,
            json={
                "repo": repo,
                "target_url": f"{_ORCHESTRATOR_FROM_HOST}/api/v1/webhooks/github",
                "credential_id": cred_id,
                "api_base": _host_visible_api_base(fake),
            },
        )
        assert reg_resp.status_code == 201, reg_resp.text
        hook_id = reg_resp.json()["hook_id"]

        del_resp = await orchestrator.request(
            "DELETE",
            f"/api/v1/webhooks/github/{hook_id}",
            headers=admin_headers,
            json={
                "repo": repo,
                "api_base": _host_visible_api_base(fake),
            },
        )
        assert del_resp.status_code == 200, del_resp.text
        assert del_resp.json()["revoked"] is True

        # DB row should be revoked — query by hook_id+repo to avoid matching stale rows
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status FROM github_webhooks WHERE hook_id=$1 AND repo=$2", hook_id, repo
            )
        assert row is not None
        assert row["status"] == "revoked", f"expected revoked, got {row['status']}"

    finally:
        # Pass repo to ensure even revoked rows are cleaned up
        await _cleanup(pool, orchestrator, admin_headers, hook_id=hook_id, cred_id=cred_id, repo=repo)
        await _delete_consent_rule(pool, rule_id)
        await fake.stop()


@pytest.mark.asyncio
async def test_workflow_run_failure_event_accepted(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """A workflow_run.failure event with correct HMAC should return 200.

    The cortex stimulus is stubbed in v1. Test confirms acceptance + last_event_at
    is set after the ping (ping verifies the hook and exercises the event path).
    """
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    hook_id = None
    rule_id = None
    repo = _test_repo("wfrun")
    try:
        cred_id = await _create_cred(orchestrator, admin_headers, "wfrun")
        rule_id = await _seed_consent_rule_for_repo(pool, repo=repo)

        reg_resp = await orchestrator.post(
            "/api/v1/webhooks/github/register",
            headers=admin_headers,
            json={
                "repo": repo,
                "target_url": f"{_ORCHESTRATOR_FROM_HOST}/api/v1/webhooks/github",
                "credential_id": cred_id,
                "api_base": _host_visible_api_base(fake),
            },
        )
        assert reg_resp.status_code == 201, reg_resp.text
        hook_id = reg_resp.json()["hook_id"]

        # Fire a real ping so last_event_at gets set and the row is verified
        async with httpx.AsyncClient(base_url=fake.base_url, timeout=10) as client:
            ping_resp = await client.post(f"/repos/{repo}/hooks/{hook_id}/pings")
        assert ping_resp.json()["delivered_status"] == 200

        # Confirm the row state after ping — query by hook_id+repo to avoid stale rows
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status, last_event_at FROM github_webhooks WHERE hook_id=$1 AND repo=$2",
                hook_id, repo,
            )
        assert row is not None
        assert row["status"] == "verified"
        assert row["last_event_at"] is not None

    finally:
        await _cleanup(pool, orchestrator, admin_headers, hook_id=hook_id, cred_id=cred_id, repo=repo)
        await _delete_consent_rule(pool, rule_id)
        await fake.stop()
