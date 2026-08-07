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
import re
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
                budget_s: int = 0, requested_by: str | None = None,
                continue_from: str | None = None,
                goal_id: str | None = None) -> dict:
    """Kick off one coding task. Returns immediately — sessions run minutes.

    The row is written BEFORE the broker is called and updated after, so a
    broker that dies mid-request leaves a record saying what was attempted
    rather than nothing at all.

    `continue_from` is one of OUR session ids, not a broker id: callers hold
    the durable row and should not have to know the broker's bookkeeping. It
    is resolved here, and an unresolvable one is an ERROR rather than a
    fresh start — a "resumed" session that quietly began from the trunk is
    the false premise the whole parameter exists to remove.
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

    resume_broker_id = ""
    if continue_from:
        async with db.acquire() as conn:
            prev = await conn.fetchrow(
                "SELECT broker_session_id, commit_sha FROM coding_sessions "
                "WHERE id = $1::uuid", str(continue_from))
        if not prev or not prev["broker_session_id"]:
            return {"status": "error",
                    "detail": (f"cannot resume session {continue_from}: it "
                               f"never reached the broker, so there is no "
                               f"clone to continue from")}
        resume_broker_id = prev["broker_session_id"]

    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO coding_sessions
                   (workspace_id, task, mode, requested_by, continued_from,
                    goal_id)
               VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid) RETURNING *""",
            ws["id"], task, mode, requested_by,
            str(continue_from) if continue_from else None,
            str(goal_id) if goal_id else None)
    sid = row["id"]

    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT_S) as client:
            resp = await client.post(
                f"{settings.coder_url}/session", headers=_auth(),
                json={"repo": ws["git_url"], "task": task, "mode": mode,
                      "budget_s": budget_s,
                      "continue_from": resume_broker_id,
                      # What the patch is measured from. The workspace's own
                      # trunk, never a guess: `sandbox_check` and `land` both
                      # apply the result to it.
                      "base_ref": ws["default_branch"] or "main"})
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
            "continued_from": str(continue_from) if continue_from else None,
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
            "goal_id": (str(row["goal_id"]) if row.get("goal_id") else None),
            "continued_from": (str(row["continued_from"])
                               if row.get("continued_from") else None),
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


# --- the boot gate ---------------------------------------------------------

_LANDING_URL = os.environ.get("NOVA_GIT_LANDING_URL", "http://git-landing:9912")


