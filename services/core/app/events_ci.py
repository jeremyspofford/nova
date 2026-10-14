"""S37c T7: GitHub CI is a sender, by polling (spec §2.7, owner §9 Q1).

Every 5 minutes the `github_ci` job (timers.JOBS) reads the latest completed
workflow runs of the repos the owner lists (setting events.github_ci.repos)
through GitHub's API, with the token the GitHub MCP server row already holds.
Nothing becomes public: the stack calls out, GitHub never calls in.

What files an event: for each (workflow, branch), its newest decisive run
(green = success, red = failure/timed_out/startup_failure; anything else is
passed over) is red, and the decisive run before it in the page was green, was
red on a different commit, or is not in the page. Red again on the same commit
files nothing. The decision reads GitHub's own run history; the KEY that stops
a run filing twice is the event row's fingerprint `github_ci:<repo>:<run_id>`,
checked against every row of the sender under a per-fingerprint lock — the
table, not memory, so a restart or two polls at once never file it again.

The job only files queued events; the scheduler's tick starts her turn on
them (events.start_queued).

The token is a secret. It leaves this module only as the Authorization header
of a request to api.github.com. Every reason this module states is scrubbed of
it, so it never reaches a log line, the job's result, the job span, a raised
reason or a payload.

Failures are stated, never a quiet pass: no repos listed, or the sender off,
is an ok firing whose result says nothing was polled (nothing is broken); a
missing GitHub row or token, a refused token (401), a rate limit, or any repo
that could not be read raises PollFailed, so the firing fails with the reason
— after the other repos were read and their events filed.
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime, timedelta

import asyncpg
import httpx

from app import settings_store
from app.mcp import servers

logger = logging.getLogger(__name__)

SENDER = "github_ci"
REPOS_KEY = "events.github_ci.repos"
MAX_REPOS = 20
# A red run older than this is history, not news: the first poll of a repo
# that has been red for a week does not file it.
LOOKBACK = timedelta(hours=24)
PER_PAGE = 50
API = "https://api.github.com"
API_VERSION = "2022-11-28"
# The GitHub MCP server's origin (the Settings > Connections preset's URL). The
# row at this origin is "the GitHub token already registered" (§9 Q1).
GITHUB_MCP_ORIGIN = "https://api.githubcopilot.com"
PREFERRED_NAME = "github"
JOB_SCHEDULE = {"kind": "minutes", "every": 5}
JOB_TITLE = "Read the listed repos' GitHub CI runs; a run that turns red files a github_ci event"
TIMEOUT_S = 20.0

GREEN = frozenset({"success"})
RED = frozenset({"failure", "timed_out", "startup_failure"})

# GitHub's owner and repo name rules, loosely: what an owner/repo can hold.
REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")
_SPLIT_RE = re.compile(r"[\s,]+")
_LOCK = "events-github-ci:"

# The transport every request goes through. None is the real network; tests
# plant a fake here or pass one to poll().
TRANSPORT: httpx.AsyncBaseTransport | None = None


class PollFailed(Exception):
    """The poll could not do all of its work: the message says what, scrubbed
    of the token."""


def _now() -> datetime:
    return datetime.now(UTC)


def parse_repos(value: str) -> list[str]:
    """The listed repos in order, each once. Raises ValueError naming the
    first entry that is not owner/repo, or the count over MAX_REPOS."""
    repos: list[str] = []
    for entry in _SPLIT_RE.split(value or ""):
        if not entry:
            continue
        if not REPO_RE.fullmatch(entry):
            raise ValueError(f"{entry!r} is not an owner/repo name")
        if entry not in repos:
            repos.append(entry)
    if len(repos) > MAX_REPOS:
        raise ValueError(f"{len(repos)} repos listed; at most {MAX_REPOS} owner/repo names")
    return repos


def repos_problem(value) -> str | None:
    """settings_store's validate hook for REPOS_KEY."""
    try:
        parse_repos(value)
    except ValueError as exc:
        return str(exc)
    return None


