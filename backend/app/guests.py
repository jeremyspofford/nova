"""Time-boxed guest sessions — a second identity the backend can hold.

docs/plans/public-access-and-guests.md, section 3. Jeremy, 2026-08-07:

    "grant guest access over a small amount of time with specific llms to
     test out or whatever"
    "chat + a sandbox memory that gets wiped when I remove the guest access
     for that user (ie: delete user or revoke whatever grant I've given them)
     + safe tools."

Everything here is mechanical, because every property in that sentence is one
a prompt cannot hold:

* **Time box.** `resolve()` reads `revoked_at IS NULL AND expires_at > now()`
  in the WHERE clause. An expired token does not match a row at all — there is
  no branch that could be got wrong, and no clock the caller supplies.
* **Specific models.** `enforce_model()` refuses a resolved model that is not
  in the session's `allowed_models`, and it is called from the runner one line
  before the request is built — after every fallback, reroute and downgrade has
  had its say. A guest's prompt saying "use model X" reaches the model, not the
  gate.
* **Sandbox memory.** `store_for()` returns an `OkfMemory` rooted OUTSIDE
  `data/memory` (memory.py's `_refuse_overlap` refuses anything else), bound
  for the turn with `memory.sandbox()`. The binding is a contextvar, so every
  tool that reaches `memory` — including the fire-and-forget writes tasks make
  after the turn — lands in the guest's namespace. There is no "flag set but
  store missing" state: the flag IS the instance.
* **Wiped on revoke.** `wipe_memory()` uses `shutil.rmtree` WITHOUT
  `ignore_errors`, then RE-READS the directory and raises `WipeFailed` if it is
  still there. CLAUDE.md names `rmtree(ignore_errors=True)` as a real defect
  from this repo: a wipe that cannot prove it happened must fail loudly, not
  return a cheerful dict.

The route gating lives here too (`guest_ok`, `route_is_guest_ok`) so that
main.py's middleware and the routers share ONE definition of "a guest may
reach this". It is default-deny: a route that says nothing is denied, so a
route added next month is guest-denied until somebody opts it in. An allowlist
that fails open is worthless — the plan's own warning is that a guest token
reaching `GET /api/v1/auth/token` IS an admin token.
"""

from __future__ import annotations

import hashlib
import logging
import secrets
import shutil
import uuid as uuid_mod
from pathlib import Path
from typing import Optional

from app import db
from app.config import settings

log = logging.getLogger(__name__)

#: Raw guest tokens carry this prefix. It is not a secret and it is not a
#: control — it exists so `auth_middleware` can tell "this caller is claiming
#: to be a guest" from "this caller got the admin token wrong", and so a guest
#: token presented from localhost is NEVER silently upgraded to operator by
#: the trusted-localhost path. The prefix routes; the hash lookup decides.
TOKEN_PREFIX = "novaguest_"

ROLE_OPERATOR = "operator"
ROLE_GUEST = "guest"

_FIELDS = ("id", "label", "created_by", "created_at", "expires_at",
           "revoked_at", "last_seen", "allowed_models", "selected_model")


class WipeFailed(RuntimeError):
    """A guest's memory namespace survived its own deletion."""


class ModelNotAllowed(PermissionError):
    """A guest turn resolved to a model outside the session's allowlist."""


# ── the credential ────────────────────────────────────────────────────────

def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def looks_like_guest_token(raw: str) -> bool:
    return raw.startswith(TOKEN_PREFIX)


def _row(r) -> dict:
    d = {k: r[k] for k in _FIELDS}
    d["id"] = str(d["id"])
    d["allowed_models"] = list(d["allowed_models"] or ())
    for k in ("created_at", "expires_at", "revoked_at", "last_seen"):
        d[k] = str(d[k]) if d[k] else None
    return d


async def mint(label: str, *, minutes: int, allowed_models: list[str],
               created_by: str = ROLE_OPERATOR) -> dict:
    """Create a session and return it WITH the raw token, once.

    The raw token is generated here and hashed on the way to the database, so
    the only copy that ever existed off this function's stack is the one the
    operator is about to be shown. There is no way to read it back.
    """
    label = (label or "").strip()
    if not label:
        raise ValueError("a guest session needs a label — you have to be able "
                         "to tell them apart when you revoke one")
    models = [m.strip() for m in (allowed_models or []) if m and m.strip()]
    if not models:
        raise ValueError("name at least one model this guest may use — an "
                         "empty allowlist is an unbounded session, not a "
                         "restricted one")
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        raise ValueError("minutes must be a whole number")
    if minutes <= 0:
        raise ValueError("a guest session has to expire; minutes must be > 0")

    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO guest_sessions (token_hash, label, created_by, "
            "expires_at, allowed_models, selected_model) "
            "VALUES ($1, $2, $3, now() + ($4 || ' minutes')::interval, "
            "        $5::text[], ($5::text[])[1]) "
            "RETURNING " + ", ".join(_FIELDS),
            hash_token(raw), label, created_by, str(minutes), models)
    out = _row(row)
    out["token"] = raw
    log.info("guest session minted: %s (%s), %d min, models=%s",
             out["id"], label, minutes, ",".join(models))
    return out


