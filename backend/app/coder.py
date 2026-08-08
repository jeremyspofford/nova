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

from app import db, sidecar_auth
from app.config import settings

log = logging.getLogger(__name__)

_TIMEOUT_S = 30.0
#: Broker states that will never change again — refresh stops polling at these.
#: `stalled` is one of them: it is written only after a live poll found no
#: progress for the whole window, and a session that resumed would have moved
#: its fingerprint before the reconciler ever looked.
TERMINAL = frozenset({"done", "failed", "killed", "stalled"})

#: How long a session may report no PROGRESS before it is called stalled.
#: Not a wall clock on the session — the broker owns that (`budget_s`) and a
#: long compile is not a death. This is the window in which a live agent
#: always does *something*: a command, a denial, a commit, a state change.
_STALL_AFTER_S = 900.0


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

#: Where migrations live, relative to the repo root. The backend runs them
#: from here at startup, so this is the same fact the runner uses rather than
#: a second copy of it.
_MIGRATIONS_DIR = os.path.join(os.path.dirname(__file__), "migrations")


async def _repo_facts() -> str:
    """Facts about THIS repo, read live, prepended to every delegated task.

    MEASURED 2026-08-07. Asked to add a model to the catalogue, Nova wrote a
    task instructing the coder to "create an Alembic migration" against "the
    models_catalog table" in "backend/migrations/". All three are wrong: the
    system is plain SQL in `backend/app/migrations/` and the table is
    `curated_models`. Her own maintainer dispatch had read
    `018_curated_models.sql` minutes earlier; the finding did not survive
    into the task she authored. The coder burned its session running `ls`
    against directories that do not exist.

    So the facts ride along with every task, and they are READ, not written
    down: the next migration number comes from the directory, the table names
    come from the database. A hardcoded list here would be wrong the first
    time either changes, and wrong in the same confident tone.

    This does not make the task text trustworthy — it makes it accurate. The
    controls that decide what the coder may do are all at the broker.
    """
    try:
        nums = [int(m.group(1))
                for f in os.listdir(_MIGRATIONS_DIR)
                if (m := re.match(r"(\d+)_.*\.sql$", f))]
        next_num = f"{max(nums) + 1:03d}" if nums else "001"
    except OSError as e:
        log.warning("repo facts: cannot read migrations dir: %s", e)
        next_num = "(unknown — list backend/app/migrations/ yourself)"

    try:
        async with db.acquire() as conn:
            rows = await conn.fetch(
                "SELECT tablename FROM pg_tables WHERE schemaname = 'public' "
                "ORDER BY tablename")
        tables = ", ".join(r["tablename"] for r in rows)
    except Exception as e:                                   # noqa: BLE001
        log.warning("repo facts: cannot list tables: %s", e)
        tables = "(unknown — query pg_tables yourself before naming one)"

    return (
        "## Facts about this repository (read from the live system just now)\n"
        "\n"
        "- Database migrations are PLAIN SQL files in `backend/app/migrations/`,\n"
        "  named `NNN_snake_case_description.sql`, run in numeric order by the\n"
        f"  backend at startup. The next free number is **{next_num}**.\n"
        "- There is NO Alembic in this project. No `env.py`, no `versions/`\n"
        "  directory, no revision graph. Do not create one.\n"
        f"- The tables that exist are: {tables}.\n"
        "  If the task names a table not in that list, the task is wrong —\n"
        "  say so and stop rather than creating it.\n"
        "\n"
        "## The task\n\n")