def _scrub(text: str, secret: str | None) -> str:
    if secret:
        text = text.replace(secret, "[token]")
    return text


async def _credential(pool: asyncpg.Pool) -> str:
    """The Authorization header value from the GitHub MCP server row, or
    PollFailed saying why there is none. Never logged."""
    rows = [s for s in await servers.list_servers(pool) if s.origin == GITHUB_MCP_ORIGIN]
    if not rows:
        raise PollFailed(
            f"no GitHub MCP server is connected (a server at {GITHUB_MCP_ORIGIN} on "
            "Settings > Connections), so there is no token to read CI with"
        )
    rows.sort(key=lambda s: (s.name != PREFERRED_NAME, s.name))
    for server in rows:
        if server.token:
            return f"Bearer {server.token}"
        for name, value in server.headers.items():
            if name.lower() == "authorization" and value:
                return value
    raise PollFailed(
        f"the GitHub MCP server {rows[0].name!r} holds no token (neither a token nor an "
        "Authorization header), so CI cannot be read"
    )


def _decisive(run: dict) -> str | None:
    conclusion = run.get("conclusion")
    if conclusion in GREEN:
        return "green"
    if conclusion in RED:
        return "red"
    return None


def _when(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _findings(repo: str, runs: list[dict], now: datetime) -> list[dict]:
    """The payloads to file for one repo's page of runs (newest first)."""
    groups: dict[tuple, list[dict]] = {}
    for run in runs:
        if _decisive(run) is None:
            continue
        groups.setdefault((run.get("workflow_id"), run.get("head_branch")), []).append(run)
    found = []
    for group in groups.values():
        group.sort(key=lambda r: (r.get("updated_at") or "", r.get("id") or 0), reverse=True)
        latest = group[0]
        if _decisive(latest) != "red":
            continue
        updated = _when(latest.get("updated_at"))
        if updated is None or now - updated > LOOKBACK:
            continue
        previous = group[1] if len(group) > 1 else None
        if previous is None:
            why = "it ended red and no earlier run of this workflow and branch is in the page"
        elif _decisive(previous) == "green":
            why = "it turned from green to red"
        elif previous.get("head_sha") != latest.get("head_sha"):
            why = "it ended red on a new commit"
        else:
            continue
        found.append(
            {
                "repo": repo,
                "workflow": latest.get("name"),
                "branch": latest.get("head_branch"),
                "head_sha": latest.get("head_sha"),
                "run_id": latest.get("id"),
                "run_attempt": latest.get("run_attempt"),
                "conclusion": latest.get("conclusion"),
                "url": latest.get("html_url"),
                "title": latest.get("display_title"),
                "event": latest.get("event"),
                "updated_at": latest.get("updated_at"),
                "why": why,
                "previous": None
                if previous is None
                else {
                    "run_id": previous.get("id"),
                    "conclusion": previous.get("conclusion"),
                    "head_sha": previous.get("head_sha"),
                },
            }
        )
    found.sort(key=lambda p: p["updated_at"] or "")
    return found


async def _file(pool: asyncpg.Pool, payload: dict) -> bool:
    """File one github_ci event unless its run was ever filed. True if filed."""
    fingerprint = f"{SENDER}:{payload['repo']}:{payload['run_id']}"
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("SELECT pg_advisory_xact_lock(hashtext($1))", _LOCK + fingerprint)
        if await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM events WHERE sender = $1 AND fingerprint = $2)",
            SENDER,
            fingerprint,
        ):
            return False
        event_id = await conn.fetchval(
            "INSERT INTO events (sender, payload, content_type, fingerprint) "
            "VALUES ($1, $2, 'application/json', $3) RETURNING id",
            SENDER,
            json.dumps(payload, sort_keys=True),
            fingerprint,
        )
        await conn.execute("UPDATE event_senders SET last_sent_at = now() WHERE name = $1", SENDER)
    logger.info(
        "github_ci event %s filed for %s run %s", event_id, payload["repo"], payload["run_id"]
    )
    return True