async def resolve(raw: str) -> Optional[dict]:
    """The LIVE session this token names, or None.

    The time box is in the WHERE clause, not in a branch after it: an expired
    or revoked token simply matches no row. Nothing the caller passes can
    move `now()`.
    """
    if not raw or not looks_like_guest_token(raw):
        return None
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT " + ", ".join(_FIELDS) + " FROM guest_sessions "
            "WHERE token_hash = $1 AND revoked_at IS NULL "
            "  AND expires_at > now()", hash_token(raw))
    return _row(row) if row else None


async def touch(guest_id: str) -> None:
    """Record that this session was used. Never raises — a failed bookkeeping
    write must not 500 a guest's turn."""
    try:
        async with db.acquire() as conn:
            await conn.execute(
                "UPDATE guest_sessions SET last_seen = now() WHERE id = $1",
                uuid_mod.UUID(str(guest_id)))
    except Exception:   # noqa: BLE001
        log.debug("guest last_seen update failed", exc_info=True)


async def list_all() -> list[dict]:
    async with db.acquire() as conn:
        rows = await conn.fetch(
            "SELECT " + ", ".join(_FIELDS) + " FROM guest_sessions "
            "ORDER BY created_at DESC")
    out = []
    for r in rows:
        d = _row(r)
        d["live"] = d["revoked_at"] is None
        out.append(d)
    return out


async def get(guest_id: str) -> Optional[dict]:
    try:
        gid = uuid_mod.UUID(str(guest_id))
    except (ValueError, AttributeError):
        return None
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT " + ", ".join(_FIELDS) + " FROM guest_sessions WHERE id = $1",
            gid)
    return _row(row) if row else None


async def select_model(guest_id: str, model: str) -> dict:
    """Point this session at one of ITS models.

    `AND $2 = ANY (allowed_models)` is the whole control: a model outside the
    allowlist updates zero rows, and zero rows is a refusal — not a fallback
    to the first allowed one, which would let a guest name anything and still
    get a working turn while believing they had switched.
    """
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE guest_sessions SET selected_model = $2 WHERE id = $1 "
            "AND $2 = ANY (allowed_models) AND revoked_at IS NULL "
            "AND expires_at > now() "
            "RETURNING " + ", ".join(_FIELDS),
            uuid_mod.UUID(str(guest_id)), str(model))
    if not row:
        raise ModelNotAllowed(
            f"{model!r} is not one of the models this guest session may use")
    return _row(row)


def session_model(guest: dict) -> str:
    """Which model this guest's next turn runs on.

    `selected_model` when set, else the first allowed one. Never a global
    default and never the agent's own model: a guest session that silently
    ran on whatever `main` happens to point at would make the allowlist
    decorative.
    """
    chosen = (guest.get("selected_model") or "").strip()
    allowed = list(guest.get("allowed_models") or ())
    if chosen and chosen in allowed:
        return chosen
    if not allowed:
        # unreachable through mint() and refused by the table CHECK; if it
        # ever happens the honest outcome is a dead turn, not a free one
        raise ModelNotAllowed("this guest session names no models at all")
    return allowed[0]


def enforce_model(allowed: Optional[list[str]], model: str) -> None:
    """Refuse a model outside a guest's allowlist. No-op when there is none.

    Called from the runner immediately before the request is built, so it sees
    the model that will ACTUALLY carry the round — after `effective_model`,
    after a fallback link, after a mid-turn reroute. Checking at the top of
    the turn would check the model nobody objected to.
    """
    if allowed is None:
        return
    if model not in set(allowed):
        raise ModelNotAllowed(
            f"this guest session may use {', '.join(sorted(allowed))} — "
            f"{model!r} is not one of them")


# ── the sandbox namespace ─────────────────────────────────────────────────

