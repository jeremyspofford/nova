"""T1-02: register_webhook through the consent gate.

Today, POST /api/v1/webhooks/github/register calls _register_webhook directly,
bypassing capabilities.executor and the consent gate. The endpoint should
instead route through execute_tool() so MUTATE-classified webhook creations
surface an approval card on first use, and auto-approve on subsequent use
when a consent_rule scoped to the same repo exists.

Networking topology mirrors test_capability_webhooks.py:
  test → orchestrator (localhost:8000)
  orchestrator → fake-github via host.docker.internal:{port}
  fake-github → orchestrator via localhost:8000 (test host)
"""
from __future__ import annotations

import asyncio
import time
from uuid import UUID, uuid4

import httpx
import pytest

from fixtures.fake_github import FakeGitHubServer, load_scenario


_DOCKER_HOST = "host.docker.internal"
_ORCHESTRATOR_FROM_HOST = "http://localhost:8000"
TENANT = UUID("00000000-0000-0000-0000-000000000001")


def _host_visible_api_base(fake: FakeGitHubServer) -> str:
    return fake.base_url.replace("127.0.0.1", _DOCKER_HOST)


def _test_repo(suffix: str) -> str:
    return f"nova-test-org/nova-test-{suffix}-{uuid4().hex[:6]}"


async def _create_cred(
    orchestrator: httpx.AsyncClient, admin_headers: dict, suffix: str
) -> str:
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": f"nova-test-webhook-consent-{suffix}-{uuid4().hex[:6]}",
            "secret": "ghp_validtoken",
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _wait_for_webhook_status(
    pool, *, repo: str, expected: tuple[str, ...], timeout_s: float = 5.0,
    poll_s: float = 0.1,
) -> str | None:
    deadline = time.monotonic() + timeout_s
    last_status: str | None = None
    while time.monotonic() < deadline:
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status FROM github_webhooks WHERE repo=$1 ORDER BY created_at DESC LIMIT 1",
                repo,
            )
        if row is not None:
            last_status = row["status"]
            if last_status in expected:
                return last_status
        await asyncio.sleep(poll_s)
    return last_status


async def _cleanup(pool, orchestrator, admin_headers, *, cred_id=None, repo=None):
    async with pool.acquire() as conn:
        if repo is not None:
            await conn.execute("DELETE FROM github_webhooks WHERE repo=$1", repo)
        if cred_id is not None:
            await conn.execute(
                "DELETE FROM consent_rules WHERE tenant_id=$1 AND tool_name=$2",
                TENANT, "register_webhook",
            )
            await conn.execute(
                "DELETE FROM approval_requests WHERE tenant_id=$1 AND tool_name=$2",
                TENANT, "register_webhook",
            )
    if cred_id is not None:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )


@pytest.mark.asyncio
async def test_register_webhook_surfaces_approval_card(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """First-time POST /webhooks/github/register with no rule → 202 + approval row.

    After approve-and-remember, the worker re-executes the call and the webhook
    transitions to active/verified. A consent_rule scoped to the specific repo
    is created.
    """
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    repo = _test_repo("consent")
    try:
        cred_id = await _create_cred(orchestrator, admin_headers, "consent")

        api_base = _host_visible_api_base(fake)

        resp = await orchestrator.post(
            "/api/v1/webhooks/github/register",
            headers=admin_headers,
            json={
                "repo": repo,
                "target_url": f"{_ORCHESTRATOR_FROM_HOST}/api/v1/webhooks/github",
                "credential_id": cred_id,
                "api_base": api_base,
            },
        )
        # 4. Pending consent → 202
        assert resp.status_code == 202, (
            f"expected 202 consent_pending; got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert body["status"] == "consent_pending", body
        assert "approval_id" in body and body["approval_id"], body
        approval_id = body["approval_id"]

        # 6. List pending approvals — exactly one for register_webhook
        list_resp = await orchestrator.get(
            "/api/v1/capabilities/approvals", headers=admin_headers
        )
        assert list_resp.status_code == 200, list_resp.text
        pendings = [
            a for a in list_resp.json()
            if a["tool_name"] == "register_webhook" and a["id"] == approval_id
        ]
        assert len(pendings) == 1, f"expected 1 pending; got {pendings}"
        assert pendings[0]["blast_radius"] == "mutate"

        # capability_audit must contain a consent_request row
        async with pool.acquire() as conn:
            cr_row = await conn.fetchrow(
                "SELECT * FROM capability_audit "
                "WHERE event_type='consent_request' AND tool_name='register_webhook' "
                "ORDER BY timestamp DESC LIMIT 1"
            )
        assert cr_row is not None, "expected consent_request audit row"

        # Stash the api_base override in tool_context so the worker re-executes
        # against fake-github instead of the real GitHub API.
        async with pool.acquire() as conn:
            row_ctx = await conn.fetchval(
                "SELECT tool_context FROM approval_requests WHERE id=$1",
                UUID(approval_id),
            )
            existing = dict(row_ctx) if isinstance(row_ctx, dict) else {}
            existing["_test_api_base"] = api_base
            await conn.execute(
                "UPDATE approval_requests SET tool_context = $2 WHERE id = $1",
                UUID(approval_id), existing,
            )

        # 7. Approve with remember=True and target_glob scoped to this repo.
        # `target` resolves to args["repo"] (literal "owner/name") in
        # tools/__init__.py:280. fnmatch.fnmatchcase("owner/name", "owner/name")
        # matches; "owner/name/*" would NOT match because the glob requires
        # a trailing path segment. So the rule's glob must equal the repo
        # directly to scope to "this repo only".
        decide_resp = await orchestrator.post(
            f"/api/v1/capabilities/approvals/{approval_id}/decide",
            headers=admin_headers,
            json={
                "decision": "approve",
                "remember": True,
                "rule_scope": {"target_glob": repo},
            },
        )
        assert decide_resp.status_code == 200, decide_resp.text

        # 8. Within 5s the github_webhooks row transitions to active/verified
        final_status = await _wait_for_webhook_status(
            pool, repo=repo, expected=("active", "verified"), timeout_s=10.0,
        )
        assert final_status in ("active", "verified"), (
            f"expected webhook to reach active/verified; last={final_status!r}"
        )

        # 9. consent_rules row exists with provider_kind=github, source=user_remember
        async with pool.acquire() as conn:
            rule = await conn.fetchrow(
                "SELECT * FROM consent_rules "
                "WHERE tool_name='register_webhook' AND tenant_id=$1 "
                "ORDER BY accepted_at DESC LIMIT 1",
                TENANT,
            )
        assert rule is not None, "expected consent_rule for register_webhook"
        assert rule["source"] == "user_remember"
        assert rule["provider_kind"] == "github"
        scope = rule["scope_match"]
        if isinstance(scope, str):
            import json as _json
            scope = _json.loads(scope)
        assert scope.get("target_glob") == repo, (
            f"rule scope_match unexpected: {scope}"
        )

    finally:
        await _cleanup(pool, orchestrator, admin_headers, cred_id=cred_id, repo=repo)
        await fake.stop()


@pytest.mark.asyncio
async def test_register_webhook_auto_approved_by_rule(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """A pre-existing consent_rule for register_webhook scoped to the same repo
    auto-approves: endpoint returns 201 immediately and creates no pending row."""
    fake = FakeGitHubServer(scenarios=load_scenario("lint_failure_in_pr"))
    await fake.start()
    cred_id = None
    repo = _test_repo("autorule")
    rule_id = None
    try:
        cred_id = await _create_cred(orchestrator, admin_headers, "autorule")

        api_base = _host_visible_api_base(fake)

        # Pre-seed a consent_rule scoped to this repo. target_glob equals
        # the literal repo path ("owner/name") because consent._matches uses
        # fnmatch against `target = args["repo"]`; "owner/name/*" would NOT
        # match because fnmatch requires a trailing path segment.
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO consent_rules (
                  tenant_id, user_id, tool_name, provider_kind,
                  scope_match, source
                ) VALUES ($1, $2, $3, $4, $5, 'user_remember')
                RETURNING id
                """,
                TENANT, TENANT, "register_webhook", "github",
                {"target_glob": repo},
            )
            rule_id = row["id"]

        # Snapshot pending count before
        pre_resp = await orchestrator.get(
            "/api/v1/capabilities/approvals", headers=admin_headers
        )
        assert pre_resp.status_code == 200
        pre_count = sum(
            1 for a in pre_resp.json() if a["tool_name"] == "register_webhook"
        )

        resp = await orchestrator.post(
            "/api/v1/webhooks/github/register",
            headers=admin_headers,
            json={
                "repo": repo,
                "target_url": f"{_ORCHESTRATOR_FROM_HOST}/api/v1/webhooks/github",
                "credential_id": cred_id,
                "api_base": api_base,
            },
        )
        # Auto-approved → 201 with the existing result dict
        assert resp.status_code == 201, (
            f"expected 201 auto-approved; got {resp.status_code}: {resp.text}"
        )
        body = resp.json()
        assert body.get("status") == "active", body
        assert body.get("hook_id") is not None

        # No new pending approval was created for register_webhook
        post_resp = await orchestrator.get(
            "/api/v1/capabilities/approvals", headers=admin_headers
        )
        post_count = sum(
            1 for a in post_resp.json() if a["tool_name"] == "register_webhook"
        )
        assert post_count == pre_count, (
            f"auto-approve produced a pending row "
            f"(before={pre_count}, after={post_count})"
        )

        # DB row was created directly (no worker round-trip needed)
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT status FROM github_webhooks WHERE repo=$1", repo
            )
        assert row is not None
        assert row["status"] == "active"

    finally:
        if rule_id is not None:
            async with pool.acquire() as conn:
                await conn.execute(
                    "DELETE FROM consent_rules WHERE id=$1", rule_id
                )
        await _cleanup(pool, orchestrator, admin_headers, cred_id=cred_id, repo=repo)
        await fake.stop()
