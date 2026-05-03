"""Native GitHub provider for arbitrary repos (READ + PROPOSE + MUTATE + SETUP tier).

Distinguished from app.tools.github_tools (Self-Modification, Nova's own repo).
See docs/designs/2026-05-01-nova-capability-platform-design.md §5.
"""
from __future__ import annotations
import asyncio
import json
import logging
import re
import secrets as _stdlib_secrets
import shutil
import tempfile
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

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
    ToolDefinition(
        name="diagnose_failure",
        description=(
            "Analyze a CI failure's logs and return a structured diagnosis: category, "
            "suspected files, root cause explanation, severity, and confidence score. "
            "Pure reasoning — no external mutation."
        ),
        parameters={
            "type": "object",
            "properties": {
                "logs": {"type": "string", "description": "Raw CI log text"},
                "context": {"type": "object", "description": "Optional repo/run context"},
            },
            "required": ["logs"],
        },
        blast_radius=BlastRadius.PROPOSE,
        reversible=True,
    ),
    ToolDefinition(
        name="draft_fix",
        description=(
            "Given a diagnosis and the relevant file content, draft a minimal patch as a "
            "set of unified diffs. Returns a ProposedPatch (in-memory, never committed). "
            "Pure reasoning — no external mutation."
        ),
        parameters={
            "type": "object",
            "properties": {
                "diagnosis": {
                    "type": "object",
                    "description": "The DiagnosisReport from diagnose_failure",
                },
                "file_contents": {
                    "type": "object",
                    "description": "{path: content} for the files implicated in the diagnosis",
                },
            },
            "required": ["diagnosis", "file_contents"],
        },
        blast_radius=BlastRadius.PROPOSE,
        reversible=True,
    ),
    ToolDefinition(
        name="open_fix_pr",
        description=(
            "Open a pull request with a patch fix on a third-party repo. "
            "Clones the repo locally, applies the patch, pushes to a new branch, "
            "and opens a PR. Reversible (PR can be closed)."
        ),
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "branch": {"type": "string", "description": "New branch name (e.g., 'nova-fix-ci/abc123')"},
                "base": {"type": "string", "description": "Branch to PR against (e.g., 'feature-x' or 'main')"},
                "patch": {
                    "type": "object",
                    "description": "ProposedPatch from draft_fix: {files: [{path, diff}], summary, confidence}",
                },
                "title": {"type": "string"},
                "body": {"type": "string", "description": "PR description (often the diagnosis)"},
            },
            "required": ["repo", "branch", "base", "patch", "title"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=True,
    ),
    ToolDefinition(
        name="comment_on_pr",
        description="POST a comment on a PR (or issue). Reversible — comments can be deleted.",
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "pr_number": {"type": "integer"},
                "body": {"type": "string"},
            },
            "required": ["repo", "pr_number", "body"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=True,
    ),
    # ── SETUP-tier tools (webhook self-bootstrap) ─────────────────────────────
    ToolDefinition(
        name="register_webhook",
        description=(
            "Create a webhook on a GitHub repo for workflow_run events. "
            "Generates a per-hook HMAC secret, stores it encrypted, and records the row. "
            "Setup-time MUTATE: called when the user adds a watched repo via the dashboard."
        ),
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "target_url": {
                    "type": "string",
                    "description": "Webhook receiver URL (orchestrator's /api/v1/webhooks/github)",
                },
                "credential_id": {
                    "type": "string",
                    "description": "UUID of the capability_credentials row whose tenant key encrypts the HMAC secret",
                },
                "events": {
                    "type": "array",
                    "items": {"type": "string"},
                    "default": ["workflow_run"],
                },
            },
            "required": ["repo", "target_url", "credential_id"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=True,
    ),
    ToolDefinition(
        name="unregister_webhook",
        description="Delete a webhook from GitHub and mark the github_webhooks row revoked.",
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "hook_id": {"type": "integer"},
            },
            "required": ["repo", "hook_id"],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=True,
    ),
    ToolDefinition(
        name="verify_webhook",
        description="Trigger a ping on an existing webhook to confirm reachability and update health.",
        parameters={
            "type": "object",
            "properties": {
                "repo": _REPO_FIELD,
                "hook_id": {"type": "integer"},
            },
            "required": ["repo", "hook_id"],
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


# ── LLM gateway helper ───────────────────────────────────────────────────────

async def _call_llm_gateway(prompt: str, *, tier: str = "mid", task_type: str | None = None) -> str:
    """Send a single-turn prompt to Nova's LLM gateway /complete endpoint.

    Uses the shared ``get_llm_client()`` singleton — same client the orchestrator
    already uses for agent turns — to avoid creating an extra connection pool.

    Args:
        prompt:    User-role message to send.
        tier:      Advisory tier hint — "best", "mid", or "cheap".
        task_type: RoutingTaskType string for outcome tracking.

    Returns:
        The assistant content string from the gateway response.
    """
    from app.clients import get_llm_client
    client = get_llm_client()
    payload: dict[str, Any] = {
        "messages": [{"role": "user", "content": prompt}],
        "tier": tier,
        "max_tokens": 2000,
    }
    if task_type:
        payload["task_type"] = task_type
    resp = await client.post("/complete", json=payload)
    resp.raise_for_status()
    body = resp.json()
    # CompleteResponse shape: {"content": "...", "model": "...", ...}
    if "content" in body:
        return body["content"]
    if "choices" in body:
        return body["choices"][0]["message"]["content"]
    if "text" in body:
        return body["text"]
    return str(body)[:2000]


def _extract_json(text: str) -> dict | None:
    """Extract the first JSON object from an LLM response string."""
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


# ── PROPOSE-tier implementations ──────────────────────────────────────────────

async def _diagnose_failure(args: dict, secret: str | None = None, *, api_base: str | None = None) -> dict:
    """Call LLM gateway to analyze CI logs. Returns DiagnosisReport.

    Output schema:
      {
        "category": "lint" | "type" | "test" | "build" | "dependency" | "infra" | "unknown",
        "suspected_files": list[str],
        "root_cause": str,
        "severity": "low" | "medium" | "high",
        "confidence": float,  # 0.0–1.0
      }
    """
    logs = args["logs"]
    context = args.get("context") or {}

    prompt = (
        "Analyze this CI failure log and return ONLY valid JSON with these keys:\n"
        '  - category: one of "lint", "type", "test", "build", "dependency", "infra", "unknown"\n'
        '  - suspected_files: list of file paths most likely to contain the bug\n'
        '  - root_cause: one-paragraph explanation of why CI failed\n'
        '  - severity: "low" | "medium" | "high"\n'
        '  - confidence: float between 0.0 and 1.0\n'
        "\n"
        "Do not include any prose outside the JSON object.\n"
        "\n"
        f"Repository context: {context}\n"
        "\n"
        "Logs (truncated to first 8000 chars):\n"
        f"{logs[:8000]}\n"
    )

    response_text = await _call_llm_gateway(prompt, tier="mid", task_type="extraction")
    parsed = _extract_json(response_text)
    if parsed is None:
        return {
            "category": "unknown",
            "suspected_files": [],
            "root_cause": "LLM returned non-JSON response: " + response_text[:300],
            "severity": "medium",
            "confidence": 0.0,
        }
    return parsed


async def _draft_fix(args: dict, secret: str | None = None, *, api_base: str | None = None) -> dict:
    """Generate a minimal unified-diff patch given a diagnosis and current file content.

    Output schema:
      {
        "files": [
          {"path": str, "diff": str},  # unified diff
        ],
        "summary": str,                 # one-line description of the fix
        "confidence": float,
      }
    """
    diagnosis = args["diagnosis"]
    file_contents = args.get("file_contents") or {}

    files_section = "\n\n".join(
        f"=== {path} ===\n{content[:4000]}"
        for path, content in file_contents.items()
    )

    prompt = (
        "Given this diagnosis and source files, produce a minimal patch.\n"
        "Return ONLY valid JSON with:\n"
        '  - files: list of {path: str, diff: str (unified diff format)}\n'
        '  - summary: one-line description of the fix\n'
        '  - confidence: float 0.0-1.0 (how confident the fix is correct)\n'
        "\n"
        "Constraints:\n"
        "  - Touch only files implicated by the diagnosis\n"
        "  - Make the smallest change that addresses the root_cause\n"
        "  - Don't refactor; don't add features; don't change tests unless they're broken\n"
        "  - Output unified diff format with proper @@ hunk headers\n"
        "\n"
        f"Diagnosis: {diagnosis}\n"
        "\n"
        "Source files:\n"
        f"{files_section}\n"
    )

    response_text = await _call_llm_gateway(prompt, tier="mid", task_type="code_review")
    parsed = _extract_json(response_text)
    if parsed is None:
        return {"files": [], "summary": "LLM returned non-JSON", "confidence": 0.0}
    return parsed



# ── MUTATE-tier implementations ───────────────────────────────────────────────

async def _comment_on_pr(args: dict, secret: str, *, api_base: str) -> dict:
    """POST to /repos/{owner}/{repo}/issues/{pr_number}/comments.
    GitHub treats PRs as issues for comments.
    """
    repo = args["repo"]
    pr_number = args["pr_number"]
    body = args["body"]
    async with await _http(api_base, secret) as client:
        resp = await client.post(
            f"/repos/{repo}/issues/{pr_number}/comments",
            json={"body": body},
        )
        resp.raise_for_status()
        data = resp.json()
        return {
            "comment_url": data.get("html_url"),
            "comment_id": data.get("id"),
        }


async def _open_fix_pr(args: dict, secret: str, *, api_base: str) -> dict:
    """Clone repo to /tmp, apply patch, push new branch via PAT-in-URL, open PR.

    For fake-github (localhost), skips the actual git clone/push and hits the
    PR-creation endpoint directly with the patch contents inline.

    SECURITY: the clone URL embedding the PAT is never logged. Stderr from git
    is passed through redact_value() before surfacing in any error message.
    The tmpdir is cleaned up in a finally block — never leaks.
    """
    git_host = _git_host_from_api_base(api_base)
    is_fake = (
        git_host.startswith("http://127.")
        or git_host.startswith("http://localhost")
        or "host.docker.internal" in git_host
    )

    if is_fake:
        return await _open_fix_pr_fake_github(args, secret, api_base=api_base)

    repo = args["repo"]
    branch = args["branch"]
    base = args["base"]
    patch = args["patch"]
    title = args["title"]
    body_text = args.get("body", "")

    workdir = Path(tempfile.mkdtemp(prefix="nova-fix-"))
    try:
        # Strip scheme from git_host to build the PAT-in-URL clone URL
        git_host_bare = re.sub(r"^https?://", "", git_host)
        clone_url = f"https://x-access-token:{secret}@{git_host_bare}/{repo}.git"

        # Clone (depth 10 to keep small while still allowing 3-way merge)
        await _run_git(workdir, ["git", "clone", "--depth", "10", clone_url, "."])
        await _run_git(workdir, ["git", "fetch", "origin", base])
        await _run_git(workdir, ["git", "checkout", base])
        await _run_git(workdir, ["git", "checkout", "-b", branch])

        # Apply each file's diff
        for file_patch in patch.get("files", []):
            diff_text = file_patch["diff"]
            patch_file = workdir / ".nova-patch"
            patch_file.write_text(diff_text)
            try:
                await _run_git(workdir, ["git", "apply", "--3way", str(patch_file)])
            except RuntimeError as e:
                logger.warning("git apply --3way failed, retrying without: %s", e)
                await _run_git(workdir, ["git", "apply", str(patch_file)])
            patch_file.unlink(missing_ok=True)

        await _run_git(workdir, ["git", "add", "-A"])
        summary = patch.get("summary", "CI fix")
        commit_msg = f"nova: {summary}\n\nCo-Authored-By: Nova <noreply@arialabs.ai>"
        await _run_git(workdir, ["git", "commit", "-m", commit_msg])
        await _run_git(workdir, ["git", "push", "-u", "origin", branch])

        # Open PR via API
        async with await _http(api_base, secret) as client:
            resp = await client.post(
                f"/repos/{repo}/pulls",
                json={"title": title, "body": body_text, "head": branch, "base": base},
            )
            resp.raise_for_status()
            data = resp.json()

        return {
            "pr_url": data.get("html_url"),
            "pr_number": data.get("number"),
            "branch_pushed": branch,
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


async def _open_fix_pr_fake_github(args: dict, secret: str, *, api_base: str) -> dict:
    """Test-mode: skip git clone/push; call fake-github's PR endpoint directly
    with the patch contents inline (_test_patch extension field)."""
    repo = args["repo"]
    branch = args["branch"]
    base = args["base"]
    patch = args["patch"]
    title = args["title"]
    body_text = args.get("body", "")

    async with await _http(api_base, secret) as client:
        resp = await client.post(
            f"/repos/{repo}/pulls",
            json={
                "title": title,
                "body": body_text,
                "head": branch,
                "base": base,
                "_test_patch": patch,
            },
        )
        resp.raise_for_status()
        data = resp.json()

    return {
        "pr_url": data.get("html_url", f"http://fake/{repo}/pulls/{data.get('number')}"),
        "pr_number": data.get("number"),
        "branch_pushed": branch,
    }


def _git_host_from_api_base(api_base: str) -> str:
    """Map api.github.com -> github.com; pass through fakes unchanged."""
    return api_base.replace("api.github.com", "github.com")


async def _run_git(cwd: Path, cmd: list[str]) -> None:
    """Run a git command via subprocess; raise RuntimeError on non-zero exit.

    SECURITY: argv is never logged (clone URL may contain a PAT).
    stderr is passed through redact_value() before surfacing in exceptions.
    Uses asyncio.create_subprocess_exec (no shell interpolation).
    """
    from app.capabilities.redactor import redact_value

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env={
            "GIT_TERMINAL_PROMPT": "0",  # never prompt for credentials
            "GIT_ASKPASS": "/bin/echo",
            "HOME": "/tmp",
            "PATH": "/usr/local/bin:/usr/bin:/bin",
        },
    )
    stdout, stderr = await proc.communicate()
    if proc.returncode != 0:
        raw = stderr.decode(errors="ignore") or stdout.decode(errors="ignore")
        safe_msg = redact_value(raw)
        raise RuntimeError(
            f"git {cmd[1] if len(cmd) > 1 else ''} failed "
            f"(exit {proc.returncode}): {safe_msg[:500]}"
        )


# ── SETUP-tier implementations (webhook self-bootstrap) ──────────────────────

# v1 single-tenant constant — mirrors DEFAULT_TENANT in capabilities/router.py
_DEFAULT_TENANT = UUID("00000000-0000-0000-0000-000000000001")


async def _register_webhook(args: dict, secret: str, *, api_base: str) -> dict:
    """Generate HMAC secret, call GitHub /repos/{repo}/hooks, persist to github_webhooks.

    The HMAC secret is encrypted using the same BuiltinCredentialProvider that
    protects PAT credentials — credential_id (tenant key) is used as the
    encryption context so the ciphertext is bound to the owning credential row.
    This is semantically appropriate: the webhook secret lives only as long as
    the credential that authorized its creation.
    """
    from app.capabilities import credentials as cred_db
    from app.db import get_pool

    repo = args["repo"]
    target_url = args["target_url"]
    credential_id = UUID(args["credential_id"])
    events = args.get("events") or ["workflow_run"]

    # Generate a fresh HMAC secret for this webhook
    hmac_secret = _stdlib_secrets.token_urlsafe(32)

    # Encrypt using the credential row's tenant key (credential_id doubles as
    # the tenant scoping key — the encrypted secret is useless without the
    # matching master key and this credential_id)
    encrypted = cred_db._encrypt(credential_id, hmac_secret)

    # Create the hook on GitHub (or fake-github in tests)
    async with await _http(api_base, secret) as client:
        resp = await client.post(
            f"/repos/{repo}/hooks",
            json={
                "name": "web",
                "active": True,
                "events": events,
                "config": {
                    "url": target_url,
                    "content_type": "json",
                    "secret": hmac_secret,
                    "insecure_ssl": "0",
                },
            },
        )
        resp.raise_for_status()
        gh_hook = resp.json()
        gh_hook_id = gh_hook["id"]

    # Persist the webhook row. Upsert on (tenant_id, repo) so a stale row
    # from a prior failed/orphaned registration doesn't block re-registration —
    # the new hook_id supersedes whatever was there.
    pool = get_pool()
    hook_row_id = uuid4()
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO github_webhooks
              (id, tenant_id, credential_id, repo, hook_id, target_url,
               encrypted_secret, events, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active')
            ON CONFLICT (tenant_id, repo) DO UPDATE SET
              credential_id    = EXCLUDED.credential_id,
              hook_id          = EXCLUDED.hook_id,
              target_url       = EXCLUDED.target_url,
              encrypted_secret = EXCLUDED.encrypted_secret,
              events           = EXCLUDED.events,
              status           = 'active',
              created_at       = now()
            """,
            hook_row_id,
            _DEFAULT_TENANT,
            credential_id,
            repo,
            gh_hook_id,
            target_url,
            encrypted,
            events,
        )

    logger.info("Registered webhook hook_id=%s for repo=%s", gh_hook_id, repo)
    return {
        "hook_id": gh_hook_id,
        "row_id": str(hook_row_id),
        "status": "active",
    }


async def _unregister_webhook(args: dict, secret: str, *, api_base: str) -> dict:
    """Delete the GitHub webhook and mark the db row revoked."""
    from app.db import get_pool

    repo = args["repo"]
    hook_id = args["hook_id"]

    async with await _http(api_base, secret) as client:
        resp = await client.delete(f"/repos/{repo}/hooks/{hook_id}")
        # 404 means already gone — still mark revoked
        if resp.status_code not in (204, 200, 404):
            resp.raise_for_status()

    pool = get_pool()
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE github_webhooks SET status='revoked' WHERE hook_id=$1 AND repo=$2",
            hook_id,
            repo,
        )

    updated = result.endswith(" 1")
    logger.info("Unregistered webhook hook_id=%s for repo=%s (row updated=%s)", hook_id, repo, updated)
    return {"hook_id": hook_id, "revoked": True, "db_row_updated": updated}


async def _verify_webhook(args: dict, secret: str, *, api_base: str) -> dict:
    """Trigger a ping on the GitHub webhook to confirm reachability."""
    from app.db import get_pool

    repo = args["repo"]
    hook_id = args["hook_id"]

    async with await _http(api_base, secret) as client:
        resp = await client.post(f"/repos/{repo}/hooks/{hook_id}/pings")
        resp.raise_for_status()

    pool = get_pool()
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE github_webhooks SET last_pinged_at=now() WHERE hook_id=$1 AND repo=$2",
            hook_id,
            repo,
        )

    return {"hook_id": hook_id, "pinged": True}


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
        "diagnose_failure": _diagnose_failure,
        "draft_fix": _draft_fix,
        "open_fix_pr": _open_fix_pr,
        "comment_on_pr": _comment_on_pr,
        # SETUP-tier
        "register_webhook": _register_webhook,
        "unregister_webhook": _unregister_webhook,
        "verify_webhook": _verify_webhook,
    }
    fn = dispatch.get(name)
    if fn is None:
        raise ValueError(f"Unknown github_external tool: {name}")
    return await fn(args, secret, api_base=base)