def _refusal(repo: str, response: httpx.Response) -> str:
    status = response.status_code
    if status == 401:
        return f"{repo}: GitHub refused the token (401) — it is wrong, expired or revoked"
    remaining = response.headers.get("x-ratelimit-remaining")
    if status == 429 or (status == 403 and remaining == "0"):
        reset = response.headers.get("x-ratelimit-reset")
        retry = response.headers.get("retry-after")
        if reset and reset.isdigit():
            until = datetime.fromtimestamp(int(reset), UTC).strftime("%Y-%m-%d %H:%M:%S UTC")
            return f"{repo}: GitHub rate-limited the token ({status}) until {until}"
        if retry:
            return f"{repo}: GitHub rate-limited the token ({status}); retry after {retry} s"
        return f"{repo}: GitHub rate-limited the token ({status})"
    try:
        message = str(response.json().get("message") or "")
    except Exception:  # noqa: BLE001 - the status alone is still the reason
        message = ""
    return f"{repo}: GitHub answered {status}" + (f" — {message[:200]}" if message else "")


async def _read(client: httpx.AsyncClient, repo: str) -> list[dict]:
    """One repo's latest completed runs, or PollFailed naming the repo."""
    try:
        response = await client.get(
            f"/repos/{repo}/actions/runs", params={"status": "completed", "per_page": PER_PAGE}
        )
    except httpx.HTTPError as exc:
        raise PollFailed(f"{repo}: GitHub could not be reached — {type(exc).__name__}: {exc}")
    if response.status_code != 200:
        raise PollFailed(_refusal(repo, response))
    try:
        runs = response.json()["workflow_runs"]
        if not isinstance(runs, list) or not all(isinstance(r, dict) for r in runs):
            raise TypeError("not a list of runs")
    except Exception as exc:  # noqa: BLE001 - stated for this repo
        raise PollFailed(f"{repo}: GitHub's answer has no workflow_runs list ({exc!r})"[:300])
    return runs


def _count(n: int) -> str:
    return f"{n} event{'' if n == 1 else 's'} filed"


async def poll(
    pool: asyncpg.Pool,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    now: datetime | None = None,
) -> str:
    """One pass: read every listed repo, file what turned red, and say what
    happened. Raises PollFailed (scrubbed) when any part could not run."""
    repos = parse_repos(await settings_store.read_value(pool, REPOS_KEY) or "")
    if not repos:
        return f"nothing polled: no repos are listed (setting {REPOS_KEY})"
    enabled = await pool.fetchval("SELECT enabled FROM event_senders WHERE name = $1", SENDER)
    if enabled is None:
        return f"nothing polled: there is no {SENDER} sender (it is seeded at startup)"
    if not enabled:
        return f"nothing polled: the {SENDER} sender is off (Settings > Events)"
    authorization = await _credential(pool)
    now = now or _now()
    filed: dict[str, int] = {}
    failures: list[str] = []
    async with httpx.AsyncClient(
        base_url=API,
        transport=transport or TRANSPORT,
        timeout=TIMEOUT_S,
        headers={
            "Authorization": authorization,
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "nova-core",
        },
    ) as client:
        for repo in repos:
            try:
                runs = await _read(client, repo)
            except PollFailed as exc:
                reason = _scrub(str(exc), authorization.split()[-1])
                reason = _scrub(reason, authorization)
                failures.append(reason)
                logger.warning("github_ci poll: %s", reason)
                continue
            filed[repo] = 0
            for payload in _findings(repo, runs, now):
                if await _file(pool, payload):
                    filed[repo] += 1
    total = sum(filed.values())
    read = ", ".join(f"{repo} ({_count(n)})" for repo, n in filed.items()) or "none"
    summary = f"{_count(total)}; repos read: {read}"
    if failures:
        raise PollFailed(f"{summary}; could not read: " + "; ".join(failures))
    return summary


async def github_ci(pool: asyncpg.Pool) -> str:
    """The timers.JOBS handler: one poll through the module's transport."""
    return await poll(pool, transport=TRANSPORT, now=_now())
