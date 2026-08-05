"""Coding delegation — the backend's half of the coder sidecar.

docs/plans/acp-coding-delegation.md phase 1. Nova drives an existing coding
agent over ACP; `coder/broker.py` runs it, this module is what the backend
calls and where the durable record lives.

THE SPLIT, and why the row outlives the session. The broker holds sessions in
memory and loses them on restart; `coding_sessions` is the durable record. So a
session whose broker id no longer resolves is not a row to delete — it is a
session that died, and saying so is more useful than a gap. `refresh` writes
that outcome down rather than leaving the row saying `running` forever.

WHAT THIS MODULE DOES NOT DO: decide anything the sidecar decides. The
permission mode allow-list, the path adjudication and the wall clock all live
at the broker, because that is the process that actually spawns the agent —
the lesson mcp-runner learned on 2026-07-31, when the launcher allow-list
guarded the registration route and the process calling exec checked nothing.
Duplicating those checks here would create a second, weaker authority; this
module's job is to pass the operator's intent through and record what came
back.
"""

from __future__ import annotations

import json
import logging
import os
from typing import Optional

import httpx

from app import db
from app.config import settings

log = logging.getLogger(__name__)

_TIMEOUT_S = 30.0
#: Broker states that will never change again — refresh stops polling at these.
TERMINAL = frozenset({"done", "failed", "killed"})


def configured() -> bool:
    """Is delegation available? Derived from the credential, like the k8s
    runtime's — no flag to leave switched on after the sidecar is gone."""
    return bool(settings.nova_coder_token)


def _auth() -> dict:
    """Empty when unconfigured, which the broker answers with 503 rather than
    running anything. Loud beats a silently unauthenticated coding agent."""
    token = settings.nova_coder_token
    return {"Authorization": f"Bearer {token}"} if token else {}


# --- workspaces ------------------------------------------------------------

async def list_workspaces(include_disabled: bool = False) -> list[dict]:
    where = "" if include_disabled else " WHERE enabled"
    async with db.acquire() as conn:
        rows = await conn.fetch(
            f"SELECT * FROM workspaces{where} ORDER BY name")
    return [dict(r) for r in rows]


async def add_workspace(name: str, git_url: str, default_branch: str = "main",
                        auth_secret: Optional[str] = None) -> dict:
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO workspaces (name, git_url, default_branch, auth_secret)
               VALUES ($1, $2, $3, $4) RETURNING *""",
            name.strip(), git_url.strip(), (default_branch or "main").strip(),
            (auth_secret or None))
    log.info("workspace registered: %s -> %s", name, git_url)
    return dict(row)


async def set_workspace_enabled(name: str, enabled: bool) -> bool:
    async with db.acquire() as conn:
        r = await conn.execute(
            "UPDATE workspaces SET enabled = $2, updated_at = now() "
            "WHERE name = $1", name, enabled)
    return r.endswith("1")


async def delete_workspace(name: str) -> bool:
    async with db.acquire() as conn:
        r = await conn.execute("DELETE FROM workspaces WHERE name = $1", name)
    return r.endswith("1")


# --- sessions --------------------------------------------------------------

async def start(workspace: str, task: str, *, mode: str = "default",
                budget_s: int = 0, requested_by: str | None = None) -> dict:
    """Kick off one coding task. Returns immediately — sessions run minutes.

    The row is written BEFORE the broker is called and updated after, so a
    broker that dies mid-request leaves a record saying what was attempted
    rather than nothing at all.
    """
    if not configured():
        return {"status": "error",
                "detail": ("Coding delegation is not configured. Set "
                           "NOVA_CODER_TOKEN and CODER_API_KEY in .env and "
                           "start the sidecar: docker compose --profile coder "
                           "up -d coder")}
    async with db.acquire() as conn:
        ws = await conn.fetchrow(
            "SELECT * FROM workspaces WHERE name = $1 AND enabled", workspace)
    if not ws:
        available = [w["name"] for w in await list_workspaces()]
        return {"status": "error",
                "detail": (f"No enabled workspace named '{workspace}'. "
                           f"Available: {', '.join(available) or '(none)'}")}

    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO coding_sessions (workspace_id, task, mode, requested_by)
               VALUES ($1, $2, $3, $4) RETURNING *""",
            ws["id"], task, mode, requested_by)
    sid = row["id"]

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.post(
                f"{settings.coder_url}/session", headers=_auth(),
                json={"repo": ws["git_url"], "task": task, "mode": mode,
                      "budget_s": budget_s})
        if resp.status_code >= 400:
            detail = _detail(resp)
            await _update(sid, state="failed", error=detail)
            return {"status": "error", "session_id": str(sid), "detail": detail}
        body = resp.json()
    except Exception as e:                                   # noqa: BLE001
        log.exception("coder start failed")
        await _update(sid, state="failed", error=str(e)[:400])
        return {"status": "error", "session_id": str(sid), "detail": str(e)[:400]}

    await _update(sid, broker_session_id=body["id"], state=body.get("state"),
                  branch=body.get("branch"))
    return {"status": "started", "session_id": str(sid),
            "branch": body.get("branch"),
            "note": ("Started — it runs for minutes, not seconds. Nothing is "
                     "merged: the deliverable is a branch and a diff for the "
                     "operator to review.")}