def memory_root(guest_id: str) -> Path:
    """Where this guest's notes live.

    A SIBLING of the operator's memory dir, never a child. Two reasons, both
    mechanical rather than tidy:

    * `OkfMemory.__init__` calls `_refuse_overlap`, which raises if a sandbox
      root is inside (or contains) the real memory dir. A child directory
      would make every guest turn a crash — which is the correct failure, but
      the point is it can never be anything else.
    * `wipe_memory` rmtree's this path. A path that could resolve inside
      `data/memory` would put a delete of Jeremy's entire memory one bad id
      away, so the containment is asserted here, on the way out, rather than
      trusted from the caller.
    """
    real = Path(settings.okf_memory_dir).resolve()
    gid = str(uuid_mod.UUID(str(guest_id)))       # refuses anything path-shaped
    root = (real.parent / "guest-memory" / gid).resolve()
    if root == real or root.is_relative_to(real) or real.is_relative_to(root):
        raise ValueError(
            f"refusing a guest namespace at {root}: it overlaps the operator's "
            f"memory at {real}")
    return root


#: One store per guest per process. Rebuilding the BM25 index on every turn
#: would be wasted work; keeping the instance also means `wipe_memory` has
#: something to DROP, so a wiped guest cannot keep answering out of an index
#: whose files are gone.
_STORES: dict[str, object] = {}


async def store_for(guest: dict):
    """This guest's own `OkfMemory`, indexed and ready to bind."""
    from app.memory.memory import OkfMemory
    gid = str(guest["id"])
    mem = _STORES.get(gid)
    if mem is None:
        root = memory_root(gid)
        root.mkdir(parents=True, exist_ok=True)
        mem = OkfMemory(base_dir=str(root))
        await mem.startup()
        _STORES[gid] = mem
    return mem


def wipe_memory(guest_id: str) -> dict:
    """Destroy this guest's namespace and PROVE it is gone.

    No `ignore_errors`. CLAUDE.md names `rmtree(ignore_errors=True)` as one of
    this repo's real defects — it swallows the reason, so a wipe that left the
    files in place reported exactly like one that worked. Here the tree is
    removed, the directory is re-read, and a survivor raises. The caller turns
    that into a 500 the operator can see; the session is already revoked by
    then, so the failure direction is "access is dead but the disk still has
    notes on it", which is the one worth shouting about.
    """
    root = memory_root(guest_id)
    _STORES.pop(str(guest_id), None)
    if not root.exists():
        return {"wiped": False, "path": str(root),
                "reason": "this guest never wrote anything — no namespace on disk"}
    shutil.rmtree(root)
    if root.exists():                      # the verification, not a formality
        raise WipeFailed(
            f"{root} still exists after rmtree — this guest's memory was NOT "
            f"wiped. Their access is revoked, but the notes are still on disk.")
    return {"wiped": True, "path": str(root)}


async def revoke(guest_id: str) -> dict:
    """Kill the credential first, then wipe. Order is the safety argument.

    If the wipe raises, access has already stopped — the operator gets a loud
    failure about files on disk, not a live session they believed was dead.
    """
    gid = uuid_mod.UUID(str(guest_id))
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "UPDATE guest_sessions SET revoked_at = coalesce(revoked_at, now()) "
            "WHERE id = $1 RETURNING " + ", ".join(_FIELDS), gid)
    if not row:
        return {}
    out = _row(row)
    out["memory"] = wipe_memory(gid)
    return out


async def delete(guest_id: str) -> dict:
    """Remove the session entirely: row, conversation (FK cascade), and files.

    The conversation cascade is why `conversations.guest_id` has
    `ON DELETE CASCADE` — "delete user" in Jeremy's sentence means what they
    said goes too, not only what they remembered.
    """
    gid = uuid_mod.UUID(str(guest_id))
    wipe = wipe_memory(gid)               # files first; a failure aborts here
    async with db.acquire() as conn:
        deleted = await conn.fetchval(
            "DELETE FROM guest_sessions WHERE id = $1 RETURNING id", gid)
    if deleted is None:
        raise LookupError(f"no guest session {guest_id}")
    return {"id": str(gid), "memory": wipe}


# ── the guest's chat ──────────────────────────────────────────────────────

async def conversation_for(guest: dict) -> dict:
    """This guest's own conversation row, created on first use.

    Calls the operator's own accessor FIRST, deliberately. Migration 118 pins
    guest rows to `created_at = -infinity` so "newest row wins" can never
    return one — but that is only true while at least one operator row exists.
    Guaranteeing it here means the very first guest on a fresh install cannot
    become the operator's active conversation.
    """
    from app import conversations
    await conversations.get_or_create_active_conversation()
    gid = uuid_mod.UUID(str(guest["id"]))
    async with db.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, title, summary, summary_upto, cleared_at "
            "FROM conversations WHERE guest_id = $1", gid)
        if row is None:
            row = await conn.fetchrow(
                "INSERT INTO conversations (title, guest_id) VALUES ($1, $2) "
                "RETURNING id, title, summary, summary_upto, cleared_at",
                f"Guest: {guest.get('label') or 'unnamed'}", gid)
    return {"id": str(row["id"]), "title": row["title"],
            "summary": row["summary"],
            "summary_upto": str(row["summary_upto"]) if row["summary_upto"] else None,
            "cleared_at": str(row["cleared_at"]) if row["cleared_at"] else None}


