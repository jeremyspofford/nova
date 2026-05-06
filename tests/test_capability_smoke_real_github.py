"""Real-GitHub smoke tests — gated by REQUIRES_GITHUB=1.

When the env vars below are set, these tests hit api.github.com against the
dedicated test repo `jeremyspofford/nova-test-cap`. Otherwise they skip.

## Required setup

1. Create the test repo: https://github.com/new — name `nova-test-cap`,
   private or public, owner `jeremyspofford`. Initialize with a README so
   `main` exists. Add a minimal CI workflow at `.github/workflows/ci.yml`
   so workflow_run events have something to fire on (not strictly needed
   for these tests; only for the manual T11.2 walkthrough).

2. Create a Personal Access Token: https://github.com/settings/tokens
   Scopes required: `repo`, `workflow`, `admin:repo_hook`.

3. Run with both env vars set::

      REQUIRES_GITHUB=1 NOVA_GITHUB_PAT=ghp_xxx pytest tests/test_capability_smoke_real_github.py -v

## Tests included

1. `test_credential_validates_against_real_github` — orchestrator
   credential vault → real `/user` → captures granted scopes.
2. `test_list_workflow_runs_real` — read-only, confirms PAT can list runs.
3. `test_webhook_lifecycle_real` — register → ping → unregister webhook
   via direct API. Tests the lifecycle without needing Nova's webhook
   receiver to be publicly reachable.
4. `test_open_close_test_pr_real` — creates a branch, commits a tiny file,
   opens a PR, closes it, deletes the branch.
5. `test_comment_on_pr_real` — opens a temp PR, posts a comment, deletes
   the comment, closes the PR. Each test creates its own PR for isolation.

The full webhook → cortex triage flow (criterion 5 from spec §13) is *not*
automated here because it requires Nova's webhook receiver to be reachable
from the public internet. That path is covered by the T11.2 manual
acceptance walkthrough — see `docs/capability-acceptance-checklist.md`.

## If a test fails mid-flight

Some tests create resources on real GitHub. Each uses try/finally to clean
up, but if the orchestrator dies during a test, you may need to manually
clean up. Manual cleanup commands::

    # List webhooks (look for entries pointing at example.invalid):
    curl -H "Authorization: Bearer $NOVA_GITHUB_PAT" https://api.github.com/repos/jeremyspofford/nova-test-cap/hooks

    # Delete a stale webhook:
    curl -X DELETE -H "Authorization: Bearer $NOVA_GITHUB_PAT" https://api.github.com/repos/jeremyspofford/nova-test-cap/hooks/<hook_id>

    # List branches matching the smoke prefix:
    curl -H "Authorization: Bearer $NOVA_GITHUB_PAT" https://api.github.com/repos/jeremyspofford/nova-test-cap/branches | jq '.[].name | select(startswith("nova-smoke"))'

    # Delete a stale smoke branch:
    curl -X DELETE -H "Authorization: Bearer $NOVA_GITHUB_PAT" https://api.github.com/repos/jeremyspofford/nova-test-cap/git/refs/heads/nova-smoke-<hex>
"""
from __future__ import annotations

import base64
import os
from uuid import uuid4

import httpx
import pytest

REPO = "jeremyspofford/nova-test-cap"
GITHUB_API = "https://api.github.com"
PAT = os.environ.get("NOVA_GITHUB_PAT", "")

requires_real_github = pytest.mark.skipif(
    os.environ.get("REQUIRES_GITHUB") != "1" or not PAT,
    reason="set REQUIRES_GITHUB=1 and NOVA_GITHUB_PAT=ghp_... to enable",
)


# ── Helpers ─────────────────────────────────────────────────────────────────

async def _gh(method: str, path: str, json: dict | None = None) -> httpx.Response:
    """Direct GitHub API call for setup/cleanup. Bypasses orchestrator."""
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.request(
            method,
            f"{GITHUB_API}{path}",
            headers={
                "Authorization": f"Bearer {PAT}",
                "Accept": "application/vnd.github+json",
            },
            json=json,
        )


async def _create_orchestrator_cred(
    orchestrator: httpx.AsyncClient, admin_headers: dict, label: str
) -> str:
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": label,
            "secret": PAT,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _delete_cred(
    orchestrator: httpx.AsyncClient, admin_headers: dict, cred_id: str
) -> None:
    await orchestrator.delete(
        f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
    )


async def _create_branch_with_commit(branch: str, label: str) -> tuple[str, str]:
    """Create a feature branch off main with one trivial commit. Returns (branch_sha, main_sha)."""
    main_ref = await _gh("GET", f"/repos/{REPO}/git/refs/heads/main")
    assert main_ref.status_code == 200, f"could not read main: {main_ref.text}"
    main_sha = main_ref.json()["object"]["sha"]

    create_branch = await _gh(
        "POST", f"/repos/{REPO}/git/refs",
        json={"ref": f"refs/heads/{branch}", "sha": main_sha},
    )
    assert create_branch.status_code == 201, create_branch.text

    # Add a commit so the branch differs from main
    file_path = f".nova-smoke/{label}-{uuid4().hex[:6]}.txt"
    commit = await _gh(
        "PUT", f"/repos/{REPO}/contents/{file_path}",
        json={
            "message": f"nova smoke: {label}",
            "content": base64.b64encode(b"smoke\n").decode(),
            "branch": branch,
        },
    )
    assert commit.status_code in (200, 201), commit.text
    return commit.json()["commit"]["sha"], main_sha


