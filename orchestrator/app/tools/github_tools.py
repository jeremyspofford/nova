"""
GitHub Tools — self-modification PR workflow for Nova agents.

Nova can create branches, push code changes, and open pull requests
against its own source repository.  All operations go through GitHub's
REST API or authenticated git subprocess calls — never direct pushes
to protected branches.

Security invariants:
  - The GitHub PAT is NEVER exposed in output, logs, or error messages.
  - Pushes to main/master/develop are hard-blocked.
  - Force-push is hard-blocked.
  - PR creation is rate-limited (sliding window per hour).
  - Self-modification must be explicitly enabled in Settings.

Tools provided:
  github_create_branch  — create a feature branch from origin/main
  github_push_branch    — push the current branch to GitHub
  github_create_pr      — open a pull request via GitHub API
  github_pr_status      — check PR CI status, reviews, mergeability
  github_list_prs       — list PRs Nova has created (from local DB)
  github_diff_branch    — show diff between current branch and main
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

import httpx
from nova_contracts import BlastRadius, ToolDefinition

log = logging.getLogger(__name__)

NOVA_SOURCE_ROOT = Path("/nova")

_PROTECTED_BRANCHES = frozenset({"main", "master", "develop"})

# ─── Tool definitions ─────────────────────────────────────────────────────────

GITHUB_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="github_create_branch",
        description=(
            "Create a new git branch from origin/main in Nova's own source repo. "
            "Use this before making code changes that you intend to submit as a PR."
        ),
        parameters={
            "type": "object",
            "properties": {
                "branch_name": {
                    "type": "string",
                    "description": "Name for the new branch (e.g. 'feat/improve-memory-retrieval')",
                },
            },
            "required": ["branch_name"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="github_push_branch",
        description=(
            "Push the current branch to Nova's GitHub remote. "
            "Requires a GitHub PAT to be configured. Cannot push to main/master/develop."
        ),
        parameters={
            "type": "object",
            "properties": {
                "branch_name": {
                    "type": "string",
                    "description": "Branch to push (default: current branch)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.MUTATE,
        reversible=False,
    ),
    ToolDefinition(
        name="github_create_pr",
        description=(
            "Create a pull request on GitHub for the current branch. "
            "PRs are created as drafts by default. Rate-limited to prevent runaway automation."
        ),
        parameters={
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "PR title (concise, under 72 chars)",
                },
                "body": {
                    "type": "string",
                    "description": "PR description with context on what changed and why",
                },
                "branch_name": {
                    "type": "string",
                    "description": "Source branch (default: current branch)",
                },
                "draft": {
                    "type": "boolean",
                    "description": "Create as draft PR (default: true)",
                },
            },
            "required": ["title"],
        },
        blast_radius=BlastRadius.MUTATE,
    ),
    ToolDefinition(
        name="github_pr_status",
        description=(
            "Check the status of a pull request — CI checks, reviews, and mergeability."
        ),
        parameters={
            "type": "object",
            "properties": {
                "pr_number": {
                    "type": "integer",
                    "description": "Pull request number to check",
                },
            },
            "required": ["pr_number"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="github_list_prs",
        description=(
            "List pull requests Nova has created, from the local tracking table."
        ),
        parameters={
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["open", "closed", "all"],
                    "description": "Filter by PR status (default: 'open')",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results to return (default: 10)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="github_diff_branch",
        description=(
            "Show the diff between the current branch and main in Nova's source repo. "
            "Useful for reviewing changes before creating a PR."
        ),
        parameters={
            "type": "object",
            "properties": {
                "branch_name": {
                    "type": "string",
                    "description": "Branch to diff against main (default: current branch)",
                },
            },
            "required": [],
        },
        blast_radius=BlastRadius.READ,
    ),
]


# ─── Pre-flight & rate limiting ──────────────────────────────────────────────

def _preflight() -> str | None:
    """Check selfmod is enabled and PAT is configured. Returns error message or None."""
    from app.config import settings

    if not settings.selfmod_enabled:
        return "Self-modification is disabled. Enable it in Settings > Security > Self-Modification."
    if not settings.nova_github_pat:
        return "No GitHub PAT configured. Set NOVA_GITHUB_PAT in Settings."
    return None


async def _check_rate_limit() -> str | None:
    """Returns error message if rate limit exceeded, None if OK."""
    from app.config import settings
    from app.store import get_redis

    window = int(time.time() / 3600)  # hourly window
    rkey = f"nova:selfmod:ratelimit:{window}"
    redis = get_redis()
    count = await redis.incr(rkey)
    if count == 1:
        await redis.expire(rkey, 7200)  # 2 hours TTL
    if count > settings.selfmod_rate_limit_per_hour:
        return f"Rate limit exceeded ({settings.selfmod_rate_limit_per_hour} PRs/hour)."
    return None


# ─── Helpers ─────────────────────────────────────────────────────────────────

def _redact_pat(text: str) -> str:
    """Strip the PAT from any string that might contain it."""
    from app.config import settings

    pat = settings.nova_github_pat
    if pat and pat in text:
        return text.replace(pat, "***")
    return text


def _repo_parts() -> tuple[str, str]:
    """Return (owner, repo) from settings.nova_github_repo ('owner/repo')."""
    from app.config import settings

    parts = settings.nova_github_repo.split("/", 1)
    if len(parts) != 2 or not all(parts):
        raise ValueError(
            "NOVA_GITHUB_REPO must be in 'owner/repo' format "
            f"(got '{settings.nova_github_repo}')"
        )
    return parts[0], parts[1]


async def _git_nova(args: list[str]) -> tuple[int, str, str]:
    """Run git command in /nova with Nova's configured user identity.

    Returns (returncode, stdout, stderr). PAT is redacted from all output.
    """
    from app.config import settings

    identity_args: list[str] = []
    if settings.nova_github_user:
        identity_args += ["-c", f"user.name={settings.nova_github_user}"]
    if settings.nova_github_email:
        identity_args += ["-c", f"user.email={settings.nova_github_email}"]

    full_args = identity_args + args

    proc = await asyncio.create_subprocess_exec(
        "git", *full_args,
        cwd=str(NOVA_SOURCE_ROOT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        return -1, "", "git command timed out after 30s"

    return (
        proc.returncode or 0,
        _redact_pat(stdout.decode(errors="replace").strip()),
        _redact_pat(stderr.decode(errors="replace").strip()),
    )


async def _github_api(
    method: str, path: str, json_body: dict | None = None,
) -> tuple[int, dict]:
    """Make authenticated GitHub API request. Returns (status_code, response_json)."""
    from app.config import settings

    headers = {
        "Authorization": f"Bearer {settings.nova_github_pat}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    url = f"https://api.github.com{path}"

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.request(method, url, headers=headers, json=json_body)
        try:
            body = resp.json()
        except Exception:
            body = {"raw": resp.text[:500]}
        return resp.status_code, body


async def _current_branch() -> str:
    """Get the current git branch name in /nova."""
    rc, out, err = await _git_nova(["rev-parse", "--abbrev-ref", "HEAD"])
    if rc != 0:
        raise RuntimeError(f"Failed to determine current branch: {err or out}")
    return out.strip()


# ─── Tool execution ─────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> str:
    log.info("Executing github tool: %s  args=%s", name, arguments)
    try:
        if name == "github_create_branch":
            return await _execute_create_branch(arguments["branch_name"])
        elif name == "github_push_branch":
            return await _execute_push_branch(arguments.get("branch_name"))
        elif name == "github_create_pr":
            return await _execute_create_pr(
                title=arguments["title"],
                body=arguments.get("body"),
                branch_name=arguments.get("branch_name"),
                draft=arguments.get("draft", True),
            )
        elif name == "github_pr_status":
            return await _execute_pr_status(arguments["pr_number"])
        elif name == "github_list_prs":
            return await _execute_list_prs(
                status=arguments.get("status", "open"),
                limit=arguments.get("limit", 10),
            )
        elif name == "github_diff_branch":
            return await _execute_diff_branch(arguments.get("branch_name"))
        else:
            return f"Unknown github tool '{name}'"
    except ValueError as e:
        return f"Error: {e}"
    except Exception as e:
        log.error("GitHub tool %s failed: %s", name, _redact_pat(str(e)), exc_info=True)
        return f"Tool '{name}' failed: {_redact_pat(str(e))}"


# ─── Individual tool implementations ────────────────────────────────────────

async def _execute_create_branch(branch_name: str) -> str:
    err = _preflight()
    if err:
        return err

    branch_name = branch_name.strip()
    if not branch_name:
        return "Error: branch name cannot be empty."
    if branch_name in _PROTECTED_BRANCHES:
        return f"Error: cannot create a branch named '{branch_name}' — protected branch."

    # Fetch latest main
    rc, out, stderr = await _git_nova(["fetch", "origin", "main"])
    if rc != 0:
        return f"git fetch failed (exit {rc}):\n{stderr or out}"

    # Create and switch to the new branch
    rc, out, stderr = await _git_nova(["checkout", "-b", branch_name, "origin/main"])
    if rc != 0:
        return f"git checkout -b failed (exit {rc}):\n{stderr or out}"

    return f"Created and switched to branch '{branch_name}' from origin/main."


async def _execute_push_branch(branch_name: str | None) -> str:
    err = _preflight()
    if err:
        return err

    from app.config import settings

    if branch_name:
        branch_name = branch_name.strip()
    else:
        branch_name = await _current_branch()

    # Hard block: protected branches
    if branch_name in _PROTECTED_BRANCHES:
        return f"Error: pushing to '{branch_name}' is blocked. Create a feature branch instead."

    owner, repo = _repo_parts()
    pat = settings.nova_github_pat
    push_url = f"https://x-access-token:{pat}@github.com/{owner}/{repo}.git"

    # Push using the authenticated URL — never log it
    rc, out, stderr = await _git_nova(["push", "-u", push_url, branch_name])
    if rc != 0:
        return f"git push failed (exit {rc}):\n{_redact_pat(stderr or out)}"

    return f"Pushed branch '{branch_name}' to origin."


async def _execute_create_pr(
    title: str,
    body: str | None,
    branch_name: str | None,
    draft: bool,
) -> str:
    err = _preflight()
    if err:
        return err

    # Rate limit
    rl_err = await _check_rate_limit()
    if rl_err:
        return rl_err

    if branch_name:
        branch_name = branch_name.strip()
    else:
        branch_name = await _current_branch()

    if branch_name in _PROTECTED_BRANCHES:
        return f"Error: cannot create a PR from '{branch_name}' — that's a base branch, not a feature branch."

    owner, repo = _repo_parts()

    payload: dict = {
        "title": title,
        "head": branch_name,
        "base": "main",
        "draft": draft,
    }
    if body:
        payload["body"] = body

    status, resp = await _github_api(
        "POST", f"/repos/{owner}/{repo}/pulls", json_body=payload,
    )

    if status == 201:
        pr_number = resp.get("number")
        pr_url = resp.get("html_url", "")

        # Record in local DB for tracking
        try:
            from app.db import get_pool

            pool = get_pool()
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO selfmod_prs (pr_number, branch, title, status, url, created_at)
                    VALUES ($1, $2, $3, 'open', $4, NOW())
                    ON CONFLICT (pr_number) DO UPDATE SET
                        title = EXCLUDED.title,
                        branch = EXCLUDED.branch,
                        url = EXCLUDED.url
                    """,
                    pr_number, branch_name, title, pr_url,
                )
        except Exception as e:
            log.warning("Failed to record PR #%s in selfmod_prs: %s", pr_number, e)

        draft_label = " (draft)" if draft else ""
        return f"PR #{pr_number}{draft_label} created: {pr_url}"

    # Error response
    msg = resp.get("message", str(resp))
    errors = resp.get("errors", [])
    detail = f" — {errors[0].get('message', '')}" if errors else ""
    return f"GitHub API error (HTTP {status}): {msg}{detail}"