async def sandbox_check(session_id: str) -> dict:
    """Build and boot this session's work in a stack of its own, and record it.

    `docs/plans/sandbox-instance.md` phase 3. Minutes, not seconds: it builds
    an image, starts postgres and a backend, waits for `/health` — which is
    the migrations-and-boot test — and runs the suite inside it.

    ON A SCRATCH BRANCH, removed either way. The thing worth verifying is
    "main plus her patch", which is exactly what landing would produce, and
    producing it is the only honest way to test it. Naming it `nova/sbx-…`
    keeps it distinguishable from a branch the operator asked for, and the
    finally-block removes it so a red check leaves nothing behind for someone
    to find later and wonder about.

    The verdict is keyed to the COMMIT, not the session: a session can be
    re-run and its patch re-captured, and a verdict that outlived the code it
    was about would be worse than none.
    """
    got = await patch(session_id)
    if got.get("status") != "ok":
        return {"status": "error", "detail": got.get("detail")}
    commit = got.get("commit") or ""
    slug = f"sbx-{(commit or session_id)[:8]}"
    branch = f"nova/{slug}"

    async def _post(url, payload, timeout):
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(url, json=payload)
        try:
            return r.json()
        except ValueError:
            return {"status": "error", "detail": f"unreadable ({r.status_code})"}

    landed = await _post(f"{_LANDING_URL}/land",
                         {"patch": got["patch"], "branch": branch}, 180.0)
    if landed.get("status") != "ok":
        return {"status": "error",
                "detail": f"could not stage the check: {landed.get('detail')}"}
    try:
        wt = await _post(f"{_LANDING_URL}/worktree", {"branch": branch}, 120.0)
        if wt.get("status") != "ok":
            return {"status": "error", "detail": wt.get("detail")}
        # Long: a first build pulls a base image and installs dependencies.
        # The sidecar tears its own stack down in a finally, so a timeout here
        # leaves the caller without an answer but never leaves a stack running.
        from app.config import settings as _s
        async with httpx.AsyncClient(timeout=3000.0) as c:
            r = await c.post(f"{_s.inference_control_url}/sandbox/check",
                             json={"slug": slug})
        out = r.json()
    except (httpx.HTTPError, ValueError) as e:
        out = {"status": "failed", "stage": "unreachable", "steps": [],
               "error": str(e)[:300]}
    finally:
        await _post(f"{_LANDING_URL}/worktree/remove", {"branch": branch}, 120.0)
        await _post(f"{_LANDING_URL}/branch/remove", {"branch": branch}, 60.0)

    ok = out.get("status") == "ok"
    failing = next((s for s in (out.get("steps") or []) if not s.get("ok")), {})
    detail = (f"{out.get('stage') or 'unknown'}: "
              f"{(failing.get('summary') or out.get('error') or '')[:900]}"
              if not ok else "build, boot and suite all green")
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE coding_sessions SET sandbox_status = $2, "
            "sandbox_commit = $3, sandbox_detail = $4, sandbox_at = now(), "
            "updated_at = now() WHERE id = $1::uuid",
            session_id, "ok" if ok else "failed", commit, detail)
    log.info("sandbox check %s: %s (%s)", session_id, out.get("status"),
             out.get("stage"))
    return {"status": "ok" if ok else "failed", "commit": commit,
            "stage": out.get("stage"), "detail": detail,
            "steps": [{"step": s.get("step"), "ok": s.get("ok")}
                      for s in (out.get("steps") or [])]}


