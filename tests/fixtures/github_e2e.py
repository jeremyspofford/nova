"""Helpers for the real-GitHub end-to-end CI triage test.

These call api.github.com directly via httpx — they are production data
scaffolding that lives outside Nova's tool layer. The seam under test is
"GitHub failure → cortex stimulus → orchestrator approval → fix PR opened",
so the test must drive GitHub directly and observe Nova reacting.

All helpers require a Personal Access Token (PAT) with `repo` and `workflow`
scopes. Use ``preflight_pat_scopes()`` once at the start of the test to fail
fast on a misconfigured token rather than 30 minutes later with a cryptic 403.

The repo is the dedicated test repo ``jeremyspofford/nova-test-cap``. Branch
names use the ``nova-test-e2e-{hex8}`` prefix so cleanup can find leftover
branches from interrupted test runs.
"""
from __future__ import annotations

import base64
import logging
from typing import Any

import httpx

GITHUB_API = "https://api.github.com"
DEFAULT_TIMEOUT = 30
log = logging.getLogger(__name__)


# ── Internal helper ──────────────────────────────────────────────────────────


def _headers(pat: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {pat}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }


async def _gh(
    method: str,
    path: str,
    pat: str,
    *,
    json: dict[str, Any] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> httpx.Response:
    """Direct GitHub API call. The `path` should start with '/'."""
    async with httpx.AsyncClient(timeout=timeout) as client:
        return await client.request(
            method,
            f"{GITHUB_API}{path}",
            headers=_headers(pat),
            json=json,
        )


# ── Preflight ────────────────────────────────────────────────────────────────


async def preflight_pat_scopes(pat: str) -> set[str]:
    """Return the set of OAuth scopes granted to ``pat``.

    Calls ``GET /user`` and reads ``X-OAuth-Scopes``. Raises ``RuntimeError`` if
    GitHub does not return 200 (token invalid or rate-limited). The caller can
    then assert membership of required scopes (typically ``{"repo", "workflow"}``).
    """
    resp = await _gh("GET", "/user", pat=pat, timeout=10)
    if resp.status_code != 200:
        raise RuntimeError(
            f"GitHub /user returned {resp.status_code}: {resp.text[:200]}"
        )
    raw = resp.headers.get("X-OAuth-Scopes", "") or ""
    scopes = {s.strip() for s in raw.split(",") if s.strip()}
    return scopes


async def has_workflow(repo: str, pat: str) -> bool:
    """True iff ``repo`` has at least one Actions workflow registered.

    Used by the test fixture to skip (not fail) when the test repo lacks the
    expected ``.github/workflows/ci.yml`` — the user is responsible for setting
    that up; the test does not create workflows.
    """
    resp = await _gh("GET", f"/repos/{repo}/actions/workflows", pat=pat, timeout=10)
    if resp.status_code != 200:
        return False
    body = resp.json()
    return int(body.get("total_count", 0)) > 0


# ── Branch + commit creation ─────────────────────────────────────────────────


async def push_breaking_commit(
    repo: str,
    branch: str,
    pat: str,
    *,
    sentinel_path: str = "BREAK_ME",
    sentinel_content: bytes = b"trigger CI failure\n",
    commit_message: str | None = None,
) -> str:
    """Create ``branch`` off the default branch and push a sentinel file.

    The default sentinel matches the workflow in
    ``docs/capability-acceptance-checklist.md`` — the workflow fails when
    ``BREAK_ME`` exists at the repo root.

    Returns the commit sha of the new HEAD on ``branch``.
    """
    # Resolve the default branch's HEAD sha.
    repo_resp = await _gh("GET", f"/repos/{repo}", pat=pat)
    if repo_resp.status_code != 200:
        raise RuntimeError(f"Could not read repo {repo}: {repo_resp.text[:200]}")
    default_branch = repo_resp.json().get("default_branch", "main")

    head_ref = await _gh(
        "GET", f"/repos/{repo}/git/refs/heads/{default_branch}", pat=pat
    )
    if head_ref.status_code != 200:
        raise RuntimeError(
            f"Could not read {default_branch} on {repo}: {head_ref.text[:200]}"
        )
    head_sha = head_ref.json()["object"]["sha"]

    # Create the branch from the default-branch sha.
    create = await _gh(
        "POST",
        f"/repos/{repo}/git/refs",
        pat=pat,
        json={"ref": f"refs/heads/{branch}", "sha": head_sha},
    )
    if create.status_code not in (200, 201):
        raise RuntimeError(
            f"Could not create branch {branch} on {repo}: "
            f"{create.status_code} {create.text[:200]}"
        )

    # Add the sentinel file via Contents API. Encoded payload triggers a
    # commit on ``branch`` whose CI will fail.
    msg = commit_message or f"nova-test-e2e: trigger CI failure ({sentinel_path})"
    file_resp = await _gh(
        "PUT",
        f"/repos/{repo}/contents/{sentinel_path}",
        pat=pat,
        json={
            "message": msg,
            "content": base64.b64encode(sentinel_content).decode(),
            "branch": branch,
        },
    )
    if file_resp.status_code not in (200, 201):
        raise RuntimeError(
            f"Could not commit sentinel on {branch}: "
            f"{file_resp.status_code} {file_resp.text[:200]}"
        )
    return file_resp.json()["commit"]["sha"]


# ── Pull-request introspection + cleanup ─────────────────────────────────────


async def get_open_prs(repo: str, pat: str) -> list[dict[str, Any]]:
    """Return all currently open PRs on ``repo`` (max 100 — fine for the test repo)."""
    resp = await _gh(
        "GET",
        f"/repos/{repo}/pulls?state=open&per_page=100",
        pat=pat,
    )
    if resp.status_code != 200:
        raise RuntimeError(
            f"Could not list open PRs on {repo}: {resp.status_code} {resp.text[:200]}"
        )
    return list(resp.json())


async def close_pr(repo: str, pr_number: int, pat: str) -> None:
    """Close PR ``pr_number`` on ``repo``. Best-effort — swallows non-fatal errors."""
    resp = await _gh(
        "PATCH",
        f"/repos/{repo}/pulls/{pr_number}",
        pat=pat,
        json={"state": "closed"},
    )
    if resp.status_code not in (200, 201):
        log.warning(
            "close_pr: PR #%s on %s returned %d: %s",
            pr_number,
            repo,
            resp.status_code,
            resp.text[:200],
        )


async def delete_branch(repo: str, branch: str, pat: str) -> None:
    """Delete ``branch`` on ``repo``. 422 means the branch was already deleted; OK."""
    resp = await _gh(
        "DELETE",
        f"/repos/{repo}/git/refs/heads/{branch}",
        pat=pat,
    )
    # 204 = deleted. 422 = ref doesn't exist (idempotent). Anything else is weird.
    if resp.status_code not in (204, 422):
        log.warning(
            "delete_branch: %s on %s returned %d: %s",
            branch,
            repo,
            resp.status_code,
            resp.text[:200],
        )


# ── Workflow run helpers ─────────────────────────────────────────────────────


async def list_workflow_runs_for_branch(
    repo: str, branch: str, pat: str
) -> list[dict[str, Any]]:
    """Return workflow runs scoped to ``branch`` on ``repo``.

    Used by the test to confirm a failing run was actually produced by the
    breaking commit before waiting on Nova's reaction.
    """
    resp = await _gh(
        "GET",
        f"/repos/{repo}/actions/runs?branch={branch}&per_page=10",
        pat=pat,
    )
    if resp.status_code != 200:
        return []
    return list(resp.json().get("workflow_runs", []))
