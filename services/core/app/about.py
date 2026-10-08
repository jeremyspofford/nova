"""What this instance of Nova is, read live: the About page and `nova_about`.

Asked about her own architecture, she named the hub and the Dell and never the
phone he was holding — the installed web app (the PWA) was a session row that
recorded nothing about where it was. And nothing anywhere said which build was
running: the owner could not tell which commit the hub had been brought up
from, or whether there was anything newer to pull.

So this module answers four questions, every one from live state and never
from a list someone keeps:

  * **which build** — the commit ./install brought this stack up from
    (record_build writes it to .env, compose hands it to core). A stack that
    predates the stamp says so; it never borrows a version from anywhere else.
  * **what it runs on** — the hub (this host, its tailnet address, its own
    agent), the other machines running Nova's agent, the machines that run
    models (the gateway's reading), and the services beside core.
  * **who uses it from where** — each signed-in client: the installed app or a
    browser tab, on what device, last seen when (identity.touch_session).
  * **is there anything newer** — GitHub's comparison of that commit with the
    repository's default branch. A reading, cached ten minutes and dated; when
    it cannot be read the reason is the answer, never "up to date".

Nothing here decides anything. It is one read, shaped once (`about`) and
rendered twice: JSON for the page, words for her (`render`).
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from datetime import UTC, datetime
from typing import Any

import httpx

from app import (
    agent_dist,
    db,
    device_facts,
    devices_ws,
    machines,
    model_machines,
    network,
    peers,
)

logger = logging.getLogger("core")

# -- the build -----------------------------------------------------------

COMMIT_ENV = "NOVA_COMMIT"
VERSION_ENV = "NOVA_VERSION"
COMMIT_DATE_ENV = "NOVA_COMMIT_DATE"
INSTALLED_AT_ENV = "NOVA_INSTALLED_AT"
DIRTY_ENV = "NOVA_DIRTY"
REPO_ENV = "NOVA_REPO"
REPO_BRANCH_ENV = "NOVA_REPO_BRANCH"

_COMMIT_SHAPE = re.compile(r"[0-9a-f]{40}")
# What `git describe --tags --always --dirty` can print: a tag, a distance and
# an abbreviated hash, or the hash alone. Anything else is not shown.
_VERSION_SHAPE = re.compile(r"[A-Za-z0-9._+/-]{1,100}")
_REPO_SHAPE = re.compile(r"[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}")
_BRANCH_SHAPE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}")
SHORT = 7

NOT_STAMPED = (
    "this stack carries no build stamp — it was brought up before ./install "
    "recorded one; re-running ./install records it"
)


def _iso(value: str) -> str | None:
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(UTC).isoformat()


def build_info() -> dict[str, Any]:
    """The build this core was brought up from, read from its environment
    every call. A value of the wrong shape is dropped and logged, never shown:
    a version that might not be the version is worse than none."""
    env = os.environ
    raw_commit = env.get(COMMIT_ENV, "").strip().lower()
    commit = raw_commit if _COMMIT_SHAPE.fullmatch(raw_commit) else None
    if raw_commit and commit is None:
        logger.warning("%s=%r is not a 40-character commit hash; not shown", COMMIT_ENV, raw_commit)
    version = env.get(VERSION_ENV, "").strip()
    if version and not _VERSION_SHAPE.fullmatch(version):
        logger.warning("%s=%r is not a git describe; not shown", VERSION_ENV, version)
        version = ""
    repo = env.get(REPO_ENV, "").strip()
    if repo and (not _REPO_SHAPE.fullmatch(repo) or repo.split("/", 1)[1] in (".", "..")):
        repo = ""
    branch = env.get(REPO_BRANCH_ENV, "").strip()
    if branch and (not _BRANCH_SHAPE.fullmatch(branch) or ".." in branch):
        branch = ""
    dirty_raw = env.get(DIRTY_ENV, "").strip()
    dirty = {"1": True, "0": False}.get(dirty_raw)
    return {
        "commit": commit,
        "short": commit[:SHORT] if commit else None,
        "version": version or None,
        "committed_at": _iso(env.get(COMMIT_DATE_ENV, "")),
        "installed_at": _iso(env.get(INSTALLED_AT_ENV, "")),
        "dirty": dirty if commit else None,
        "repo": repo or None,
        "branch": branch or None,
        "commit_url": f"https://github.com/{repo}/commit/{commit}" if repo and commit else None,
        "reason": None if commit else NOT_STAMPED,
    }


# -- is there anything newer ----------------------------------------------

GITHUB_API = "https://api.github.com"
UPDATES_TTL_S = 600.0
# A forced re-check is still not a request per click: GitHub allows 60 an hour
# from one address, unauthenticated, and the owner has more than one tab.
REFRESH_FLOOR_S = 30.0
UPDATES_TIMEOUT = httpx.Timeout(10.0)
LISTED_COMMITS = 20
_updates_cache: dict[tuple[str, str, str], tuple[float, dict]] = {}
_updates_lock = asyncio.Lock()


def _commit_line(entry: dict) -> dict | None:
    sha = entry.get("sha")
    commit = entry.get("commit")
    if not isinstance(sha, str) or not _COMMIT_SHAPE.fullmatch(sha) or not isinstance(commit, dict):
        return None
    message = commit.get("message")
    first = (
        message.strip().splitlines()[0][:200]
        if isinstance(message, str) and message.strip()
        else ""
    )
    author = commit.get("author") if isinstance(commit.get("author"), dict) else {}
    date = author.get("date") if isinstance(author.get("date"), str) else ""
    return {
        "sha": sha,
        "short": sha[:SHORT],
        "message": first,
        "date": _iso(date) if date else None,
    }


def _unknown(reason: str, now: datetime) -> dict:
    return {
        "state": "unknown",
        "behind_by": None,
        "ahead_by": None,
        "commits": [],
        "latest": None,
        "compare_url": None,
        "reason": reason,
        "checked_at": now.isoformat(),
    }


async def _compare(app, repo: str, branch: str, commit: str) -> dict:
    """GitHub's comparison of the running commit with the branch's head."""
    now = datetime.now(UTC)
    url = f"{GITHUB_API}/repos/{repo}/compare/{commit}...{branch}"
    transport = getattr(getattr(app, "state", None), "github_transport", None)
    try:
        async with httpx.AsyncClient(
            timeout=UPDATES_TIMEOUT,
            transport=transport,
            headers={
                "Accept": "application/vnd.github+json",
                "User-Agent": "nova-about",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        ) as client:
            # No per_page: unpaginated, GitHub lists up to 250 commits, and a
            # paginated first page would be the OLDEST ones.
            response = await client.get(url)
    except httpx.HTTPError as exc:
        return _unknown(f"GitHub could not be reached: {peers.reason(exc)}", now)
    if response.status_code == 404:
        return _unknown(
            f"GitHub does not know commit {commit[:SHORT]} on {repo}, or branch {branch} — "
            "a commit that was never pushed cannot be compared",
            now,
        )
    if response.status_code in (403, 429):
        return _unknown(
            f"GitHub refused the check ({response.status_code}) — most likely its hourly limit "
            "for unauthenticated reads; it is tried again in ten minutes",
            now,
        )
    if response.status_code != 200:
        return _unknown(f"GitHub answered {response.status_code} to the comparison", now)
    try:
        data = response.json()
    except ValueError:
        return _unknown("GitHub's comparison was not JSON", now)
    status = data.get("status") if isinstance(data, dict) else None
    ahead = data.get("ahead_by")
    behind = data.get("behind_by")
    if (
        status not in ("identical", "ahead", "behind", "diverged")
        or not isinstance(ahead, int)
        or not isinstance(behind, int)
    ):
        return _unknown("GitHub's comparison did not say how the two commits relate", now)
    raw = data.get("commits") if isinstance(data.get("commits"), list) else []
    listed = [line for line in (_commit_line(c) for c in raw if isinstance(c, dict)) if line]
    # GitHub lists oldest first and stops at 250. Newest first reads as
    # "what's new" — but only a complete list has its newest commit in it.
    complete = len(listed) == ahead
    listed.reverse()
    # In GitHub's words the BRANCH is ahead of the running commit when there is
    # something to pull, so its ahead_by is what this instance is behind by.
    state = {
        "identical": "up_to_date",
        "ahead": "available",
        "behind": "local_ahead",
        "diverged": "diverged",
    }[status]
    return {
        "state": state,
        "behind_by": ahead,
        "ahead_by": behind,
        "commits": listed[:LISTED_COMMITS] if complete else [],
        "latest": listed[0] if listed and complete else None,
        "compare_url": data.get("html_url") if isinstance(data.get("html_url"), str) else None,
        "reason": None,
        "checked_at": now.isoformat(),
    }


async def check_updates(app, build: dict | None = None, *, refresh: bool = False) -> dict:
    """Whether GitHub's default branch has commits this build lacks.

    Cached UPDATES_TTL_S per (repo, branch, commit); `refresh` re-reads unless
    the last read is younger than REFRESH_FLOOR_S. A failed read is not cached
    as long: it is retried after the floor, never remembered as an answer."""
    build = build or build_info()
    now = datetime.now(UTC)
    if not build["commit"]:
        return _unknown(build["reason"] or NOT_STAMPED, now)
    if not build["repo"]:
        return _unknown(
            "this instance does not know which GitHub repository is its source "
            "(NOVA_REPO is unset — ./install writes it from the checkout's origin)",
            now,
        )
    if not build["branch"]:
        return _unknown(
            f"this instance does not know {build['repo']}'s default branch "
            "(NOVA_REPO_BRANCH is unset)",
            now,
        )
    key = (build["repo"], build["branch"], build["commit"])
    async with _updates_lock:
        cached = _updates_cache.get(key)
        age = time.monotonic() - cached[0] if cached else None
        ttl = UPDATES_TTL_S if cached and cached[1]["state"] != "unknown" else REFRESH_FLOOR_S
        if cached and age is not None and (age < REFRESH_FLOOR_S or (not refresh and age < ttl)):
            return cached[1]
        result = await _compare(app, *key)
        _updates_cache[key] = (time.monotonic(), result)
        return result


# -- what it runs on, and who uses it from where ---------------------------

SERVICE_TIMEOUT = httpx.Timeout(3.0)
CLIENT_WINDOW_DAYS = 30


async def _service(app, name: str, link: peers.Link) -> dict:
    try:
        async with peers.client(app, link, SERVICE_TIMEOUT) as client:
            response = await client.get("/health/live")
    except Exception as exc:
        return {"name": name, "state": "unreachable", "reason": peers.reason(exc)}
    if response.status_code != 200:
        return {"name": name, "state": "unhealthy", "reason": f"answered {response.status_code}"}
    return {"name": name, "state": "up", "reason": None}


def _device(row, facts_sink: list[dict] | None = None) -> dict:
    """One agent as the page shows it. Its connectivity is a live read of the
    hub's sockets, so a turn that reads it records {device, connected} on its
    facts_sink — the shape tools/devices._require_connected writes — and the
    state guard sees she checked when she quotes it."""
    facts = row["facts"]
    connected = devices_ws.hub.is_connected(row["id"])
    if facts_sink is not None:
        facts_sink.append({"device": row["name"], "connected": connected})
    return {
        "name": row["name"],
        "hostname": row["hostname"],
        "platform": row["platform"],
        "os": device_facts.os_label(facts),
        "connected": connected,
        "last_seen": row["last_seen"].isoformat() if row["last_seen"] else None,
        "agent_version": device_facts.agent_version(facts),
    }


_UA_DEVICES = (
    ("iPhone", "iPhone"),
    ("iPad", "iPad"),
    ("Android", "Android"),
    ("CrOS", "ChromeOS"),
    ("Macintosh", "Mac"),
    ("Windows", "Windows"),
    ("Linux", "Linux"),
)
_UA_BROWSERS = (
    ("Edg", "Edge"),
    ("OPR", "Opera"),
    ("FxiOS", "Firefox"),
    ("Firefox", "Firefox"),
    ("CriOS", "Chrome"),
    ("Chrome", "Chrome"),
    ("Safari", "Safari"),
)


def describe_client(user_agent: str | None, display: str | None) -> dict:
    """What a client is, in words, from what its own requests said. A device or
    browser the User-Agent does not name is None, never a guess."""
    ua = user_agent or ""
    device = next((label for token, label in _UA_DEVICES if token in ua), None)
    browser = next((label for token, label in _UA_BROWSERS if token in ua), None)
    if display == "standalone":
        kind = "installed app"
    elif display == "browser":
        kind = "browser"
    else:
        kind = None
    if kind == "installed app":
        label = f"Installed app (PWA) on {device or 'an unnamed device'}"
    elif browser or device:
        label = f"{browser or 'A browser'} on {device or 'an unnamed device'}"
    else:
        label = "An unrecognised client"
    return {"kind": kind, "device": device, "browser": browser, "label": label}


async def clients(pool) -> dict:
    """Every client used in the last CLIENT_WINDOW_DAYS, newest first, and how
    many live sessions have not been seen since clients were recorded."""
    # One row per client, not per sign-in: signing in again from the same
    # browser leaves the old session alive (its cookie is simply gone), and two
    # cards for one phone would describe a second phone that does not exist.
    # A client is the same person, User-Agent and display; its newest session
    # speaks for it.
    rows = await pool.fetch(
        "SELECT * FROM ("
        "  SELECT DISTINCT ON (s.person_id, s.user_agent, s.display) "
        "    p.name AS person, s.user_agent, s.display, s.last_seen_at, s.created_at "
        "  FROM sessions s JOIN people p ON p.id = s.person_id "
        "  WHERE s.expires_at > now() AND s.last_seen_at > now() - make_interval(days => $1) "
        "  ORDER BY s.person_id, s.user_agent, s.display, s.last_seen_at DESC"
        ") clients ORDER BY last_seen_at DESC",
        CLIENT_WINDOW_DAYS,
    )
    unseen = await pool.fetchval(
        "SELECT count(*) FROM sessions WHERE expires_at > now() AND last_seen_at IS NULL"
    )
    return {
        "clients": [
            {
                **describe_client(row["user_agent"], row["display"]),
                "person": row["person"],
                "last_seen": row["last_seen_at"].isoformat(),
                "signed_in_at": row["created_at"].isoformat(),
            }
            for row in rows
        ],
        "unseen": int(unseen or 0),
        "window_days": CLIENT_WINDOW_DAYS,
    }


def _place_remotes(remotes: list[dict], rows, facts_sink: list[dict] | None) -> list[dict]:
    """Each remote model machine as the page shows it, placed on the paired
    device it runs on. The agents are identity only — built from the device
    rows topology already read, never a connectivity read — and the tailnet
    peers. A turn's facts_sink gets machine_status's own remote fact for each:
    the gateway's last verdict, never "answering" unless state_of said so."""
    agents = [
        {
            "name": row["name"],
            "hostname": row["hostname"],
            "platform": row["platform"],
            "addresses": device_facts.addresses_of(row["facts"]),
        }
        for row in rows
    ]
    tailnet = network.tailnet_peers()
    at = datetime.now(UTC).isoformat()
    shown = []
    for remote in remotes:
        placed = model_machines.place(remote["base_url"], agents, None, tailnet)
        state = remote["state"]
        shown.append(
            {
                "name": remote["name"],
                "host": remote["host"],
                "state": state["state"],
                "reason": state["reason"],
                "walled_for_s": state["walled_for_s"],
                "answering": state["answering"],
                "models": remote["models"],
                "device": placed["device"],
                "device_said": placed["said"],
            }
        )
        if facts_sink is not None:
            facts_sink.append(model_machines.fact_of(remote, placed["device"], at))
    return shown