async def _close_pr_and_delete_branch(pr_number: int | None, branch: str) -> None:
    """Best-effort cleanup. Swallows errors so tests' main assertions surface first."""
    if pr_number is not None:
        try:
            await _gh("PATCH", f"/repos/{REPO}/pulls/{pr_number}", json={"state": "closed"})
        except Exception:
            pass
    try:
        await _gh("DELETE", f"/repos/{REPO}/git/refs/heads/{branch}")
    except Exception:
        pass


# ── Tests ───────────────────────────────────────────────────────────────────

@requires_real_github
@pytest.mark.asyncio
async def test_credential_validates_against_real_github(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Real PAT → orchestrator validation → /user on api.github.com → healthy + scopes."""
    cred_id = await _create_orchestrator_cred(
        orchestrator, admin_headers, "nova-smoke-validate"
    )
    try:
        # No api_base override → orchestrator uses settings.github_api_base_url
        # (defaults to https://api.github.com)
        test = await orchestrator.post(
            f"/api/v1/capabilities/credentials/{cred_id}/test",
            headers=admin_headers,
            json={},
        )
        assert test.status_code == 200, test.text
        assert test.json()["health"] == "healthy"

        got = await orchestrator.get(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )
        scopes = got.json().get("scopes") or {}
        granted = scopes.get("granted") or []
        # The exact scopes depend on the PAT; assert the required-for-Nova ones
        # are present so the test surfaces a misconfigured token.
        for required in ("repo", "admin:repo_hook"):
            assert required in granted, (
                f"PAT missing required scope `{required}`. Granted: {granted}"
            )
    finally:
        await _delete_cred(orchestrator, admin_headers, cred_id)


@requires_real_github
@pytest.mark.asyncio
async def test_list_workflow_runs_real(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Read-only smoke: PAT can list workflow runs against the real repo."""
    resp = await _gh("GET", f"/repos/{REPO}/actions/runs?per_page=5")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert "workflow_runs" in body
    # workflow_runs may be empty on a fresh repo — that's still a successful read.


@requires_real_github
@pytest.mark.asyncio
async def test_webhook_lifecycle_real(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Register → ping → unregister webhook lifecycle via direct API."""
    create = await _gh(
        "POST", f"/repos/{REPO}/hooks",
        json={
            "name": "web",
            "active": True,
            "events": ["workflow_run"],
            # example.invalid is a reserved unreachable domain (RFC 2606) —
            # GitHub will accept the hook but ping delivery will fail. That's
            # OK for this lifecycle test; we don't assert on delivery success.
            "config": {
                "url": "https://example.invalid/nova-smoke-webhook",
                "content_type": "json",
            },
        },
    )
    assert create.status_code == 201, create.text
    hook_id = create.json()["id"]

    try:
        # Trigger a ping. GitHub returns 204 even when delivery fails — the
        # endpoint just confirms the hook exists and a ping was queued.
        ping = await _gh("POST", f"/repos/{REPO}/hooks/{hook_id}/pings")
        assert ping.status_code in (204, 200), ping.text
    finally:
        delete = await _gh("DELETE", f"/repos/{REPO}/hooks/{hook_id}")
        assert delete.status_code == 204, delete.text


@requires_real_github
@pytest.mark.asyncio
async def test_open_close_test_pr_real(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Create branch + commit + PR, close it, delete branch."""
    branch = f"nova-smoke-pr-{uuid4().hex[:8]}"
    pr_number: int | None = None
    try:
        await _create_branch_with_commit(branch, label="open-close")

        pr = await _gh(
            "POST", f"/repos/{REPO}/pulls",
            json={
                "title": "[nova-smoke] open/close test",
                "head": branch,
                "base": "main",
                "body": "Automated smoke test from `tests/test_capability_smoke_real_github.py`. Will be closed automatically.",
            },
        )
        assert pr.status_code == 201, pr.text
        pr_data = pr.json()
        pr_number = pr_data["number"]

        # Verify the PR exists
        got = await _gh("GET", f"/repos/{REPO}/pulls/{pr_number}")
        assert got.status_code == 200
        assert got.json()["state"] == "open"
    finally:
        await _close_pr_and_delete_branch(pr_number, branch)


@requires_real_github
@pytest.mark.asyncio
async def test_comment_on_pr_real(
    orchestrator: httpx.AsyncClient, admin_headers: dict
):
    """Open a temp PR, post a comment on it, delete the comment, close the PR."""
    branch = f"nova-smoke-comment-{uuid4().hex[:8]}"
    pr_number: int | None = None
    comment_id: int | None = None
    try:
        await _create_branch_with_commit(branch, label="comment")

        pr = await _gh(
            "POST", f"/repos/{REPO}/pulls",
            json={
                "title": "[nova-smoke] comment test",
                "head": branch,
                "base": "main",
                "body": "Automated smoke test for comment_on_pr.",
            },
        )
        assert pr.status_code == 201, pr.text
        pr_number = pr.json()["number"]

        # Post a comment (issue comment, the kind comment_on_pr emits).
        comment = await _gh(
            "POST", f"/repos/{REPO}/issues/{pr_number}/comments",
            json={"body": "Smoke test comment from Nova capability platform tests."},
        )
        assert comment.status_code == 201, comment.text
        comment_id = comment.json()["id"]
        assert "Smoke test comment" in comment.json()["body"]

        # Delete the comment
        delete = await _gh("DELETE", f"/repos/{REPO}/issues/comments/{comment_id}")
        assert delete.status_code == 204, delete.text
        comment_id = None  # confirm deleted, skip cleanup
    finally:
        if comment_id is not None:
            try:
                await _gh("DELETE", f"/repos/{REPO}/issues/comments/{comment_id}")
            except Exception:
                pass
        await _close_pr_and_delete_branch(pr_number, branch)