async def start(workspace: str, task: str, *, mode: str = "default",
                budget_s: int = 0, requested_by: str | None = None,
                continue_from: str | None = None,
                goal_id: str | None = None,
                max_tokens: int = 0) -> dict:
    """Kick off one coding task. Returns immediately — sessions run minutes.

    The row is written BEFORE the broker is called and updated after, so a
    broker that dies mid-request leaves a record saying what was attempted
    rather than nothing at all.

    `continue_from` is one of OUR session ids, not a broker id: callers hold
    the durable row and should not have to know the broker's bookkeeping. It
    is resolved here, and an unresolvable one is an ERROR rather than a
    fresh start — a "resumed" session that quietly began from the trunk is
    the false premise the whole parameter exists to remove.

    `max_tokens` caps the coding agent's completion budget for this session.
    It exists for exactly one caller: the 402 whose text states the budget the
    key can actually afford (`provider_errors.token_budget`). It is REFUSED
    unless the sidecar's own schema carries the field — see `broker_supports`
    — because sending a cap to a broker that ignores it would produce a
    "smaller retry" that is byte-for-byte the call that just failed.
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

    if max_tokens:
        supported = await broker_supports("max_tokens")
        if supported is not True:
            return {"status": "error",
                    "detail": (
                        f"cannot start a session capped at {max_tokens:,} "
                        f"tokens: " + (
                            "the coder sidecar's /session schema has no "
                            "max_tokens field, so the cap would be silently "
                            "ignored and the retry would be the same call "
                            "that just failed"
                            if supported is False else
                            "the coder sidecar's schema could not be read, so "
                            "there is no way to know whether the cap would be "
                            "applied"))}

    # The stored task is what the coder is actually given, facts and all —
    # so the row explains the session rather than describing a different one.
    task = (await _repo_facts()) + task

    async with db.acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO coding_sessions
                   (workspace_id, task, mode, requested_by, continued_from,
                    goal_id, progress_at)
               VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid, now()) RETURNING *""",
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
                      **({"max_tokens": int(max_tokens)} if max_tokens else {}),
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
    usage = snapshot_usage(b)
    await _update(row["id"], state=b.get("state"), branch=b.get("branch"),
                  commit_sha=b.get("commit") or None,
                  diffstat=b.get("diffstat") or None, error=b.get("error"),
                  denials=json.dumps(b.get("denials") or []),
                  commands=json.dumps(b.get("commands") or []),
                  # None fields are dropped by _update, so an unmeasured poll
                  # leaves NULLs standing rather than overwriting a figure a
                  # previous poll persisted — and never writes a zero.
                  model=(str(b.get("model") or "").strip() or None),
                  tokens_in=(usage or {}).get("tokens_in"),
                  tokens_out=(usage or {}).get("tokens_out"),
                  usd=(usage or {}).get("usd"))
    await _note_progress(row["id"], row.get("progress_fingerprint"), b)
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


def _fingerprint(body: dict) -> str:
    """What "this session did something" looks like, as one comparable value.

    COUNTS, not contents, for `commands` and `denials`: the broker returns
    the whole list every poll, so comparing contents would be comparing a
    growing prefix to itself and any change would register — including none.
    The count moves exactly when a new one arrives.
    """
    return "|".join(str(x) for x in (
        body.get("state") or "",
        body.get("commit") or "",
        body.get("diffstat") or "",
        len(body.get("commands") or []),
        len(body.get("denials") or []),
    ))


async def _note_progress(sid, previous: str | None, body: dict) -> None:
    """Move the progress clock only when the fingerprint actually moved."""
    now = _fingerprint(body)
    if now == (previous or ""):
        return
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE coding_sessions SET progress_fingerprint = $2, "
            "progress_at = now() WHERE id = $1", sid, now)