async def sandbox_verdict(session_id: str) -> dict:
    """The recorded verdict, and whether it still applies to this commit."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT commit_sha, sandbox_status, sandbox_commit, sandbox_detail,"
            " sandbox_at FROM coding_sessions WHERE id = $1::uuid", session_id)
    if row is None:
        return {"state": "unknown", "detail": "no such session"}
    if not row["sandbox_status"]:
        return {"state": "never", "detail": "this work has never been checked"}
    if row["sandbox_commit"] != row["commit_sha"]:
        return {"state": "stale",
                "detail": (f"the check was for {(row['sandbox_commit'] or '')[:10]} "
                           f"and the session is now at "
                           f"{(row['commit_sha'] or '')[:10]}")}
    return {"state": row["sandbox_status"], "detail": row["sandbox_detail"],
            "at": row["sandbox_at"].isoformat() if row["sandbox_at"] else None}


# --- a second model reads it ------------------------------------------------

#: How much diff the reviewer is shown. A change this large is not reviewable
#: in one pass by anyone, and truncating silently would produce a confident
#: verdict on half a patch — so it is REPORTED as unreviewable instead.
_REVIEW_MAX_PATCH = 60_000


def _coder_model() -> str:
    """What model wrote the code, as the compose file configures it."""
    return (os.environ.get("CODER_MODEL")
            or "anthropic/claude-sonnet-4.6").strip()


async def review(session_id: str) -> dict:
    """Have a DIFFERENT model read the diff against the task it claims to do.

    Step 11, and the last judgment in the loop that was still resting on the
    model that wrote the code. Everything else is mechanical by now — the
    sandbox builds it, boots it against his real data and runs both suites —
    and all of that answers "does it work". None of it answers "does it do
    what was asked", and a change can be green on every gate while
    implementing the wrong thing.

    REFUSES WHEN THE MODELS MATCH. A model grading its own work is the same
    judgment twice with more words, and the failure mode is that it reads
    like a second opinion. Asserted from live config rather than assumed, so
    setting CODER_MODEL to the reviewer's model stops the step instead of
    quietly degrading it.

    Lives here and NOT in `actions/`: that package forbids an LLM client at
    any depth, enforced by an AST walk, because approving a card must not run
    a model. Review is something she or the operator asks for BEFORE the card
    is approved — the card then only checks the recorded verdict.
    """
    from app.agents import registry as agent_registry
    from app.agents import runner as agent_runner

    got = await patch(session_id)
    if got.get("status") != "ok":
        return {"status": "error", "detail": got.get("detail")}
    commit = got.get("commit") or ""
    diff = got.get("patch") or ""

    reviewer = await agent_registry.get_agent_by_name("reviewer")
    if not reviewer:
        return {"status": "error",
                "detail": "no `reviewer` agent — migration 103 creates it"}
    r_model = (reviewer.get("model") or "").strip()
    c_model = _coder_model()
    # Compare the MODEL, not the provider prefix: `openrouter:z-ai/glm-5.2`
    # and `z-ai/glm-5.2` are the same judgment reached twice.
    if r_model.split(":", 1)[-1] == c_model.split(":", 1)[-1]:
        return {"status": "error",
                "detail": (f"the reviewer and the coding agent are both "
                           f"{r_model} — a model grading its own work is not "
                           f"a review. Point CODER_MODEL or the reviewer "
                           f"agent at a different model.")}

    if len(diff) > _REVIEW_MAX_PATCH:
        detail = (f"the diff is {len(diff):,} bytes, past the "
                  f"{_REVIEW_MAX_PATCH:,} a single review pass can honestly "
                  f"cover. Split the change.")
        await _store_review(session_id, "concerns", commit, detail, r_model)
        return {"status": "concerns", "commit": commit, "detail": detail}

    prompt = (f"TASK\n{got.get('task') or '(not recorded)'}\n\n"
              f"DIFF\n```diff\n{diff}\n```")
    text = ""
    async for ev in agent_runner.run_agent(reviewer, [{"role": "user",
                                                       "content": prompt}],
                                           dispatch_depth=1):
        if ev.get("type") == "final":
            text = ev.get("text") or ""

    body = text.strip()
    # FAILS CLOSED. An unparseable verdict is a concern, never a pass: the
    # whole point is that nothing lands unread, and "the reviewer said
    # something I could not interpret" is indistinguishable from unread.
    verdict = "pass" if re.search(r"^\s*VERDICT:\s*PASS\b", body,
                                  re.I | re.M) else "concerns"
    await _store_review(session_id, verdict, commit, body[:4000], r_model)
    log.info("review %s: %s (%s)", session_id, verdict, r_model)
    return {"status": verdict, "commit": commit, "model": r_model,
            "detail": body[:4000]}


async def _store_review(session_id, status, commit, detail, model) -> None:
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE coding_sessions SET review_status = $2, review_commit = $3,"
            " review_detail = $4, review_model = $5, review_at = now(), "
            "updated_at = now() WHERE id = $1::uuid",
            session_id, status, commit, detail, model)


async def review_verdict(session_id: str) -> dict:
    """The recorded review, and whether it still applies to this commit."""
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT commit_sha, review_status, review_commit, review_detail, "
            "review_model FROM coding_sessions WHERE id = $1::uuid", session_id)
    if row is None:
        return {"state": "unknown", "detail": "no such session"}
    if not row["review_status"]:
        return {"state": "never", "detail": "no second model has read this yet"}
    if row["review_commit"] != row["commit_sha"]:
        return {"state": "stale",
                "detail": (f"reviewed {(row['review_commit'] or '')[:10]}, "
                           f"session is now at "
                           f"{(row['commit_sha'] or '')[:10]}")}
    return {"state": row["review_status"], "detail": row["review_detail"],
            "model": row["review_model"]}