async def owns_conversation(guest: dict, conversation_id: str) -> bool:
    """Is this conversation the guest's own? Asked of the DATABASE.

    The guest UI fetches its history by id, and an id is something a caller
    chooses. Without this, a guest could read the operator's entire chat by
    pasting his conversation id into the URL — the same class of hole as the
    route gating, one layer in.
    """
    try:
        cid = uuid_mod.UUID(str(conversation_id))
        gid = uuid_mod.UUID(str(guest["id"]))
    except (ValueError, AttributeError, KeyError):
        return False
    async with db.acquire() as conn:
        return bool(await conn.fetchval(
            "SELECT 1 FROM conversations WHERE id = $1 AND guest_id = $2",
            cid, gid))


# ── route gating: default-deny ────────────────────────────────────────────

#: The attribute a marked endpoint carries. Read off the resolved route in
#: `route_is_guest_ok`, so the marker and the check cannot drift into two
#: lists that disagree — there is only ever one list, and it is the code.
_MARK = "__nova_guest_ok__"


def guest_ok(fn):
    """Mark an endpoint as reachable by a guest token.

    Everything unmarked is refused. That is the whole design: the plan's
    warning is that a guest branch in the middleware without route gating
    hands guests `GET /api/v1/auth/token`, which returns the admin token, and
    `POST /api/v1/secrets/{name}/reveal`. Neither of those is marked, and
    neither is anything anyone writes tomorrow.
    """
    setattr(fn, _MARK, True)
    return fn


def endpoint_is_guest_ok(endpoint) -> bool:
    return bool(getattr(endpoint, _MARK, False))


def iter_concrete_routes(routes, prefix: str = "", depth: int = 0):
    """Every real endpoint under `routes`, as (mount_prefix, route).

    FastAPI 0.140+ does not flatten `include_router` any more: `app.router.
    routes` holds `_IncludedRouter` wrappers whose `matches()` answers FULL
    with no endpoint attached, so the obvious "iterate app.router.routes and
    read `.endpoint`" resolves NOTHING. Measured here on fastapi 0.141.1 —
    five wrappers, 127 real routes behind the first of them.

    Descends by way of `original_router` when it is there, composing
    `include_context.prefix` on the way down, and falls back to a plain
    `.routes` attribute (a Mount) otherwise. Bounded depth, because a router
    graph that cycles must not hang a request.
    """
    if depth > 8:
        return
    for route in routes:
        wrapper = getattr(route, "original_router", None)
        if wrapper is not None:
            ctx = getattr(route, "include_context", None)
            yield from iter_concrete_routes(
                wrapper.routes, prefix + str(getattr(ctx, "prefix", "") or ""),
                depth + 1)
        elif getattr(route, "endpoint", None) is not None:
            yield prefix, route
        elif hasattr(route, "routes"):
            yield from iter_concrete_routes(
                route.routes, prefix + str(getattr(route, "path", "") or ""),
                depth + 1)


def route_is_guest_ok(routes, scope) -> bool:
    """Would a guest be allowed to call the route this request resolves to?

    Matched against the MARKED routes only, and that is the safety argument
    rather than an optimisation. Resolving "which route is this?" in general
    means reimplementing FastAPI's router, and any bug in that would silently
    decide a guest's permissions. Asking instead "does this request match one
    of the handful of routes somebody opened?" fails CLOSED in every failure
    mode: a wrapper shape this walker does not understand, a prefix it cannot
    compose, a version bump — each one loses marked routes and refuses the
    guest, which is visible the moment anyone uses a guest link, rather than
    quietly granting one.

    Only a FULL match counts. A partial match is a path whose METHOD does not
    match (a 405), and "someone may GET this" is not "someone may DELETE it".
    """
    from starlette.routing import Match
    for prefix, route in iter_concrete_routes(routes):
        if not endpoint_is_guest_ok(route.endpoint):
            continue
        path = scope.get("path", "")
        if prefix:
            if not path.startswith(prefix):
                continue
            path = path[len(prefix):] or "/"
        try:
            match, _child = route.matches({**scope, "path": path})
        except Exception:   # noqa: BLE001 — a route that cannot judge is a deny
            continue
        if match == Match.FULL:
            return True
    return False
