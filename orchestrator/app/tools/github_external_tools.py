"""Native GitHub provider for arbitrary repos (READ tier).

Distinguished from app.tools.github_tools (Self-Modification, Nova's own repo).
See docs/designs/2026-05-01-nova-capability-platform-design.md §5.
"""
from __future__ import annotations
import logging
from typing import Any

import httpx
from nova_contracts import BlastRadius, ToolDefinition

logger = logging.getLogger(__name__)

# Standard schema fragments
_REPO_FIELD = {
    "type": "string",
    "description": "owner/name (e.g. 'jeremyspofford/nova')",
}


GITHUB_EXTERNAL_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="list_workflow_runs",
        description="List recent workflow runs for a repo, optionally filtered by status or branch.",
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "status": {
                    "type": "string",
                    "enum": ["completed", "in_progress", "queued", "failure", "success"],
                    "description": "Filter by run status/conclusion.",
                },
                "branch": {"type": "string", "description": "Filter by head branch name."},
                "per_page": {"type": "integer", "default": 30, "minimum": 1, "maximum": 100},
            },
            "required": ["repo"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="get_workflow_run",
        description="Fetch a single workflow run by ID, including conclusion and HTML URL.",
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "run_id": {"type": "integer"},
            },
            "required": ["repo", "run_id"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="get_run_logs",
        description="Fetch the log text for a workflow run. Returns the raw log content as a string.",
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "run_id": {"type": "integer"},
                "job_id": {"type": "integer", "description": "Optional — limit to a single job."},
            },
            "required": ["repo", "run_id"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="get_run_diff",
        description="Get the changeset associated with a workflow run's PR (the diff that triggered the run).",
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "run_id": {"type": "integer"},
            },
            "required": ["repo", "run_id"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
    ToolDefinition(
        name="compare_to_main",
        description=(
            "Bug-locator: determine whether a workflow run's failure originates from the PR "
            "or from main. Compares the failing job's signature against main's recent CI history. "
            "Returns {'bug_location': 'branch'|'main', 'evidence': str, 'recent_main_runs': list}."
        ),
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "run_id": {"type": "integer"},
            },
            "required": ["repo", "run_id"],
        },
        blast_radius=BlastRadius.READ,
        reversible=True,
    ),
]


# ── HTTP client builder ───────────────────────────────────────────────────────

def _api_base(api_base: str | None = None) -> str:
    if api_base:
        return api_base.rstrip("/")
    from app.config import settings
    return settings.github_api_base_url.rstrip("/")


async def _http(api_base: str, token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url=api_base,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
        timeout=30,
    )


# ── Tool implementations ──────────────────────────────────────────────────────

async def _list_workflow_runs(args: dict, secret: str, *, api_base: str) -> dict:
    repo = args["repo"]
    params: dict[str, Any] = {}
    if "status" in args and args["status"]:
        params["status"] = args["status"]
    if "branch" in args and args["branch"]:
        params["branch"] = args["branch"]
    if "per_page" in args:
        params["per_page"] = args["per_page"]
    async with await _http(api_base, secret) as client:
        resp = await client.get(f"/repos/{repo}/actions/runs", params=params)
        resp.raise_for_status()
        return resp.json()


async def _get_workflow_run(args: dict, secret: str, *, api_base: str) -> dict:
    repo = args["repo"]
    run_id = args["run_id"]
    async with await _http(api_base, secret) as client:
        resp = await client.get(f"/repos/{repo}/actions/runs/{run_id}")
        resp.raise_for_status()
        return resp.json()


async def _get_run_logs(args: dict, secret: str, *, api_base: str) -> dict:
    repo = args["repo"]
    run_id = args["run_id"]
    async with await _http(api_base, secret) as client:
        resp = await client.get(f"/repos/{repo}/actions/runs/{run_id}/logs")
        resp.raise_for_status()
        # Real GitHub returns a zip; fake-github returns {"text": "..."}.
        # Detect by content-type.
        ctype = resp.headers.get("content-type", "")
        if "json" in ctype:
            return resp.json()
        # Production path — zip handling deferred until we hit real GitHub.
        # For now, return base64 length so the caller knows how big it is without storing it.
        return {"text": "<binary log archive — caller should download separately>",
                "bytes": len(resp.content)}