async def reconcile_stalled() -> tuple[bool, str]:
    """Refresh every live session, then mark the ones that stopped moving.

    THE ORDER IS THE POINT. Each session is polled against the broker FIRST,
    so `stalled` always follows a live check. Judging from the row alone
    would report "we stopped looking at it" as "it died" — and a status that
    is wrong in the reassuring direction is the failure this whole module's
    docstring is about.

    Returns the `(ok, summary)` shape the scheduler's mechanical handlers
    use. A broker that cannot be reached is a FAILED run, not a quiet zero:
    an unreachable broker is precisely when sessions are most likely to be
    dead, and reporting "0 stalled" then would be the fallback-that-reads-as
    -success this codebase keeps finding.
    """
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id FROM coding_sessions WHERE state IS NULL "
            "OR state <> ALL($1::text[])", list(TERMINAL))
    if not rows:
        return True, "no live coding sessions"

    # Order matters: an install with the coder profile switched off has
    # nothing to reconcile and should not fail five times and auto-disable
    # itself. But sessions that are still 'running' with no broker to ask
    # about them are exactly the rows this job exists for, and calling that
    # a clean run would be the reassuring-untruth this module keeps finding.
    if not configured():
        return False, (
            f"{len(rows)} coding session(s) are still marked live, but "
            f"delegation is not configured — there is no broker to ask, so "
            f"their real state is unknown rather than fine")

    checked, stalled, unreachable = 0, [], 0
    for r in rows:
        try:
            await refresh(str(r["id"]))
            checked += 1
        except Exception as e:                               # noqa: BLE001
            log.warning("reconcile: refresh of %s failed: %s", r["id"], e)
            unreachable += 1
            continue

        async with db.acquire() as conn:
            row = await conn.fetchrow(
                """SELECT id, state, commands, error,
                          EXTRACT(EPOCH FROM (now() - COALESCE(
                              progress_at, updated_at, created_at))) AS still_s
                     FROM coding_sessions WHERE id = $1""", r["id"])
        if not row or row["state"] in TERMINAL:
            continue
        if float(row["still_s"] or 0) < _STALL_AFTER_S:
            continue

        # The last evidence goes into the error text, because "stalled" with
        # nothing attached sends the next reader back to the database.
        cmds = row["commands"]
        if isinstance(cmds, str):
            try:
                cmds = json.loads(cmds)
            except ValueError:
                cmds = []
        last = (cmds or [])[-1] if cmds else None
        why = (f"no progress for {int(float(row['still_s']) / 60)} minutes; "
               f"last activity: {last or 'none recorded'}")
        await _update(row["id"], state="stalled",
                      error=(row["error"] or why)[:400])
        stalled.append(str(row["id"]))
        log.warning("coding session %s marked stalled — %s", row["id"], why)

    summary = (f"checked {checked} live session(s); "
               f"{len(stalled)} stalled" +
               (f"; {unreachable} unreachable" if unreachable else ""))
    return unreachable == 0, summary


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


# --- what the sidecar can actually be asked for -----------------------------
#
# DERIVED FROM THE SIDECAR'S OWN SCHEMA, never from a version number or a
# constant here. The broker is a separate image on its own rebuild cycle, and
# the backend regularly runs against one built weeks earlier — a capability
# list maintained on this side would be a statement about the source tree
# rather than about the process actually answering.
#
# FastAPI publishes the request model at /openapi.json, unauthenticated (the
# broker's token guard is per route). So "does it accept this field" is a
# question with a mechanical answer, and `None` — could not read it — is
# deliberately NOT the same value as `False`.

_SCHEMA_TTL_S = 300.0
_schema_cache: dict = {}


async def broker_supports(field: str) -> Optional[bool]:
    """Does the sidecar's /session request model carry `field`?

    True / False / None-for-unknown. Callers must treat None as a refusal:
    "I could not find out" and "yes" are the two answers this codebase keeps
    finding collapsed into one.
    """
    import time
    cached = _schema_cache.get("props")
    if cached is None or time.monotonic() - _schema_cache.get("at", 0) > _SCHEMA_TTL_S:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                r = await client.get(f"{settings.coder_url}/openapi.json")
            if r.status_code != 200:
                return None
            schemas = ((r.json() or {}).get("components") or {}).get("schemas") or {}
            props = (schemas.get("StartSession") or {}).get("properties") or {}
            if not props:
                # An empty property set is not "it supports nothing" — it is a
                # schema we failed to find. Saying so beats answering False.
                return None
            _schema_cache.update({"props": set(props), "at": time.monotonic()})
            cached = _schema_cache["props"]
        except (httpx.HTTPError, ValueError, AttributeError) as e:
            log.warning("could not read the coder sidecar's schema: %s", e)
            return None
    return field in cached


# --- what one broker snapshot says a session cost ---------------------------

#: The streamed usage frame, as observed live on 2026-08-08: cumulative for
#: the session (`cost.amount` was $3.17 after an hour of work, not per-frame),
#: nested under `params.update`, and spelled in none of the token-key
#: spellings `spend.usage_from_updates` reads. That mismatch is why every
#: ledger entry ever written was unmetered while the dollars sat in plain
#: sight in the update stream.
_TAIL_USAGE_PATH = ("params", "update")


