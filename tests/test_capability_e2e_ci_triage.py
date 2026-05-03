"""T1-03: CI triage end-to-end automated test — the final v1 gate.

This file replaces steps 1-7 of ``docs/capability-acceptance-checklist.md``
with a Python test that actually drives a real GitHub repo through Nova's
full pipeline: failing CI → cortex stimulus → ``open_fix_pr`` approval card
→ approve → fix-PR opened on GitHub.

Until this test exists, every release relies on a manual walkthrough to
prove the seam is intact. With it, the seam runs on demand against the real
external dependency that matters most.

## Required setup (run once, by the user)

1. Create the test repo: https://github.com/new — name ``nova-test-cap``,
   owner ``jeremyspofford`` (mirrors ``test_capability_smoke_real_github.py``).
   Initialize with a README so ``main`` exists.

2. Add a CI workflow at ``.github/workflows/ci.yml`` that fails when a
   sentinel file ``BREAK_ME`` exists at the repo root::

       name: ci
       on:
         push: {}
         pull_request: {}
       jobs:
         test:
           runs-on: ubuntu-latest
           steps:
             - uses: actions/checkout@v4
             - run: test ! -f BREAK_ME

   Without this workflow no ``workflow_run.failure`` event is produced and
   the test cannot trigger Nova. The fixture preflight checks that *some*
   workflow exists and SKIPS (not fails) the test if absent.

3. Create a Personal Access Token: https://github.com/settings/tokens — scopes
   ``repo`` and ``workflow`` (``admin:repo_hook`` is also useful for full
   acceptance). The fixture preflight verifies these scopes are granted.

4. Optional but strongly recommended: expose Nova's ``/api/v1/webhooks/github``
   over the public internet (Cloudflare Tunnel, ngrok, Tailscale Funnel) and
   set ``NOVA_PUBLIC_URL=https://your-public-url`` so the test exercises the
   webhook path. Without it, the test falls back to polling mode with a
   longer wait window.

## Running

    REQUIRES_GITHUB=1 \\
      NOVA_GITHUB_PAT=ghp_xxx \\
      NOVA_PUBLIC_URL=https://your-public-url \\
      pytest tests/test_capability_e2e_ci_triage.py -v -s

Without ``REQUIRES_GITHUB=1`` and ``NOVA_GITHUB_PAT`` both set, the tests skip
cleanly. ``make test`` does NOT pick these up — they require external network
access and a real GitHub repo.

## Cleanup

Each test uses ``try/finally`` to clean up its own branch + PR + watched-repo
+ credential rows. If the orchestrator dies mid-test, leftover ``nova-test-e2e-*``
branches can be cleaned up manually — see
``tests/test_capability_smoke_real_github.py`` for example commands.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest

from fixtures.github_e2e import (
    close_pr,
    delete_branch,
    get_open_prs,
    has_workflow,
    list_workflow_runs_for_branch,
    preflight_pat_scopes,
    push_breaking_commit,
)


# ── Constants ────────────────────────────────────────────────────────────────

REPO = "jeremyspofford/nova-test-cap"
PAT = os.environ.get("NOVA_GITHUB_PAT", "")
NOVA_PUBLIC_URL = os.environ.get("NOVA_PUBLIC_URL", "")
TENANT_UUID = UUID("00000000-0000-0000-0000-000000000001")

# Timeouts: webhook path is fast (~30-60s round trip from GitHub Actions to
# orchestrator). Polling mode depends on the polling worker cadence + the
# watched-repo's ``polling_interval_min`` (default 15min). We set the watched
# repo to 1min for the test.
WEBHOOK_PATH_TIMEOUT_S = 240   # 4 min — webhook path; covers slow Actions
POLLING_PATH_TIMEOUT_S = 960   # 16 min — polling fallback when no public URL
PR_OPEN_TIMEOUT_S = 120        # how long after approve to wait for the PR
APPROVAL_POLL_INTERVAL_S = 5

REQUIRED_PAT_SCOPES = {"repo", "workflow"}

log = logging.getLogger(__name__)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _branch_name(label: str) -> str:
    """Test branches always carry the nova-test-e2e prefix for cleanup."""
    return f"nova-test-e2e-{label}-{uuid4().hex[:8]}"


async def _ensure_credential(
    orchestrator: httpx.AsyncClient, admin_headers: dict
) -> str:
    """Create a credential carrying the real PAT. Returns its UUID."""
    resp = await orchestrator.post(
        "/api/v1/capabilities/credentials",
        headers=admin_headers,
        json={
            "provider_kind": "github",
            "auth_method": "pat",
            "label": f"nova-test-e2e-cred-{uuid4().hex[:6]}",
            "secret": PAT,
        },
    )
    assert resp.status_code == 201, f"create credential failed: {resp.text}"
    return resp.json()["id"]


async def _ensure_watched_repo(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    *,
    cred_id: str,
    polling_interval_min: int = 1,
    daily_budget: int = 20,
) -> str:
    """Watch ``REPO`` under ``cred_id``. Returns watched-repo UUID."""
    resp = await orchestrator.post(
        f"/api/v1/capabilities/credentials/{cred_id}/watched-repos",
        headers=admin_headers,
        json={
            "repo": REPO,
            "trigger_mode": "webhook_with_polling_fallback",
            "polling_interval_min": polling_interval_min,
            "daily_budget": daily_budget,
        },
    )
    assert resp.status_code == 201, f"create watched repo failed: {resp.text}"
    return resp.json()["id"]


async def _ensure_consent_rule_for_register_webhook(pool, *, repo: str) -> str:
    """Pre-seed a consent rule that auto-approves register_webhook for ``repo``.

    Otherwise the first ``POST /api/v1/webhooks/github/register`` call would
    return 202 and the test would have to navigate the consent gate. T1-02
    already covers that path; this test exercises the *outcome* (a webhook
    that fires events).
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
            TENANT_UUID,
            {"target_glob": repo},
        )
    return str(row["id"])