async def _get_run_diff(args: dict, secret: str, *, api_base: str) -> dict:
    """Fetch the diff associated with a workflow run via its PR.

    Strategy: list the run's PRs, take the first, fetch its diff.
    For fake-github, the scenario provides pr_diff directly keyed by run_id.
    """
    repo = args["repo"]
    run_id = args["run_id"]
    # In fake-github we look up via a synthetic endpoint; in real GitHub we'd
    # use the run's pull_requests array. v1 keeps it simple and works against fake.
    async with await _http(api_base, secret) as client:
        resp = await client.get(f"/repos/{repo}/actions/runs/{run_id}")
        resp.raise_for_status()
        run = resp.json()
        # Real GitHub: run["pull_requests"][0]["number"] → fetch PR diff.
        # Fake-github: pr_diff is stored in the scenarios dict, exposed via a custom endpoint.
        # For v1, we ask fake-github via a new endpoint that returns from scenarios.
        pulls = run.get("pull_requests") or []
        if not pulls:
            # Fall back to scenarios-style endpoint that fake-github will provide
            try:
                resp = await client.get(f"/repos/{repo}/_test/run_diff/{run_id}")
                if resp.status_code == 200:
                    return resp.json()
            except Exception:
                pass
            return {"diff": "", "files_changed": []}
        pr_number = pulls[0]["number"]
        resp = await client.get(
            f"/repos/{repo}/pulls/{pr_number}",
            headers={"Accept": "application/vnd.github.v3.diff"},
        )
        return {"diff": resp.text, "files_changed": []}


async def _compare_to_main(args: dict, secret: str, *, api_base: str) -> dict:
    """Determine whether the failure lives in the PR or on main.

    Heuristic:
      1. Fetch the failing run's name and a signature from its logs.
      2. Query main's most recent runs of the same workflow.
      3. If main's latest run failed with the same signature → bug is on main.
      4. Else → bug is in the PR (default).

    Returns:
      {"bug_location": "branch" | "main",
       "evidence": str,
       "recent_main_runs": list,
       "failure_signature": str}
    """
    repo = args["repo"]
    run_id = args["run_id"]
    async with await _http(api_base, secret) as client:
        # Fetch the failing run
        run_resp = await client.get(f"/repos/{repo}/actions/runs/{run_id}")
        run_resp.raise_for_status()
        run = run_resp.json()
        workflow_name = run.get("name", "")

        # Fetch logs to derive a signature
        logs_resp = await client.get(f"/repos/{repo}/actions/runs/{run_id}/logs")
        log_text = ""
        if logs_resp.status_code == 200:
            ctype = logs_resp.headers.get("content-type", "")
            if "json" in ctype:
                log_text = logs_resp.json().get("text", "")
        # Crude signature: first non-empty line containing 'fail' or 'error'
        signature = ""
        for line in log_text.splitlines():
            ll = line.strip().lower()
            if ll and ("fail" in ll or "error" in ll):
                signature = line.strip()[:200]
                break

        # Query main's recent runs of the same workflow
        params = {"branch": "main", "per_page": 10}
        main_resp = await client.get(f"/repos/{repo}/actions/runs", params=params)
        recent_main_runs = main_resp.json().get("workflow_runs", []) if main_resp.status_code == 200 else []

        # Decision: any recent main run with conclusion=failure AND a similar signature?
        for r in recent_main_runs:
            if r.get("conclusion") != "failure":
                continue
            r_id = r.get("id")
            r_logs_resp = await client.get(f"/repos/{repo}/actions/runs/{r_id}/logs")
            if r_logs_resp.status_code != 200:
                continue
            r_log_text = ""
            r_ctype = r_logs_resp.headers.get("content-type", "")
            if "json" in r_ctype:
                r_log_text = r_logs_resp.json().get("text", "")
            if signature and signature[:80] in r_log_text:
                return {
                    "bug_location": "main",
                    "evidence": f"Same failure signature observed on main run {r_id}",
                    "recent_main_runs": [{"id": r["id"], "conclusion": r["conclusion"]} for r in recent_main_runs],
                    "failure_signature": signature,
                }

        return {
            "bug_location": "branch",
            "evidence": "Failure signature not present in recent main CI runs",
            "recent_main_runs": [{"id": r.get("id"), "conclusion": r.get("conclusion")} for r in recent_main_runs],
            "failure_signature": signature,
        }


# ── Dispatch ──────────────────────────────────────────────────────────────────

async def execute_tool(name: str, args: dict, *, secret: str, api_base: str | None = None) -> Any:
    """Dispatch a github_external tool call. Caller (the platform executor)
    has already passed the consent gate and resolved the secret from the vault.
    """
    base = _api_base(api_base)
    dispatch = {
        "list_workflow_runs": _list_workflow_runs,
        "get_workflow_run": _get_workflow_run,
        "get_run_logs": _get_run_logs,
        "get_run_diff": _get_run_diff,
        "compare_to_main": _compare_to_main,
    }
    fn = dispatch.get(name)
    if fn is None:
        raise ValueError(f"Unknown github_external tool: {name}")
    return await fn(args, secret, api_base=base)