async def _execute_pr_status(pr_number: int) -> str:
    err = _preflight()
    if err:
        return err

    owner, repo = _repo_parts()

    # Fetch PR details
    status, pr = await _github_api("GET", f"/repos/{owner}/{repo}/pulls/{pr_number}")
    if status != 200:
        return f"Failed to fetch PR #{pr_number} (HTTP {status}): {pr.get('message', '')}"

    # Fetch check runs for the head commit
    head_sha = pr.get("head", {}).get("sha", "")
    checks_summary = "unknown"
    check_details: list[str] = []

    if head_sha:
        cs, checks = await _github_api(
            "GET", f"/repos/{owner}/{repo}/commits/{head_sha}/check-runs",
        )
        if cs == 200:
            runs = checks.get("check_runs", [])
            if not runs:
                checks_summary = "no checks configured"
            else:
                statuses: dict[str, int] = {}
                for run in runs:
                    conclusion = run.get("conclusion") or run.get("status", "pending")
                    statuses[conclusion] = statuses.get(conclusion, 0) + 1
                    check_details.append(f"  {run['name']}: {conclusion}")

                if all(c == "success" for c in statuses):
                    checks_summary = "all passing"
                elif "failure" in statuses:
                    checks_summary = f"{statuses.get('failure', 0)} failing"
                elif "pending" in statuses or "in_progress" in statuses:
                    checks_summary = "in progress"
                else:
                    checks_summary = ", ".join(f"{k}={v}" for k, v in statuses.items())

    # Build response
    mergeable = pr.get("mergeable")
    mergeable_str = {True: "yes", False: "no (conflicts)", None: "checking..."}.get(
        mergeable, "unknown"
    )

    reviews_url = f"/repos/{owner}/{repo}/pulls/{pr_number}/reviews"
    _, reviews_resp = await _github_api("GET", reviews_url)
    review_states: dict[str, int] = {}
    if isinstance(reviews_resp, list):
        for rev in reviews_resp:
            state = rev.get("state", "PENDING")
            review_states[state] = review_states.get(state, 0) + 1
    review_summary = ", ".join(f"{k}={v}" for k, v in review_states.items()) if review_states else "none"

    lines = [
        f"PR #{pr_number}: {pr.get('title', '')}",
        f"  State: {pr.get('state', 'unknown')}" + (" (draft)" if pr.get("draft") else ""),
        f"  Branch: {pr.get('head', {}).get('ref', '?')} -> {pr.get('base', {}).get('ref', '?')}",
        f"  Mergeable: {mergeable_str}",
        f"  Checks: {checks_summary}",
        f"  Reviews: {review_summary}",
    ]
    if check_details:
        lines.append("  Check details:")
        lines.extend(check_details)

    return "\n".join(lines)