def _tail_usage(tail) -> Optional[dict]:
    """Cost figures dug out of an OLD sidecar's 12-update tail, or None.

    Exists only for version skew: a rebuilt broker aggregates its own frames
    and this function never runs for it. Until the operator rebuilds, the
    tail is the only place the figures survive, and the LAST frame wins for
    the same reason as everywhere else — the numbers are cumulative.
    """
    found = None
    for u in tail if isinstance(tail, (list, tuple)) else ():
        node = u
        for key in _TAIL_USAGE_PATH:
            node = node.get(key) if isinstance(node, dict) else None
        if not isinstance(node, dict) or node.get("sessionUpdate") != "usage_update":
            continue
        got: dict = {}
        cost = node.get("cost")
        if (isinstance(cost, dict)
                and isinstance(cost.get("amount"), (int, float))
                and cost.get("currency", "USD") == "USD"):
            got["usd"] = float(cost["amount"])
        if isinstance(node.get("used"), (int, float)):
            got["context_used"] = int(node["used"])
        if got:
            found = {**(found or {}), **got}
    return found


def snapshot_usage(b: dict) -> Optional[dict]:
    """What one broker snapshot says the session cost, normalized, or None.

    Tolerates BOTH sidecar generations, because the broker is a baked image
    on its own rebuild cycle and the backend regularly runs against one built
    weeks earlier: a rebuilt broker carries an aggregated `usage` block, an
    older one only the tail. None is the honest answer when neither reports —
    the caller records the entry unmetered rather than as zero.
    """
    from app import spend
    u = b.get("usage")
    if isinstance(u, dict) and u:
        return u
    return (spend.usage_from_updates(b.get("tail"))
            or _tail_usage(b.get("tail")))


# --- helpers ---------------------------------------------------------------

def session_fault(error: str | None) -> Optional[dict]:
    """What KIND of failure a session's error text is, if it is one at all.

    Derived at read time rather than stored, so a classifier that learns a new
    provider shape reclassifies every session ever recorded — including the
    twelve from 2026-08-07 — instead of only the ones written after the
    change. It rides on `_shape`, so `check_coding_session` tells her "this
    was a billing wall, retrying cannot help" rather than handing her a
    JSON-RPC envelope to interpret.
    """
    if not (error or "").strip():
        return None
    from app import provider_errors
    fault = provider_errors.classify(error)
    if fault.kind == provider_errors.UNKNOWN:
        return None
    out = fault.as_dict()
    # `detail` is the provider's sentence and the row's own `error` column is
    # already that sentence — carrying it twice doubles the size of a listing
    # of ten sessions for nothing.
    out.pop("detail", None)
    if fault.terminal:
        out["operator_note"] = fault.operator_note()
    return out


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
    # NULL columns stay ABSENT from the dict rather than becoming zeros: a
    # session nothing measured has usage None, and the ledger records it as
    # unmetered. Migration 130.
    cost = {k: int(row[k]) for k in ("tokens_in", "tokens_out")
            if row.get(k) is not None}
    if row.get("usd") is not None:
        cost["usd"] = float(row["usd"])
    return {"session_id": str(row["id"]), "state": row["state"],
            "model": row.get("model"), "usage": cost or None,
            "denials": _blob("denials"), "commands": _blob("commands"),
            "review": (f"git -C <clone> diff {row['commit_sha'][:12]}~1.."
                       f"{row['commit_sha'][:12]}") if row.get("commit_sha") else None,
            "task": row["task"], "branch": row["branch"],
            "commit": row["commit_sha"], "diffstat": row["diffstat"],
            "error": row["error"], "fault": session_fault(row.get("error")),
            "workspace": row.get("workspace"),
            "eval": row.get("eval_status"),
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
                                  json={"patch": patch_text, "branch": branch},
                                  headers=sidecar_auth.git_landing_headers())
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
            r = await client.get(f"{url}/status",
                                 headers=sidecar_auth.git_landing_headers())
        return r.json()
    except (httpx.HTTPError, ValueError) as e:
        return {"error": f"the git-landing sidecar is unreachable: {e}"}


# --- the boot gate ---------------------------------------------------------