async def refresh(session_id: str) -> dict:
    """Poll the broker and write what it says into the row."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM coding_sessions WHERE id = $1::uuid", session_id)
    if not row:
        return {"status": "error", "detail": "no such session"}
    if row["state"] in TERMINAL or not row["broker_session_id"]:
        return _shape(dict(row))

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.get(
                f"{settings.coder_url}/session/{row['broker_session_id']}",
                headers=_auth())
    except Exception as e:                                   # noqa: BLE001
        return {**_shape(dict(row)), "stale": True, "detail": str(e)[:200]}

    if resp.status_code == 404:
        # The broker restarted and forgot it. That is an outcome, not a gap.
        await _update(row["id"], state="failed",
                      error="the coder sidecar restarted; this session is gone")
        return {**_shape(dict(row)), "state": "failed"}
    if resp.status_code >= 400:
        return {**_shape(dict(row)), "detail": _detail(resp)}

    b = resp.json()
    await _update(row["id"], state=b.get("state"), branch=b.get("branch"),
                  commit_sha=b.get("commit") or None,
                  diffstat=b.get("diffstat") or None, error=b.get("error"),
                  denials=json.dumps(b.get("denials") or []),
                  commands=json.dumps(b.get("commands") or []))
    # CAPTURE THE PATCH THE MOMENT IT EXISTS, because the broker keeps its
    # sessions in a process-local dict and a restart empties it. Three
    # genuinely finished sessions were found unlandable that way — commit and
    # diffstat recorded here, patch unreachable. A change she wrote on Tuesday
    # has to still be landable on Thursday.
    if b.get("state") in TERMINAL and b.get("commit") and not row["patch"]:
        await _capture_patch(row["id"], row["broker_session_id"])

    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM coding_sessions WHERE id = $1", row["id"])
    out = _shape(dict(row))
    out["tail"] = b.get("tail") or []
    out["elapsed_s"] = b.get("elapsed_s")
    # The review surface (phase 3) comes back through `_shape`, which reads the
    # persisted columns — so the list endpoint carries it too, and it survives
    # a sidecar restart. Only the live-only extras are added here.
    return out


async def kill(session_id: str) -> dict:
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM coding_sessions WHERE id = $1::uuid", session_id)
    if not row:
        return {"status": "error", "detail": "no such session"}
    if row["broker_session_id"]:
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                await client.post(
                    f"{settings.coder_url}/session/"
                    f"{row['broker_session_id']}/kill", headers=_auth())
        except Exception as e:                               # noqa: BLE001
            log.warning("kill request to broker failed: %s", e)
    await _update(row["id"], state="killed",
                  error=row["error"] or "killed by operator")
    return {"status": "killed", "session_id": str(row["id"])}


async def recent(limit: int = 20) -> list[dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch(
            """SELECT s.*, w.name AS workspace
                 FROM coding_sessions s
                 LEFT JOIN workspaces w ON w.id = s.workspace_id
                ORDER BY s.created_at DESC LIMIT $1""", limit)
    return [_shape(dict(r)) for r in rows]


# --- helpers ---------------------------------------------------------------

def _detail(resp: httpx.Response) -> str:
    try:
        return str(resp.json().get("detail") or resp.text)[:400]
    except Exception:                                        # noqa: BLE001
        return f"HTTP {resp.status_code}: {resp.text[:300]}"


def _shape(row: dict) -> dict:
    def _blob(key):
        v = row.get(key)
        if isinstance(v, str):
            try:
                return json.loads(v)
            except ValueError:
                return []
        return v or []
    return {"session_id": str(row["id"]), "state": row["state"],
            "denials": _blob("denials"), "commands": _blob("commands"),
            "review": (f"git -C <clone> diff {row['commit_sha'][:12]}~1.."
                       f"{row['commit_sha'][:12]}") if row.get("commit_sha") else None,
            "task": row["task"], "branch": row["branch"],
            "commit": row["commit_sha"], "diffstat": row["diffstat"],
            "error": row["error"], "workspace": row.get("workspace"),
            "created_at": row["created_at"].isoformat() if row.get("created_at") else None}


async def _update(sid, **fields):
    fields = {k: v for k, v in fields.items() if v is not None}
    if not fields:
        return
    sets = ", ".join(f"{k} = ${i}" for i, k in enumerate(fields, start=2))
    async with db.acquire() as conn:
        await conn.execute(
            f"UPDATE coding_sessions SET {sets}, updated_at = now() WHERE id = $1",
            sid, *fields.values())


# A reviewable diff is kilobytes. Anything past this is not a change someone
# is going to read on a card, and half a patch is not a patch — so an
# oversized one is REFUSED at capture rather than truncated, which would fail
# confusingly inside `git am` instead of clearly here.
_PATCH_MAX = 2_000_000


async def _capture_patch(row_id, broker_session_id: str) -> None:
    """Store a finished session's patch on its row. Never raises.

    Best-effort by design: a capture that fails leaves `patch` NULL and
    `coder.patch()` falls back to asking the broker, which is exactly the
    behaviour that existed before this column. It can only add durability,
    never remove it.
    """
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"{settings.coder_url}/session/{broker_session_id}/patch",
                headers=_auth())
        if r.status_code != 200:
            return
        text = (r.json() or {}).get("patch") or ""
        if not text.strip():
            return
        if len(text) > _PATCH_MAX:
            log.warning("session %s patch is %d bytes; not captured",
                        row_id, len(text))
            return
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE coding_sessions SET patch = $2, "
                "patch_captured_at = now(), updated_at = now() WHERE id = $1",
                row_id, text)
        log.info("captured %d-byte patch for session %s", len(text), row_id)
    except Exception:                                    # noqa: BLE001
        log.exception("could not capture the patch for session %s", row_id)


async def patch(session_id: str) -> dict:
    """The session's work as a patch, fetched from the broker.

    Phase 4. The deliverable used to be "a branch and a diff" in a private
    clone inside a named volume — safe, and unreachable, so every change she
    wrote was retyped by a human against the real repo. This is the text
    coming out. It still lands nowhere: `land()` does that, behind an
    operator's approval, onto a branch that is never `main`.
    """
    if not configured():
        return {"status": "error", "detail": "the coder sidecar is not configured"}
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, broker_session_id, state, branch, commit_sha, task, "
            "patch FROM coding_sessions WHERE id = $1::uuid", session_id)
    if row is None:
        return {"status": "error", "detail": f"no coding session {session_id}"}

    # THE STORED COPY FIRST. It was captured when the session finished, so it
    # survives the broker restart that made three real sessions unlandable.
    if (row["patch"] or "").strip():
        return {"status": "ok", "session_id": str(row["id"]),
                "task": row["task"], "branch": row["branch"] or "",
                "commit": row["commit_sha"] or "", "diffstat": "",
                "patch": row["patch"], "source": "stored"}
    if not row["broker_session_id"]:
        return {"status": "error",
                "detail": "that session never reached the broker"}
    if not row["commit_sha"]:
        return {"status": "error",
                "detail": (f"session {session_id} produced no commit — state "
                           f"{row['state']!r}. There is nothing to land.")}
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            r = await client.get(
                f"{settings.coder_url}/session/{row['broker_session_id']}/patch",
                headers=_auth())
    except httpx.HTTPError as e:
        return {"status": "error", "detail": f"the coder sidecar is unreachable: {e}"}
    if r.status_code == 404:
        # TWO DIFFERENT 404s, and telling them apart matters. FastAPI answers
        # an unknown ROUTE with 404 exactly as it answers an unknown session,
        # so the first version of this message blamed "the broker restarted
        # and forgot it" for a coder container that had simply never been
        # rebuilt with the /patch endpoint — a confident, wrong diagnosis
        # pointing at a restart that had not happened (uptime was four days).
        #
        # The session endpoint is the discriminator: if THAT resolves, the
        # session is alive and it is the route that is missing.
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
                probe = await client.get(
                    f"{settings.coder_url}/session/{row['broker_session_id']}",
                    headers=_auth())
            alive = probe.status_code == 200
        except httpx.HTTPError:
            alive = False
        if alive:
            return {"status": "error",
                    "detail": ("the coder sidecar is running a build without "
                               "the /patch endpoint — rebuild it: "
                               "docker compose --profile coder build coder && "
                               "docker compose --profile coder up -d coder")}
        return {"status": "error",
                "detail": ("the broker no longer has that session (it keeps "
                           "them in memory and restarts with an empty map). "
                           "The work is not lost — the branch is still in the "
                           "clone — but the patch has to come from a fresh "
                           "run.")}
    if r.status_code != 200:
        return {"status": "error", "detail": _detail(r)}
    body = r.json()
    if not (body.get("patch") or "").strip():
        return {"status": "error", "detail": "the broker returned an empty patch"}
    return {"status": "ok", "session_id": str(row["id"]), "task": row["task"],
            "branch": row["branch"] or body.get("branch") or "",
            "commit": body.get("commit") or row["commit_sha"],
            "diffstat": body.get("diffstat") or "", "patch": body["patch"]}


async def land(patch_text: str, branch: str) -> dict:
    """Apply a patch to the host repository, on a branch, via `git-landing`.

    THE BACKEND DOES NOT DO THIS ITSELF and must not learn how. It mounts the
    repo read-only on purpose: it is the process a poisoned web page talks to,
    and repository write access there would put "rewrite your own source" one
    injection away. The capability lives in one container that can do nothing
    else, and every refusal that matters — not `main`, not a dirty worktree,
    no push, abort-on-conflict — is enforced there rather than here.
    """
    url = os.environ.get("NOVA_GIT_LANDING_URL", "http://git-landing:9912")
    try:
        async with httpx.AsyncClient(timeout=180.0) as client:
            r = await client.post(f"{url}/land",
                                  json={"patch": patch_text, "branch": branch})
    except httpx.HTTPError as e:
        return {"status": "error",
                "detail": (f"the git-landing sidecar is unreachable ({e}). It "
                           f"runs under the `coder` profile; nothing can be "
                           f"landed without it.")}
    try:
        return r.json()
    except ValueError:
        return {"status": "error", "detail": f"unreadable reply ({r.status_code})"}


async def repo_status() -> dict:
    """What the host repo looks like — branch, HEAD, whether it is dirty.

    Read-only, and the reason it is exposed at all: a landing is refused on a
    dirty worktree, so "why did that fail" has to be answerable before the
    attempt rather than only after it.
    """
    url = os.environ.get("NOVA_GIT_LANDING_URL", "http://git-landing:9912")
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(f"{url}/status")
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        return {"error": f"the git-landing sidecar is unreachable: {e}"}