async def _maybe_register_webhook(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    *,
    cred_id: str,
) -> int | None:
    """Register a webhook on the test repo pointing at NOVA_PUBLIC_URL.

    Returns the GitHub hook id, or None if NOVA_PUBLIC_URL is not configured.
    Caller falls back to polling mode in that case.
    """
    if not NOVA_PUBLIC_URL:
        log.warning(
            "NOVA_PUBLIC_URL not set — falling back to polling mode "
            "(longer wait window)."
        )
        return None

    target_url = NOVA_PUBLIC_URL.rstrip("/") + "/api/v1/webhooks/github"
    resp = await orchestrator.post(
        "/api/v1/webhooks/github/register",
        headers=admin_headers,
        json={
            "repo": REPO,
            "target_url": target_url,
            "credential_id": cred_id,
        },
    )
    # 201: auto-approved (consent rule existed). 202: consent_pending. 422+:
    # an underlying error worth surfacing.
    if resp.status_code == 201:
        return int(resp.json()["hook_id"])
    if resp.status_code == 202:
        # Should not happen — we pre-seed the consent rule. But if it does, the
        # test still works (cortex polling will catch the failure). Return None
        # so caller treats it as no webhook.
        log.warning(
            "register_webhook returned consent_pending — no consent rule matched. "
            "Falling back to polling path."
        )
        return None
    raise RuntimeError(
        f"register_webhook returned {resp.status_code}: {resp.text[:300]}"
    )