_LANDING_URL = os.environ.get("NOVA_GIT_LANDING_URL", "http://git-landing:9912")


async def sandbox_check(session_id: str, *, lane: str = "operator") -> dict:
    """Build and boot this session's work in a stack of its own, and record it.

    `lane` is the spend ledger's budget, not a permission. It defaults to
    `operator` so a check the operator asked for is never charged against the
    self-improvement ceiling — a loop that could exhaust its own budget by
    him pressing a button would be a control measuring the wrong thing.

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
        # every _post here targets git-landing, so the token rides along
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.post(url, json=payload,
                             headers=sidecar_auth.git_landing_headers())
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
                             json={"slug": slug},
                             headers=sidecar_auth.inference_control_headers())
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

    # THE EVAL FLOOR'S VERDICT, recorded beside the boot gate's (rail 2). It
    # is written on EVERY path, including the ones where the sandbox died
    # before the stage could run — because the alternative is leaving whatever
    # a previous check wrote, and a stale `ok` on a session that has since been
    # re-run is the exact shape `sandbox_verdict` refuses to trust.
    ev = out.get("eval") if isinstance(out.get("eval"), dict) else None
    if ev is None:
        ev = {"state": "unmeasured",
              "detail": (f"the sandbox stopped at the "
                         f"{out.get('stage') or 'unknown'} stage, before the "
                         f"eval floor could run")}
    async with db.acquire() as conn:
        await conn.execute(
            "UPDATE coding_sessions SET sandbox_status = $2, "
            "sandbox_commit = $3, sandbox_detail = $4, sandbox_at = now(), "
            "eval_status = $5, eval_commit = $3, eval_detail = $6, "
            "eval_scores = $7::jsonb, eval_at = now(), "
            "updated_at = now() WHERE id = $1::uuid",
            session_id, "ok" if ok else "failed", commit, detail,
            str(ev.get("state") or "unmeasured"),
            str(ev.get("detail") or "")[:2000],
            json.dumps(ev.get("scores") or {}))
    log.info("sandbox check %s: %s (%s), eval %s", session_id,
             out.get("status"), out.get("stage"), ev.get("state"))

    # The pass's other real cost. Unmetered — nothing in the compose stack
    # reports what a build and a prod-sized import consumed — and recorded as
    # such rather than as zero, so `spend.today` can say how much of the day
    # it could not see.
    from app import spend as _spend
    await _spend.record(lane, _spend.KIND_SANDBOX,
                        session_id=session_id,
                        detail={"stage": out.get("stage"),
                                "status": out.get("status"),
                                "eval": ev.get("state")})

    return {"status": "ok" if ok else "failed", "commit": commit,
            "stage": out.get("stage"), "detail": detail, "eval": ev,
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


async def eval_verdict(session_id: str) -> dict:
    """Did this work get WORSE at being Nova? The recorded answer (rail 2).

    Same shape and the same staleness rule as `sandbox_verdict`, for the same
    reason: a score that outlived the commit it was about is worse than no
    score. States are `never` | `stale` | `ok` | `below` | `unmeasured`, and
    only `ok` clears the autonomous landing gate — `unmeasured` is not a pass,
    it is the honest report of a stage that ran and could not measure.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT commit_sha, eval_status, eval_commit, eval_detail, "
            "       eval_scores, eval_at FROM coding_sessions "
            " WHERE id = $1::uuid", session_id)
    if row is None:
        return {"state": "unknown", "detail": "no such session"}
    if not row["eval_status"]:
        return {"state": "never",
                "detail": "the eval floor has never been run on this work"}
    if row["eval_commit"] != row["commit_sha"]:
        return {"state": "stale",
                "detail": (f"the floor was measured on "
                           f"{(row['eval_commit'] or '')[:10]} and the session "
                           f"is now at {(row['commit_sha'] or '')[:10]}")}
    scores = row["eval_scores"]
    if isinstance(scores, str):
        try:
            scores = json.loads(scores)
        except ValueError:
            scores = {}
    return {"state": row["eval_status"], "detail": row["eval_detail"],
            "scores": scores or {},
            "at": row["eval_at"].isoformat() if row["eval_at"] else None}


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