async def topology(app, facts_sink: list[dict] | None = None) -> dict:
    """The hub, the other agents, the model machines and the services."""
    pool = await db.get_pool()
    address = network.address()
    rows = await pool.fetch(
        "SELECT id, name, platform, hostname, facts, last_seen, last_transport FROM devices "
        "WHERE revoked_at IS NULL ORDER BY name"
    )
    hub_version = await agent_dist.version()

    async def engine_machines() -> dict:
        try:
            views = await machines.plant().engines(app, live=False)
        except machines.PlantUnavailable as exc:
            return {"machines": None, "reason": str(exc)}
        return {
            "machines": [
                {
                    "name": view["name"],
                    "state": view.get("state"),
                    "serving": view.get("serving"),
                    "runtime": view.get("runtime"),
                    "compute": view.get("compute"),
                    "models": len(view["tags"]) if isinstance(view.get("tags"), dict) else None,
                    "reason": view.get("reason"),
                }
                for view in views
            ],
            "reason": None,
        }

    async def remote_machines() -> tuple[list[dict] | None, str | None]:
        # The same selection machine_status makes (tools/machines._remotes):
        # the gateway's providers and live walls, through remotes_of.
        try:
            providers, walls = await machines.plant().model_providers(app)
        except machines.PlantUnavailable as exc:
            return None, str(exc)
        return model_machines.remotes_of(providers, walls, datetime.now(UTC)), None

    engines, (remotes, remotes_reason), gateway, memory = await asyncio.gather(
        engine_machines(),
        remote_machines(),
        _service(app, "gateway", peers.GATEWAY),
        _service(app, "memory", peers.MEMORY),
    )
    # The hub's own agent is the one whose socket came through the host's own
    # door (S42b P15) — the same fact devices.device_spec calls `hub`.
    hub_agents, satellites = [], []
    for row in rows:
        agent = _device(row, facts_sink)
        agent["build_state"] = device_facts.build_state(agent["agent_version"], hub_version)[
            "state"
        ]
        (hub_agents if row["last_transport"] == "host" else satellites).append(agent)
    engines["remotes"] = None if remotes is None else _place_remotes(remotes, rows, facts_sink)
    engines["remotes_reason"] = remotes_reason
    return {
        "hub": {
            "address": address.origin,
            "address_reason": address.reason,
            "agent": hub_agents[0] if hub_agents else None,
        },
        "satellites": satellites,
        "model_machines": engines,
        "services": [{"name": "core", "state": "up", "reason": None}, gateway, memory],
    }