async def _execute_list_prs(status: str, limit: int) -> str:
    err = _preflight()
    if err:
        return err

    limit = max(1, min(limit, 50))
    if status not in ("open", "closed", "all"):
        status = "open"

    try:
        from app.db import get_pool

        pool = get_pool()
        async with pool.acquire() as conn:
            if status == "all":
                rows = await conn.fetch(
                    """
                    SELECT pr_number, branch, title, status, url, created_at
                    FROM selfmod_prs
                    ORDER BY created_at DESC
                    LIMIT $1
                    """,
                    limit,
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT pr_number, branch, title, status, url, created_at
                    FROM selfmod_prs
                    WHERE status = $1
                    ORDER BY created_at DESC
                    LIMIT $2
                    """,
                    status, limit,
                )
    except Exception as e:
        log.warning("Failed to query selfmod_prs: %s", e)
        return f"Error reading PR history: {e}"

    if not rows:
        return f"No {status} PRs found."

    lines = [f"{status.capitalize()} PRs ({len(rows)}):"]
    for r in rows:
        created = r["created_at"].strftime("%Y-%m-%d") if r["created_at"] else "?"
        lines.append(
            f"  #{r['pr_number']}  {r['title']}  [{r['status']}]  "
            f"{r['branch']}  {created}"
        )
        if r["url"]:
            lines.append(f"    {r['url']}")

    return "\n".join(lines)


async def _execute_diff_branch(branch_name: str | None) -> str:
    err = _preflight()
    if err:
        return err

    if branch_name:
        branch_name = branch_name.strip()
    else:
        branch_name = await _current_branch()

    rc, out, stderr = await _git_nova(
        ["diff", "--stat", "--patch", "--unified=3", f"main...{branch_name}"],
    )
    if rc != 0:
        return f"git diff failed (exit {rc}):\n{stderr or out}"

    if not out:
        return f"No differences between main and {branch_name}."

    # Truncate very large diffs (same limit as git_tools.py)
    MAX_CHARS = 6000
    if len(out) > MAX_CHARS:
        out = out[:MAX_CHARS] + f"\n\n[... diff truncated at {MAX_CHARS} chars ...]"
    return out