async def _unregister_webhook(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    *,
    hook_id: int,
) -> None:
    """Best-effort unregister; swallow errors so test failures aren't masked."""
    try:
        await orchestrator.request(
            "DELETE",
            f"/api/v1/webhooks/github/{hook_id}",
            headers=admin_headers,
            json={"repo": REPO},
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("unregister_webhook failed (non-fatal): %s", exc)


async def _poll_for_open_fix_pr_approval(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    *,
    timeout_s: float,
    poll_interval_s: float = APPROVAL_POLL_INTERVAL_S,
) -> dict[str, Any] | None:
    """Poll list_pending_approvals until one with tool_name='open_fix_pr' appears.

    Returns the approval row, or None on timeout.
    """
    deadline = time.monotonic() + timeout_s
    last_count = -1
    while time.monotonic() < deadline:
        resp = await orchestrator.get(
            "/api/v1/capabilities/approvals", headers=admin_headers
        )
        if resp.status_code == 200:
            pending = [
                a for a in resp.json()
                if a.get("tool_name") == "open_fix_pr"
                and (a.get("target") or "").startswith(REPO)
            ]
            if len(pending) != last_count:
                # Visible progress signal for `-s` runs
                log.info(
                    "polling for open_fix_pr approval — %d pending matching %s",
                    len(pending),
                    REPO,
                )
                last_count = len(pending)
            if pending:
                return pending[0]
        await asyncio.sleep(poll_interval_s)
    return None


async def _approve(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    *,
    approval_id: str,
) -> None:
    resp = await orchestrator.post(
        f"/api/v1/capabilities/approvals/{approval_id}/decide",
        headers=admin_headers,
        json={"decision": "approve"},
    )
    assert resp.status_code == 200, f"decide(approve) failed: {resp.text}"


async def _wait_for_fix_pr(
    *, since_branch: str, timeout_s: float
) -> dict[str, Any] | None:
    """Poll GitHub for an open PR referencing the failing branch.

    Cortex's open_fix_pr opens a fresh branch (e.g. ``nova-fix-ci/{run}``) but
    the PR body usually references the failing run / branch. We accept any PR
    opened after ``since_branch`` was created, on the test repo.
    """
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        prs = await get_open_prs(REPO, PAT)
        for pr in prs:
            # Heuristic: a PR whose head branch is NOT the failing branch and
            # whose title or body references "nova" or the failing branch is
            # considered the fix PR.
            head_ref = (pr.get("head") or {}).get("ref") or ""
            title = (pr.get("title") or "").lower()
            body = (pr.get("body") or "").lower()
            if head_ref == since_branch:
                continue  # that's the failing branch itself, not the fix
            if (
                "nova" in title
                or "nova" in body
                or since_branch.lower() in body
                or "fix ci" in title
                or "fix-ci" in head_ref
            ):
                return pr
        await asyncio.sleep(5)
    return None


async def _delete_consent_rule(pool, rule_id: str | None) -> None:
    if rule_id is None:
        return
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM consent_rules WHERE id=$1", UUID(rule_id))


async def _delete_watched_repo(
    orchestrator: httpx.AsyncClient, admin_headers: dict, repo_id: str | None
) -> None:
    if repo_id is None:
        return
    try:
        await orchestrator.delete(
            f"/api/v1/capabilities/watched-repos/{repo_id}", headers=admin_headers
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("delete_watched_repo failed (non-fatal): %s", exc)


async def _delete_credential(
    orchestrator: httpx.AsyncClient, admin_headers: dict, cred_id: str | None
) -> None:
    if cred_id is None:
        return
    try:
        await orchestrator.delete(
            f"/api/v1/capabilities/credentials/{cred_id}", headers=admin_headers
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("delete_credential failed (non-fatal): %s", exc)


async def _preflight() -> None:
    """Verify PAT scopes and workflow presence. Skips the test on misconfig."""
    try:
        scopes = await preflight_pat_scopes(PAT)
    except Exception as exc:
        pytest.skip(f"PAT preflight failed: {exc}")

    missing = REQUIRED_PAT_SCOPES - scopes
    if missing:
        pytest.fail(
            f"NOVA_GITHUB_PAT is missing required scopes: {sorted(missing)}. "
            f"Granted: {sorted(scopes)}. Add `repo` and `workflow` at "
            f"https://github.com/settings/tokens."
        )

    if not await has_workflow(REPO, PAT):
        pytest.skip(
            f"{REPO} has no Actions workflows registered. Add "
            f".github/workflows/ci.yml that fails when BREAK_ME exists "
            f"(see this file's docstring) and rerun."
        )


# ── Tests ────────────────────────────────────────────────────────────────────


@pytest.mark.requires_github
@pytest.mark.slow
@pytest.mark.asyncio
async def test_full_ci_triage_loop_opens_pr(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """The headline seam: GitHub failure → Nova approval card → fix PR opens.

    Flow:
      1. Preflight: PAT has repo+workflow; test repo has a workflow file.
      2. Create credential + watched repo (trigger=webhook_with_polling_fallback).
      3. Pre-seed consent rule for register_webhook (skip the consent dance).
      4. (Optional) Register webhook to NOVA_PUBLIC_URL. If unset, fall back
         to polling mode with a longer wait window.
      5. Push a synthetic breaking commit on a dedicated branch.
      6. Poll /api/v1/capabilities/approvals for an open_fix_pr card.
      7. Approve. Within ~2min a PR appears on the test repo.
      8. Teardown closes PR, deletes branch, removes webhook + watched repo +
         credential + consent rule.
    """
    await _preflight()

    branch = _branch_name("ci-triage")
    cred_id: str | None = None
    watched_id: str | None = None
    consent_rule_id: str | None = None
    hook_id: int | None = None
    fix_pr: dict[str, Any] | None = None

    try:
        # 2. credential + watched repo
        cred_id = await _ensure_credential(orchestrator, admin_headers)
        watched_id = await _ensure_watched_repo(
            orchestrator, admin_headers, cred_id=cred_id, polling_interval_min=1
        )

        # 3. consent rule
        consent_rule_id = await _ensure_consent_rule_for_register_webhook(
            pool, repo=REPO
        )

        # 4. webhook (best-effort)
        hook_id = await _maybe_register_webhook(
            orchestrator, admin_headers, cred_id=cred_id
        )
        webhook_path = hook_id is not None

        # 5. push breaking commit
        commit_sha = await push_breaking_commit(REPO, branch, PAT)
        log.info("pushed breaking commit %s on %s", commit_sha[:8], branch)

        # Brief sanity: GitHub Actions schedules quickly but doesn't always
        # report a run within the first second. Don't block the main poll on it,
        # just print whether a run was visible.
        await asyncio.sleep(5)
        runs = await list_workflow_runs_for_branch(REPO, branch, PAT)
        log.info(
            "GitHub reports %d workflow run(s) for branch %s",
            len(runs),
            branch,
        )

        # 6. poll for the open_fix_pr approval
        timeout_s = WEBHOOK_PATH_TIMEOUT_S if webhook_path else POLLING_PATH_TIMEOUT_S
        approval = await _poll_for_open_fix_pr_approval(
            orchestrator, admin_headers, timeout_s=timeout_s
        )
        assert approval is not None, (
            f"no open_fix_pr approval appeared for {REPO} within {timeout_s}s "
            f"(webhook_path={webhook_path}). Check cortex logs for "
            f"workflow_run.failure stimulus reception."
        )

        approval_id = approval["id"]
        log.info("approval %s appeared — approving", approval_id)

        # 7. approve
        await _approve(orchestrator, admin_headers, approval_id=approval_id)

        # 8. wait for fix PR
        fix_pr = await _wait_for_fix_pr(
            since_branch=branch, timeout_s=PR_OPEN_TIMEOUT_S
        )
        assert fix_pr is not None, (
            f"approval was approved but no fix PR appeared on {REPO} within "
            f"{PR_OPEN_TIMEOUT_S}s — check ci_triage_agent task status"
        )
        assert fix_pr["state"] == "open"
        log.info(
            "fix PR opened: #%d %s", fix_pr["number"], fix_pr.get("title")
        )

    finally:
        # Teardown: close any opened fix PR, delete failing branch, unregister
        # webhook, drop watched repo + credential + consent rule.
        if fix_pr is not None:
            try:
                await close_pr(REPO, fix_pr["number"], PAT)
                fix_head = (fix_pr.get("head") or {}).get("ref")
                if fix_head and fix_head != branch:
                    await delete_branch(REPO, fix_head, PAT)
            except Exception as exc:  # noqa: BLE001
                log.warning("fix-PR teardown failed: %s", exc)

        try:
            await delete_branch(REPO, branch, PAT)
        except Exception as exc:  # noqa: BLE001
            log.warning("delete_branch (failing) failed: %s", exc)

        if hook_id is not None:
            await _unregister_webhook(orchestrator, admin_headers, hook_id=hook_id)

        await _delete_watched_repo(orchestrator, admin_headers, watched_id)
        await _delete_credential(orchestrator, admin_headers, cred_id)
        await _delete_consent_rule(pool, consent_rule_id)


@pytest.mark.requires_github
@pytest.mark.slow
@pytest.mark.asyncio
async def test_ci_triage_budget_cap_skips_second_failure(
    orchestrator: httpx.AsyncClient,
    admin_headers: dict,
    pool,
):
    """Daily budget=1 means the second failure of the day produces no card.

    Flow:
      1. Preflight.
      2. Watched repo with daily_budget=1.
      3. Push two distinct breaking commits in close succession.
      4. After timeout window, exactly one open_fix_pr approval exists for REPO.
      5. capability_audit has a budget_exceeded row referencing REPO with a
         timestamp inside the test window.
    """
    await _preflight()

    branch_a = _branch_name("budget-a")
    branch_b = _branch_name("budget-b")
    cred_id: str | None = None
    watched_id: str | None = None
    consent_rule_id: str | None = None
    hook_id: int | None = None
    test_started_at = time.time()

    try:
        # 2. credential + watched repo (budget=1)
        cred_id = await _ensure_credential(orchestrator, admin_headers)
        watched_id = await _ensure_watched_repo(
            orchestrator,
            admin_headers,
            cred_id=cred_id,
            polling_interval_min=1,
            daily_budget=1,
        )

        # 3. consent rule + webhook
        consent_rule_id = await _ensure_consent_rule_for_register_webhook(
            pool, repo=REPO
        )
        hook_id = await _maybe_register_webhook(
            orchestrator, admin_headers, cred_id=cred_id
        )
        webhook_path = hook_id is not None

        # 4. push two breaking commits with distinct sentinel content so each
        # triggers a workflow_run.failure.
        await push_breaking_commit(
            REPO, branch_a, PAT, sentinel_content=b"fail-a\n",
            commit_message="nova-test-e2e: budget-a (first failure)",
        )
        await asyncio.sleep(15)
        await push_breaking_commit(
            REPO, branch_b, PAT, sentinel_content=b"fail-b\n",
            commit_message="nova-test-e2e: budget-b (second failure, should be capped)",
        )

        # 5. wait the same window
        timeout_s = WEBHOOK_PATH_TIMEOUT_S if webhook_path else POLLING_PATH_TIMEOUT_S
        first_approval = await _poll_for_open_fix_pr_approval(
            orchestrator, admin_headers, timeout_s=timeout_s
        )
        assert first_approval is not None, (
            f"first failure produced no open_fix_pr approval within {timeout_s}s"
        )

        # Reject so we don't actually open a PR (this test cares about the
        # budget gate, not the approve path — covered by the headline test).
        await orchestrator.post(
            f"/api/v1/capabilities/approvals/{first_approval['id']}/decide",
            headers=admin_headers,
            json={"decision": "reject"},
        )

        # Wait an additional window long enough for cortex to receive the
        # second failure and reject it on the budget gate.
        await asyncio.sleep(30 if webhook_path else 90)

        # Confirm: no second approval card
        resp = await orchestrator.get(
            "/api/v1/capabilities/approvals", headers=admin_headers
        )
        assert resp.status_code == 200
        pending_for_repo = [
            a for a in resp.json()
            if a.get("tool_name") == "open_fix_pr"
            and (a.get("target") or "").startswith(REPO)
        ]
        assert pending_for_repo == [], (
            f"second failure produced an approval card despite budget=1: "
            f"{pending_for_repo}"
        )

        # 6. capability_audit has a budget_exceeded row from this run
        async with pool.acquire() as conn:
            audit_row = await conn.fetchrow(
                """
                SELECT timestamp, target, response_summary
                FROM capability_audit
                WHERE event_type = 'budget_exceeded'
                  AND target = $1
                  AND timestamp > to_timestamp($2)
                ORDER BY timestamp DESC LIMIT 1
                """,
                REPO,
                test_started_at,
            )
        assert audit_row is not None, (
            f"expected a budget_exceeded audit row for {REPO} since "
            f"{test_started_at} — none found"
        )
        assert REPO in (audit_row["target"] or "")

    finally:
        try:
            await delete_branch(REPO, branch_a, PAT)
        except Exception as exc:  # noqa: BLE001
            log.warning("delete branch_a failed: %s", exc)
        try:
            await delete_branch(REPO, branch_b, PAT)
        except Exception as exc:  # noqa: BLE001
            log.warning("delete branch_b failed: %s", exc)

        if hook_id is not None:
            await _unregister_webhook(orchestrator, admin_headers, hook_id=hook_id)

        await _delete_watched_repo(orchestrator, admin_headers, watched_id)
        await _delete_credential(orchestrator, admin_headers, cred_id)
        await _delete_consent_rule(pool, consent_rule_id)