async def about(app, *, refresh: bool = False, facts_sink: list[dict] | None = None) -> dict:
    # Function-local: nova_updates reads this module's build and check.
    from app import nova_updates

    build = build_info()
    pool = await db.get_pool()
    top, updates, seen, last = await asyncio.gather(
        topology(app, facts_sink),
        check_updates(app, build, refresh=refresh),
        clients(pool),
        nova_updates.latest(pool),
    )
    return {"build": build, "updates": updates, "last_update": last, **top, "clients": seen}


# -- in words, for her ------------------------------------------------------


def _ago(iso: str | None, now: datetime) -> str:
    if not iso:
        return "never"
    seconds = max(0, int((now - datetime.fromisoformat(iso)).total_seconds()))
    if seconds < 120:
        return "just now"
    if seconds < 7200:
        return f"{seconds // 60} minutes ago"
    if seconds < 172800:
        return f"{seconds // 3600} hours ago"
    return f"{seconds // 86400} days ago"


def render(data: dict, now: datetime | None = None) -> str:
    """The same read as the page, as lines she can quote."""
    now = now or datetime.now(UTC)
    b = data["build"]
    lines = ["BUILD"]
    if b["commit"]:
        dirty = " plus uncommitted changes" if b["dirty"] else ""
        version = f" ({b['version']})" if b["version"] else ""
        lines.append(f"  running commit {b['short']}{version}{dirty}")
        if b["committed_at"]:
            lines.append(f"  committed {b['committed_at']}")
        if b["installed_at"]:
            lines.append(f"  brought up by ./install at {b['installed_at']}")
    else:
        lines.append(f"  unknown: {b['reason']}")
    if b["repo"]:
        lines.append(f"  source: {b['repo']}" + (f", branch {b['branch']}" if b["branch"] else ""))

    u = data["updates"]
    lines.append(f"UPDATES (checked {u['checked_at']})")
    if u["state"] == "up_to_date":
        lines.append(f"  up to date with {b['branch']}")
    elif u["state"] == "available":
        head = f"  {u['behind_by']} new commit(s) on {b['branch']} not running here"
        if not u["commits"]:
            lines.append(f"{head}; too many for GitHub to list — see {u['compare_url']}")
        else:
            lines.append(f"{head}; newest first:")
            lines.extend(f"    {c['short']} {c['message']}" for c in u["commits"][:10])
            if u["behind_by"] > 10:
                lines.append(f"    … and {u['behind_by'] - 10} more")
    elif u["state"] == "local_ahead":
        lines.append(
            f"  running {u['ahead_by']} commit(s) that {b['branch']} does not have; nothing to pull"
        )
    elif u["state"] == "diverged":
        lines.append(
            f"  diverged: {u['behind_by']} commit(s) to pull, and {u['ahead_by']} here that "
            f"{b['branch']} does not have"
        )
    else:
        lines.append(f"  unknown: {u['reason']}")

    from app import nova_updates

    lines.append(f"  last update: {nova_updates.words(data.get('last_update'))}")

    h = data["hub"]
    lines.append("HUB (this host: core, gateway, memory, postgres and the web app)")
    lines.append(f"  tailnet address: {h['address'] or 'none — ' + (h['address_reason'] or '')}")
    if h["agent"]:
        a = h["agent"]
        state = (
            "connected"
            if a["connected"]
            else f"not connected, last seen {_ago(a['last_seen'], now)}"
        )
        lines.append(f"  its own agent: {a['name']} ({a['os'] or a['platform']}), {state}")
    else:
        lines.append("  its own agent: none paired")
    for s in data["services"]:
        reason = f" — {s['reason']}" if s["reason"] else ""
        lines.append(f"  service {s['name']}: {s['state']}{reason}")

    lines.append("OTHER MACHINES RUNNING NOVA'S AGENT")
    if not data["satellites"]:
        lines.append("  none")
    for a in data["satellites"]:
        state = (
            "connected"
            if a["connected"]
            else f"not connected, last seen {_ago(a['last_seen'], now)}"
        )
        lines.append(
            f"  {a['name']} ({a['os'] or a['platform']}, host {a['hostname']}): {state}; "
            f"agent build {a['build_state']}"
        )

    m = data["model_machines"]
    lines.append("MODEL MACHINES (the gateway's last reading)")
    if m["machines"] is None:
        lines.append(f"  could not be read: {m['reason']}")
    elif not m["machines"] and m["remotes"] == []:
        lines.append("  none")
    for e in m["machines"] or []:
        held = f", {e['models']} model(s)" if e["models"] is not None else ""
        why = f" — {e['reason']}" if e["reason"] else ""
        serving = (
            "" if e["serving"] is None else (", serving" if e["serving"] else ", switched off")
        )
        lines.append(f"  {e['name']}: {e['state'] or 'unknown'}{serving}{held}{why}")
    if m["remotes"] is None:
        lines.append(f"  remote model machines could not be read: {m['remotes_reason']}")
    for r in m["remotes"] or []:
        where = f"remote, {r['host']}" if r["host"] is not None else "remote"
        words = model_machines.remote_words(r, r["device_said"])
        lines.append(f"  {r['name']} ({where}): {words}")

    c = data["clients"]
    lines.append(f"CLIENTS (signed-in apps and browsers used in the last {c['window_days']} days)")
    if not c["clients"]:
        lines.append("  none recorded")
    for client in c["clients"]:
        lines.append(
            f"  {client['label']}, {client['person']}, last used {_ago(client['last_seen'], now)}"
        )
    if c["unseen"]:
        lines.append(
            f"  plus {c['unseen']} signed-in session(s) not used since clients were recorded"
        )
    return "\n".join(lines)
