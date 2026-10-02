"""The MCP servers she can use: the rows, and the one path that changes them (S37a).

A row is an address, its credentials, and what the server said it offers —
never a grant (owner ruling 2026-09-03). The owner adds one on Settings →
Connections and she adds one with mcp_connect; both go through `connect`
(Task 5), which proves the server answers before anything is saved.

Credentials: `token` and the VALUES of `headers` leave this module only inside
a client.Endpoint. `Server.view()` — the one shape routes and tools render —
carries `has_token`, header NAMES and the ORIGIN, never a URL path (a path
can be the secret: ha-mcp authenticates by one).

EVAL TURNS see an OVERLAY instead of the table (`OVERLAY`, a ContextVar the
eval runner sets per case): the servers the case declared, and nothing the
owner connected. Everything here reads and writes the overlay then, and
nothing reaches the database (plan decision P11).
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from collections.abc import Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any
from urllib.parse import urlsplit

from app import governance
from app.mcp import client

logger = logging.getLogger("core")

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
BY_OWNER = "owner"
BY_NOVA = "nova"
# The roster names a server's tools when it has this many or fewer, and gives
# a count otherwise: one 87-tool server must not flood a small model's prompt.
ROSTER_NAMES_UP_TO = 12
MAX_HEADERS = 20
MAX_CREDENTIAL_CHARS = 4096
# The whole connect — discovery or the handshake, then every page of tools —
# must end inside nginx's 60 s read timeout on /api/ (plan decision P15).
CONNECT_BUDGET_S = 45.0
# Headers the client sets itself. Authorization is allowed only when no token
# is given (a server that wants "Token abc" rather than "Bearer abc").
_CLIENT_HEADERS = frozenset(
    {
        "accept",
        "content-type",
        "mcp-protocol-version",
        "mcp-method",
        "mcp-name",
        "mcp-session-id",
        "host",
        "content-length",
    }
)


class ServerError(Exception):
    """Why a server was not connected, removed or read, in words. Nothing was
    written. `reachable` is what the client found, when it got that far."""

    def __init__(self, reason: str, *, reachable: bool | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.reachable = reachable


@dataclass(frozen=True, eq=False, repr=False)
class Server:
    name: str
    url: str
    token: str | None
    headers: Mapping[str, str]
    added_by: str
    protocol: str | None = None
    title: str | None = None
    tools: tuple[dict, ...] = ()
    tools_hash: str | None = None
    tools_fetched_at: datetime | None = None
    tools_ttl_ms: int | None = None
    tools_changed_at: datetime | None = None
    last_ok_at: datetime | None = None
    last_error: str | None = None
    last_error_at: datetime | None = None
    created_at: datetime | None = None

    def __repr__(self) -> str:
        # Credential-free, as Endpoint's hand-written repr is (client.py):
        # never `url` (a path can be the secret), `token` or a header value.
        return f"Server(name={self.name!r}, origin={self.origin!r}, added_by={self.added_by!r})"

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> Server:
        return cls(
            name=row["name"],
            url=row["url"],
            token=row["token"],
            headers=dict(row["headers"] or {}),
            added_by=row["added_by"],
            protocol=row["protocol"],
            title=row["title"],
            tools=tuple(row["tools"] or ()),
            tools_hash=row["tools_hash"],
            tools_fetched_at=row["tools_fetched_at"],
            tools_ttl_ms=row["tools_ttl_ms"],
            tools_changed_at=row["tools_changed_at"],
            last_ok_at=row["last_ok_at"],
            last_error=row["last_error"],
            last_error_at=row["last_error_at"],
            created_at=row["created_at"],
        )

    @property
    def origin(self) -> str:
        # One source (controller ruling F13): the client's own normalization,
        # never a second derivation here. plant() keys transports by this same
        # scheme://host[:port] (client._normalize_origin), so a Server's origin
        # must come from the identical function or the two can disagree.
        return self.endpoint.origin

    @property
    def endpoint(self) -> client.Endpoint:
        return client.Endpoint(
            name=self.name, url=self.url, token=self.token, headers=dict(self.headers)
        )

    @property
    def failing(self) -> bool:
        """Did its last call fail? Only when a failure is newer than the last
        success: a server that failed once and has answered since is not."""
        if self.last_error_at is None:
            return False
        return self.last_ok_at is None or self.last_error_at > self.last_ok_at

    def tools_stale(self, now: datetime) -> bool:
        if self.tools_fetched_at is None:
            return True
        return (now - self.tools_fetched_at).total_seconds() * 1000 >= (self.tools_ttl_ms or 0)

    def view(self) -> dict:
        """The one outward shape: no token, no header value, no URL path."""
        return {
            "name": self.name,
            "title": self.title,
            "origin": self.origin,
            "protocol": self.protocol,
            "added_by": self.added_by,
            "has_token": bool(self.token),
            "header_names": sorted(self.headers),
            "tool_count": len(self.tools),
            "tools": [
                {"name": t.get("name"), "description": t.get("description") or ""}
                for t in self.tools
            ],
            "tools_fetched_at": _iso(self.tools_fetched_at),
            "tools_changed_at": _iso(self.tools_changed_at),
            "last_ok_at": _iso(self.last_ok_at),
            "last_error": self.last_error,
            "last_error_at": _iso(self.last_error_at),
            "failing": self.failing,
            "created_at": _iso(self.created_at),
        }


@dataclass
class Overlay:
    servers: dict[str, Server] = field(default_factory=dict)


OVERLAY: ContextVar[Overlay | None] = ContextVar("mcp_overlay", default=None)

_COLUMNS = (
    "name, url, token, headers, added_by, protocol, title, tools, tools_hash, tools_fetched_at, "
    "tools_ttl_ms, tools_changed_at, last_ok_at, last_error, last_error_at, created_at"
)


async def list_servers(pool) -> list[Server]:
    overlay = OVERLAY.get()
    if overlay is not None:
        return [overlay.servers[name] for name in sorted(overlay.servers)]
    rows = await pool.fetch(f"SELECT {_COLUMNS} FROM mcp_servers ORDER BY name")
    return [Server.from_row(row) for row in rows]


async def get(pool, name: str) -> Server | None:
    overlay = OVERLAY.get()
    if overlay is not None:
        return overlay.servers.get(name)
    row = await pool.fetchrow(f"SELECT {_COLUMNS} FROM mcp_servers WHERE name = $1", name)
    return Server.from_row(row) if row else None


async def record_call(pool, name: str, *, ok: bool, reason: str | None = None) -> None:
    """Stamp the outcome of a call. Fail-open: a row that could not be stamped
    costs the roster's failure clause, never the call's own answer.

    A failure's reason is scrubbed of THIS SERVER's own credential values
    before it is stored: server-supplied text (a 401 body echoing the token
    straight back) reaches `reason` exactly like a transport failure's own
    words, so the credential that could carry comes out here, not at every
    caller."""
    now = datetime.now(UTC)
    overlay = OVERLAY.get()
    if overlay is not None:
        current = overlay.servers.get(name)
        if current is not None:
            overlay.servers[name] = (
                replace(current, last_ok_at=now)
                if ok
                else replace(
                    current,
                    last_error=_scrub(
                        reason or "failed", token=current.token, headers=current.headers
                    ),
                    last_error_at=now,
                )
            )
        return
    try:
        if ok:
            await pool.execute(
                "UPDATE mcp_servers SET last_ok_at = now(), updated_at = now() WHERE name = $1",
                name,
            )
        else:
            row = await pool.fetchrow(
                "SELECT token, headers FROM mcp_servers WHERE name = $1", name
            )
            clean = _scrub(
                reason or "failed",
                token=row["token"] if row else None,
                headers=dict(row["headers"] or {}) if row else {},
            )
            await pool.execute(
                "UPDATE mcp_servers SET last_error = $2, last_error_at = now(), updated_at = now() "
                "WHERE name = $1",
                name,
                clean,
            )
    except Exception:
        logger.exception("mcp: could not stamp the last call on %s", name)


def tools_hash(tools: Sequence[Mapping[str, Any]]) -> str:
    """One digest for what a server offers, independent of the order it lists them."""
    canonical = sorted(
        (
            {
                "name": str(t.get("name")),
                "description": t.get("description") or "",
                "inputSchema": t.get("inputSchema") or {},
                "annotations": t.get("annotations") or {},
            }
            for t in tools
        ),
        key=lambda t: t["name"],
    )
    encoded = json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def diff(
    old: Sequence[Mapping[str, Any]], new: Sequence[Mapping[str, Any]]
) -> dict[str, list[str]]:
    before = {str(t.get("name")): t for t in old}
    after = {str(t.get("name")): t for t in new}
    changed = [
        n for n in after if n in before and tools_hash([after[n]]) != tools_hash([before[n]])
    ]
    return {
        "added": sorted(n for n in after if n not in before),
        "removed": sorted(n for n in before if n not in after),
        "changed": sorted(changed),
    }


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _clip(text: str, limit: int) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _scrub(text: str, *, token: str | None, headers: Mapping[str, str], limit: int = 500) -> str:
    """`text`, with every credential VALUE this endpoint holds — its token and
    the value of each extra header — removed as an exact substring, then
    capped. Server-supplied text (a 401 body that echoes the token straight
    back) reaches a reason exactly like text this client composed itself, so
    every reason this module records or returns runs through this before it
    is stored or raised."""
    scrubbed = str(text)
    for secret in (token, *headers.values()):
        if secret:
            scrubbed = scrubbed.replace(secret, "[redacted]")
    return _clip(scrubbed, limit)


# ── connect, refresh, disconnect (S37a Task 5) ───────────────────────────────


@dataclass(frozen=True)
class Connected:
    server: Server
    previous: Server | None
    rejected: tuple[tuple[str, str], ...]
    notice: str | None


@dataclass(frozen=True)
class Removed:
    server: Server
    notice: str | None


def _validated(
    name: Any, url: Any, token: Any, headers: Any
) -> tuple[str, str, str | None, dict[str, str]]:
    """Everything that can be refused before a byte is sent."""
    name = str(name or "").strip()
    if not NAME_RE.match(name):
        raise ServerError(
            f"{name!r} cannot be a server name: use 2 to 32 lowercase letters, digits, - or _, "
            "starting with a letter or a digit"
        )
    url = str(url or "").strip()
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise ServerError(
            f"that is not an http or https address: {parts.scheme or 'no scheme'}://"
            f"{parts.netloc or '…'}"
        )
    # Closed at the source (deferred from Tasks 2-3): a URL with userinfo
    # carried a credential where only the origin is ever shown, and a
    # malformed or out-of-range port made Endpoint.__repr__ raise rather than
    # name the bad address. Both are refused here, before any probe, so
    # `connect` never reaches the client with either.
    if parts.username is not None or parts.password is not None:
        raise ServerError(
            "that address may not carry a username or password; use the token field instead"
        )
    try:
        parts.port
    except ValueError as exc:
        raise ServerError(f"that address has a bad port ({exc})") from exc
    token = str(token).strip() if token is not None else None
    token = token or None
    if token is not None and (
        len(token) > MAX_CREDENTIAL_CHARS or any(ch in token for ch in " \t\r\n")
    ):
        raise ServerError("the token must be one line with no spaces, at most 4096 characters")
    if headers is not None and not isinstance(headers, Mapping):
        raise ServerError("headers must be an object of header names to values")
    clean: dict[str, str] = {}
    for key, value in (headers or {}).items():
        # The same token-name shape the client itself demands of a header
        # name (ruling F13: one source, never a second copy of the pattern).
        if not isinstance(key, str) or not client._TCHAR.match(key):
            raise ServerError(f"{key!r} is not an HTTP header name")
        lowered = key.lower()
        if lowered in _CLIENT_HEADERS or (lowered == "authorization" and token is not None):
            raise ServerError(f"{key} is set by the client itself and cannot be given here")
        if (
            not isinstance(value, str)
            or "\r" in value
            or "\n" in value
            or len(value) > MAX_CREDENTIAL_CHARS
        ):
            raise ServerError(f"the value of {key} must be one line of at most 4096 characters")
        clean[key] = value
    if len(clean) > MAX_HEADERS:
        raise ServerError(f"at most {MAX_HEADERS} extra headers")
    return name, url, token, clean


async def connect(
    pool, *, name, url, token=None, headers=None, added_by: str, actor: str
) -> Connected:
    """Probe the server and read its tools, then save it — or say why not, and
    save nothing. A name in use is REPLACED (record, never refuse); the ledger
    says what it replaced, and a notice goes to the owner when she replaced
    one he added."""
    name, url, token, clean = _validated(name, url, token, headers)
    endpoint = client.Endpoint(name=name, url=url, token=token, headers=clean)
    try:
        async with asyncio.timeout(CONNECT_BUDGET_S):
            found = await client.probe(endpoint)
            listed = await client.list_tools(endpoint, refresh=True)
    except TimeoutError as exc:
        raise ServerError(
            f"{name} was not connected: it did not finish answering within {CONNECT_BUDGET_S:g} s. "
            "Nothing was saved."
        ) from exc
    except client.ClientError as exc:
        # Server-supplied text can ride in exc.reason (a refusal's own body);
        # scrubbed of this connect's own credentials before it is raised, let
        # alone shown or logged (ruling: every reason the store returns).
        raise ServerError(
            f"{name} was not connected: {_scrub(exc.reason, token=token, headers=clean)}. "
            "Nothing was saved.",
            reachable=exc.reachable,
        ) from exc
    tools = tuple(dict(t) for t in listed.tools)
    now = datetime.now(UTC)
    fresh = Server(
        name=name,
        url=url,
        token=token,
        headers=clean,
        added_by=added_by,
        protocol=found.protocol,
        title=found.title,
        tools=tools,
        tools_hash=tools_hash(tools),
        tools_fetched_at=now,
        tools_ttl_ms=listed.ttl_ms,
        last_ok_at=now,
        created_at=now,
    )
    overlay = OVERLAY.get()
    if overlay is not None:
        previous = overlay.servers.get(name)
        overlay.servers[name] = fresh
        return Connected(fresh, previous, listed.rejected, None)
    async with pool.acquire() as conn, conn.transaction():
        before = await conn.fetchrow(
            f"SELECT {_COLUMNS} FROM mcp_servers WHERE name = $1 FOR UPDATE", name
        )
        row = await conn.fetchrow(
            "INSERT INTO mcp_servers (name, url, token, headers, added_by, protocol, title, tools, "
            "tools_hash, tools_fetched_at, tools_ttl_ms, last_ok_at) "
            "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, now()) "
            "ON CONFLICT (name) DO UPDATE SET url = EXCLUDED.url, token = EXCLUDED.token, "
            "headers = EXCLUDED.headers, added_by = EXCLUDED.added_by, "
            "protocol = EXCLUDED.protocol, "
            "title = EXCLUDED.title, tools = EXCLUDED.tools, tools_hash = EXCLUDED.tools_hash, "
            "tools_fetched_at = EXCLUDED.tools_fetched_at, tools_ttl_ms = EXCLUDED.tools_ttl_ms, "
            "tools_changed_at = NULL, last_ok_at = EXCLUDED.last_ok_at, last_error = NULL, "
            f"last_error_at = NULL, updated_at = now() RETURNING {_COLUMNS}",
            name,
            url,
            token,
            clean,
            added_by,
            found.protocol,
            found.title,
            list(tools),
            fresh.tools_hash,
            listed.ttl_ms,
        )
        previous = Server.from_row(before) if before else None
        meta: dict[str, Any] = {
            "name": name,
            "origin": fresh.origin,
            "added_by": added_by,
            "protocol": found.protocol,
            "tool_count": len(tools),
        }
        if previous is not None:
            meta["replaced"] = {"origin": previous.origin, "added_by": previous.added_by}
        event_id = await governance.record_event(
            conn, kind=governance.MCP_SERVER_CONNECTED, actor=actor, meta=meta
        )
    if previous is not None:
        client.forget(previous.endpoint)
    notice = await _notice(pool, event_id, governance.MCP_SERVER_CONNECTED, meta)
    return Connected(Server.from_row(row), previous, listed.rejected, notice)


async def disconnect(pool, *, name: str, by: str, actor: str) -> Removed:
    overlay = OVERLAY.get()
    if overlay is not None:
        gone = overlay.servers.pop(name, None)
        if gone is None:
            raise ServerError(await no_such_server(pool, name))
        return Removed(gone, None)
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            f"DELETE FROM mcp_servers WHERE name = $1 RETURNING {_COLUMNS}", name
        )
        if row is None:
            raise ServerError(await no_such_server(pool, name))
        gone = Server.from_row(row)
        meta = {"name": name, "origin": gone.origin, "by": by, "previous_added_by": gone.added_by}
        event_id = await governance.record_event(
            conn, kind=governance.MCP_SERVER_REMOVED, actor=actor, meta=meta
        )
    client.forget(gone.endpoint)
    notice = await _notice(pool, event_id, governance.MCP_SERVER_REMOVED, meta)
    return Removed(gone, notice)


async def refresh_tools(pool, server: Server, *, actor: str, probe: bool = False) -> Server:
    """Read the server's tools again (and, with `probe`, its era and title).
    A changed list replaces the old one at once and is recorded — never a
    freeze until someone approves it (v3's shape: an approval). ClientError
    propagates: the caller states it and stamps the failure."""
    found = await client.probe(server.endpoint) if probe else None
    listed = await client.list_tools(server.endpoint, refresh=True)
    tools = tuple(dict(t) for t in listed.tools)
    new_hash = tools_hash(tools)
    now = datetime.now(UTC)
    overlay = OVERLAY.get()
    if overlay is not None:
        updated = replace(
            server,
            tools=tools,
            tools_hash=new_hash,
            tools_fetched_at=now,
            tools_ttl_ms=listed.ttl_ms,
            last_ok_at=now,
            protocol=found.protocol if found else server.protocol,
            title=found.title if found and found.title else server.title,
        )
        overlay.servers[server.name] = updated
        return updated
    change = diff(server.tools, tools) if new_hash != server.tools_hash else None
    event_id = None
    async with pool.acquire() as conn, conn.transaction():
        row = await conn.fetchrow(
            "UPDATE mcp_servers SET tools = $2, tools_hash = $3, tools_fetched_at = now(), "
            "tools_ttl_ms = $4, "
            "tools_changed_at = CASE WHEN $5 THEN now() ELSE tools_changed_at END, "
            "protocol = COALESCE($6, protocol), title = COALESCE($7, title), "
            f"last_ok_at = now(), updated_at = now() WHERE name = $1 RETURNING {_COLUMNS}",
            server.name,
            list(tools),
            new_hash,
            listed.ttl_ms,
            change is not None,
            found.protocol if found else None,
            found.title if found else None,
        )
        if row is None:
            raise ServerError(f"{server.name} was removed while its tools were being read")
        if change is not None:
            event_id = await governance.record_event(
                conn,
                kind=governance.MCP_TOOLS_CHANGED,
                actor=actor,
                meta={"name": server.name, **change},
            )
    if change is not None:
        await _notice(pool, event_id, governance.MCP_TOOLS_CHANGED, {"name": server.name, **change})
    return Server.from_row(row)


async def _notice(pool, event_id: Any, kind: str, meta: dict) -> str | None:
    """File the notice for a change the owner did not make, if this is one.
    Returns the sentence her reply and the route carry — also when the notice
    could NOT be filed, which is said rather than left out.

    `notices` and `app.checks.mcp` are imported HERE, not at module top
    (ruling F1). `app.checks`'s own import pulls in `app.checks.money` ->
    `app.agents` -> `app.tools`, and `app/tools/mcp.py` (Task 7) imports
    THIS module inside its executors — a module-level import here would
    close that into a cycle: `import app.main` (uvicorn's entry point)
    would crash with a partially initialized `app.beats`, while every test
    stayed green because conftest imports `app.chat` first. `governance`
    carries no such import and stays at the top of the module."""
    from app import notices
    from app.checks import mcp as mcp_checks

    finding = mcp_checks.finding_for(event_id, kind, meta)
    if finding is None:
        return None
    try:
        await notices.record(
            pool, finding, check_name=mcp_checks.CHANGES, turn_id=None, firing_id=None
        )
    except Exception as exc:
        logger.exception("mcp: the notice for governance event %s could not be filed", event_id)
        return (
            f"The notice for the owner could not be filed ({type(exc).__name__}); the change is "
            "in the governance ledger."
        )
    return "A notice about this is in the owner's Inbox."


async def no_such_server(pool, name: str) -> str:
    """The one sentence for 'that name is not connected', naming what IS —
    the single source (ruling F13) so a tool (Task 7) and `disconnect` never
    say this two different ways."""
    known = [s.name for s in await list_servers(pool)]
    listed = ", ".join(known) if known else "none is connected"
    return f"there is no connected MCP server named {name!r} — connected: {listed}"
