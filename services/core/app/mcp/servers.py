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
from urllib.parse import urlsplit, urlunsplit

import asyncpg
import httpx

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


async def record_call(pool, server: Server, *, ok: bool, reason: str | None = None) -> None:
    """Stamp the outcome of a call made with THIS server's own credentials
    and endpoint (ruling T5-E) — never whatever the row currently holds. A
    failure's reason is scrubbed with the credentials the call actually
    used, and the UPDATE's WHERE clause matches the row's endpoint too, so a
    server re-pointed between the call and this stamp is never credited or
    blamed for an outcome that was never actually its own. Fail-open: a row
    that could not be stamped costs the roster's failure clause, never the
    call's own answer."""
    now = datetime.now(UTC)
    overlay = OVERLAY.get()
    if overlay is not None:
        current = overlay.servers.get(server.name)
        if current is not None and (current.url, current.token, current.headers) == (
            server.url,
            server.token,
            server.headers,
        ):
            overlay.servers[server.name] = (
                replace(current, last_ok_at=now)
                if ok
                else replace(
                    current,
                    last_error=_scrub(
                        reason or "failed", token=server.token, headers=server.headers
                    ),
                    last_error_at=now,
                )
            )
        return
    try:
        if ok:
            await pool.execute(
                "UPDATE mcp_servers SET last_ok_at = now(), updated_at = now() "
                "WHERE name = $1 AND url = $2 AND token IS NOT DISTINCT FROM $3 "
                "AND headers = $4::jsonb",
                server.name,
                server.url,
                server.token,
                server.headers,
            )
        else:
            clean = _scrub(reason or "failed", token=server.token, headers=server.headers)
            await pool.execute(
                "UPDATE mcp_servers SET last_error = $5, last_error_at = now(), updated_at = now() "
                "WHERE name = $1 AND url = $2 AND token IS NOT DISTINCT FROM $3 "
                "AND headers = $4::jsonb",
                server.name,
                server.url,
                server.token,
                server.headers,
                clean,
            )
    except asyncpg.PostgresError as exc:
        _log_pg_refused("record_call", exc)
    except Exception:
        logger.exception("mcp: could not stamp the last call on %s", server.name)


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
    """`text`, scrubbed of every credential value this endpoint holds, then
    capped. A THIN SECOND PASS (ruling T5-A): the client already scrubs server
    text at its own decode boundary (`client.scrub_credentials`), so anything
    reaching here from a `ClientError.reason` is already clean — this exists
    for reasons THIS module composes itself from a row's own stored
    credentials (`record_call`) and as defence in depth everywhere else,
    built from the SAME candidate list (`client.credential_candidates`,
    ruling F13) rather than a second copy of what counts as a credential."""
    return _clip(client._scrub_text(str(text), client.credential_candidates(token, headers)), limit)


# ── connect, refresh, disconnect (S37a Task 5) ───────────────────────────────


def _pg_refused(exc: asyncpg.PostgresError) -> ServerError:
    """A ServerError naming only the SQLSTATE, and the constraint when there
    is one (ruling T5-C) — never `str(exc)`: a CHECK violation's own DETAIL
    text quotes the whole failing row, credentials included."""
    if exc.constraint_name:
        return ServerError(f"the database refused the row ({exc.constraint_name})")
    return ServerError(f"the database refused the row (SQLSTATE {exc.sqlstate or 'unknown'})")


def _log_pg_refused(where: str, exc: asyncpg.PostgresError) -> None:
    """The log line for a refused transaction, carrying only the two safe
    fields (ruling T5-C) — never `logger.exception`, whose traceback would
    carry asyncpg's own DETAIL text, and never `str(exc)`."""
    logger.error(
        "mcp: %s: the database refused a row — sqlstate=%s constraint=%s",
        where,
        exc.sqlstate,
        exc.constraint_name,
    )


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
    """Everything that can be refused before a byte is sent.

    Ruling T5-D (and its fix-round-2 tightening, ruling D): NO refusal here
    echoes any part of the address — the SCHEME included, since a
    scheme-less paste puts a credential where the scheme goes
    (`Ghp0123456789abcdefABCDEF:x@gh.mcp.invalid/mcp` used to be refused
    with the GitHub-shaped token quoted as "the scheme"). Userinfo is
    refused FIRST, before the scheme is even read, so a URL that is both the
    wrong scheme and carries userinfo is never echoed via the scheme
    refusal either. `urlsplit` itself raises `ValueError` for some
    malformed netlocs (an unbalanced `[`, a bracketed value that is not an
    IP literal, or one invalid under NFKC normalization — ruling F, whose
    OWN exception text can quote a password) and httpx raises its own
    `InvalidURL` for a few shapes `urlsplit` accepts but silently cleans (a
    control character embedded in the URL is STRIPPED by `urlsplit`, so
    checking the parsed result would miss it — this checks the raw string
    first); every one of those becomes the same stated, address-free
    refusal — raised only after its own `except` has fully exited (ruling
    F): `from None` alone clears `__cause__`, never `__context__`, which
    Python sets to whatever is "currently being handled" at the `raise`
    itself regardless.

    Ruling E: a host that is syntactically fine to `urlsplit` can still be
    one httpx/idna refuse once something actually tries to USE it — an
    invalid punycode A-label (`xn--.invalid`) raises `idna.IDNAError` only
    when `.host` is read, not at `httpx.URL(url)` construction, and a
    bidi-invalid or otherwise malformed Unicode host raises `httpx.
    InvalidURL`; both do this from deep inside the real connection path, so
    `connect`'s `except TimeoutError`/`except ClientError` never catches
    them and they used to reach the probe raw. Built and checked here,
    before any network attempt."""
    name = str(name or "").strip()
    if not NAME_RE.match(name):
        raise ServerError(
            f"{name!r} cannot be a server name: use 2 to 32 lowercase letters, digits, - or _, "
            "starting with a letter or a digit"
        )
    url = str(url or "").strip()
    if any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in url):
        raise ServerError("that is not a usable http or https address")
    parts = None
    try:
        parts = urlsplit(url)
    except ValueError:
        pass
    if parts is None:
        raise ServerError("that is not a usable http or https address")
    # Userinfo first (ruling T5-D), before the scheme is named in any way.
    if parts.username is not None or parts.password is not None:
        raise ServerError(
            "that address may not carry a username or password; use the token field instead"
        )
    if parts.scheme not in ("http", "https"):
        # Ruling D: not even the scheme word is echoed — it can itself be a
        # credential a scheme-less paste pushed into that position.
        raise ServerError("that is not an http or https address")
    try:
        port = parts.port
    except ValueError:
        port = -1  # out of range below; never echoes urlsplit's own exception text
    if port is not None and not (1 <= port <= 65535):
        raise ServerError("that address has a port that is not a number from 1 to 65535")
    host = parts.hostname
    if not host:
        raise ServerError("that is not a usable http or https address")
    # Closed at the source (Important 2a): migration 038's `url ~
    # '^https?://…'` CHECK is case-sensitive, so an untouched `Https://` or
    # `HTTP://HOST` passed this validation, passed the probe, and only then
    # hit the database — whose CheckViolationError.DETAIL quotes the whole
    # failing row, token and header values included. `.scheme`/`.hostname`
    # are already lower-cased by `urlsplit`; only the netloc is rebuilt —
    # the path, query and fragment are kept exactly as given (a path can be
    # the secret: ha-mcp authenticates by one).
    netloc = f"[{host}]" if ":" in host else host
    if port is not None:
        netloc = f"{netloc}:{port}"
    url = urlunsplit((parts.scheme, netloc, parts.path, parts.query, parts.fragment))
    # Ruling E: build the URL the client will actually send and let it fail
    # the same way THAT would — httpx/idna re-validate and re-encode the
    # host lazily, on ACCESS, never at `httpx.URL(url)` construction alone,
    # so this must read `.host` to find out.
    usable = True
    try:
        _ = httpx.URL(url).host
    except (httpx.InvalidURL, ValueError):
        usable = False
    if not usable:
        raise ServerError("that is not a usable http or https address")
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
        # name (ruling F13: one source, never a second copy of the pattern),
        # anchored at both ends (ruling M6: `_TCHAR`'s `$` matches before a
        # trailing newline, so `.fullmatch` is the single fix at every use).
        if not isinstance(key, str) or not client._TCHAR.fullmatch(key):
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
    not_reached: ServerError | None = None
    try:
        async with asyncio.timeout(CONNECT_BUDGET_S):
            found = await client.probe(endpoint)
            listed = await client.list_tools(endpoint, refresh=True)
    except TimeoutError:
        not_reached = ServerError(
            f"{name} was not connected: it did not finish answering within {CONNECT_BUDGET_S:g} s. "
            "Nothing was saved."
        )
    except client.ClientError as exc:
        # The client already scrubs server text at its own decode boundary
        # (ruling T5-A), so exc.reason should already be clean; this is the
        # store's second pass regardless (defence in depth). Built here but
        # not RAISED until after this `except` has fully exited, same as the
        # PostgresError handlers below: `from None` alone (ruling M3) only
        # clears `__cause__` — Python still sets a raised exception's
        # `__context__` to whatever is currently being handled, so without
        # this, exc (even though its own text is already scrubbed) would sit
        # one attribute away from any future caller that reads it.
        not_reached = ServerError(
            f"{name} was not connected: {_scrub(exc.reason, token=token, headers=clean)}. "
            "Nothing was saved.",
            reachable=exc.reachable,
        )
    if not_reached is not None:
        raise not_reached
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
    pg_refused: ServerError | None = None
    try:
        async with pool.acquire() as conn, conn.transaction():
            # An advisory, transaction-scoped lock keyed on the NAME (ruling
            # M5): a name that does not exist yet has no row for `FOR UPDATE`
            # below to lock, so two connects of a brand-new name could both
            # read "no previous row" and race past each other — nova
            # replacing the owner's just-inserted server would then record no
            # `replaced` and file no notice. This serializes the two on the
            # name itself, so the second always sees the first's row.
            await conn.execute(
                "SELECT pg_advisory_xact_lock(hashtextextended('mcp_servers:' || $1, 0))", name
            )
            before = await conn.fetchrow(
                f"SELECT {_COLUMNS} FROM mcp_servers WHERE name = $1 FOR UPDATE", name
            )
            row = await conn.fetchrow(
                "INSERT INTO mcp_servers (name, url, token, headers, added_by, protocol, title, "
                "tools, tools_hash, tools_fetched_at, tools_ttl_ms, last_ok_at) "
                "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10, now()) "
                "ON CONFLICT (name) DO UPDATE SET url = EXCLUDED.url, token = EXCLUDED.token, "
                "headers = EXCLUDED.headers, added_by = EXCLUDED.added_by, "
                "protocol = EXCLUDED.protocol, "
                "title = EXCLUDED.title, tools = EXCLUDED.tools, tools_hash = EXCLUDED.tools_hash, "
                "tools_fetched_at = EXCLUDED.tools_fetched_at, "
                "tools_ttl_ms = EXCLUDED.tools_ttl_ms, "
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
    except asyncpg.PostgresError as exc:
        # The refused ServerError is built and LOGGED here, but not raised
        # until after this `except` has fully exited (ruling T5-C): Python
        # sets a raised exception's `__context__` to whatever is "currently
        # being handled" at the moment of the `raise`, REGARDLESS of `from
        # None` — that only clears `__cause__` and hides the chain from a
        # DEFAULT traceback print, not from `exc.__context__` itself, which
        # any code (or a logger that does not honour `__suppress_context__`)
        # can still read. Raising once we are back in plain code, with no
        # exception being handled, is the only way `__context__` ends up
        # None rather than this PostgresError and its DETAIL text.
        _log_pg_refused("connect", exc)
        pg_refused = _pg_refused(exc)
    if pg_refused is not None:
        raise pg_refused
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
    # `not_found` and `pg_refused` are read AFTER the `async with` below has
    # fully exited, and the sentence or the error is only raised then —
    # never from inside the `except` (ruling M7: `no_such_server`'s own
    # `list_servers` call would acquire a SECOND pool connection while this
    # one's transaction still held the first; ruling T5-C: raising while a
    # PostgresError is still "being handled" sets `__context__` to it
    # regardless of `from None`, which only clears `__cause__`).
    not_found = False
    pg_refused: ServerError | None = None
    try:
        async with pool.acquire() as conn, conn.transaction():
            row = await conn.fetchrow(
                f"DELETE FROM mcp_servers WHERE name = $1 RETURNING {_COLUMNS}", name
            )
            if row is None:
                not_found = True
            else:
                gone = Server.from_row(row)
                meta = {
                    "name": name,
                    "origin": gone.origin,
                    "by": by,
                    "previous_added_by": gone.added_by,
                }
                event_id = await governance.record_event(
                    conn, kind=governance.MCP_SERVER_REMOVED, actor=actor, meta=meta
                )
    except asyncpg.PostgresError as exc:
        _log_pg_refused("disconnect", exc)
        pg_refused = _pg_refused(exc)
    if not_found:
        raise ServerError(await no_such_server(pool, name))
    if pg_refused is not None:
        raise pg_refused
    client.forget(gone.endpoint)
    notice = await _notice(pool, event_id, governance.MCP_SERVER_REMOVED, meta)
    return Removed(gone, notice)


async def refresh_tools(pool, server: Server, *, actor: str, probe: bool = False) -> Server:
    """Read the server's tools again (and, with `probe`, its era and title).
    A changed list replaces the old one at once and is recorded — never a
    freeze until someone approves it (v3's shape: an approval).

    Ruling T5-E: `change` is computed against the LOCKED row's own
    `tools`/`tools_hash`, read `FOR UPDATE` inside this call's own
    transaction — never against `server`, the caller's possibly-stale
    snapshot. Two concurrent refreshes from one snapshot then serialize on
    that lock and each sees the true current row in turn, so only the one
    that is genuinely first finds a change; the second sees its own result
    already reflected and records nothing twice. If the row's endpoint (url,
    token, headers) no longer matches `server`'s — a connect or disconnect
    re-pointed or removed it while this call's network round trip was in
    flight — nothing is written at all: recording A's tools onto B's row, or
    stamping B's row with a protocol or title this call never actually
    probed FROM B, would be reporting something that never happened."""
    not_reached: client.ClientError | None = None
    try:
        found = await client.probe(server.endpoint) if probe else None
        listed = await client.list_tools(server.endpoint, refresh=True)
    except client.ClientError as exc:
        # Defence in depth (ruling T5-A): the client already scrubs server
        # text at its own decode boundary, so this is a second pass. The
        # SAME type propagates (`ClientError`, not `ServerError`) — Tasks 7
        # and 9 catch `client.ClientError` here and call `record_call` to
        # stamp the failure; `refresh_tools` never states "nothing was
        # saved" the way `connect` does, because a refresh's row already
        # exists and is not touched by a failed read of it. Built here but
        # raised only after this `except` exits (same reasoning as
        # `connect`'s and the PostgresError handlers below), so its
        # `__context__` is None rather than this ClientError.
        not_reached = client.ClientError(
            _scrub(exc.reason, token=server.token, headers=server.headers),
            reachable=exc.reachable,
        )
    if not_reached is not None:
        raise not_reached
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
    change: dict[str, list[str]] | None = None
    event_id = None
    pg_refused: ServerError | None = None
    try:
        async with pool.acquire() as conn, conn.transaction():
            locked = await conn.fetchrow(
                f"SELECT {_COLUMNS} FROM mcp_servers WHERE name = $1 FOR UPDATE", server.name
            )
            if locked is None:
                raise ServerError(f"{server.name} was removed while its tools were being read")
            current = Server.from_row(locked)
            if (current.url, current.token, current.headers) != (
                server.url,
                server.token,
                server.headers,
            ):
                raise ServerError(
                    f"{server.name} changed while its tools were being read; nothing was recorded"
                )
            change = diff(current.tools, tools) if new_hash != current.tools_hash else None
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
            if change is not None:
                event_id = await governance.record_event(
                    conn,
                    kind=governance.MCP_TOOLS_CHANGED,
                    actor=actor,
                    meta={"name": server.name, **change},
                )
    except asyncpg.PostgresError as exc:
        # Built and logged here, raised only after this `except` has fully
        # exited (ruling T5-C; see the matching comment in `connect`): that
        # is the only way the raised ServerError's `__context__` ends up
        # None rather than this PostgresError and its DETAIL text, which
        # `from None` alone does not achieve.
        _log_pg_refused("refresh_tools", exc)
        pg_refused = _pg_refused(exc)
    if pg_refused is not None:
        raise pg_refused
    if change is not None:
        await _notice(pool, event_id, governance.MCP_TOOLS_CHANGED, {"name": server.name, **change})
    return Server.from_row(row)


async def _notice(pool, event_id: Any, kind: str, meta: dict) -> str | None:
    """File the notice for a change the owner did not make, if this is one.
    Returns the sentence her reply and the route carry — also when the
    notice could NOT be filed, which is said rather than left out, and
    worded by what actually happened (minor, "notice honesty"): a brand new
    notice, one this folded onto that was already live in his Inbox, or one
    that folds onto a notice he has MUTED — three different facts, never the
    same sentence for all three.

    `notices` and `app.checks.mcp` are imported HERE, not at module top
    (ruling F1). `app.checks`'s own import pulls in `app.checks.money` ->
    `app.agents` -> `app.tools`, and `app/tools/mcp.py` (Task 7) imports
    THIS module inside its executors — a module-level import here would
    close that into a cycle: `import app.main` (uvicorn's entry point)
    would crash with a partially initialized `app.beats`, while every test
    stayed green because conftest imports `app.chat` first. `governance`
    carries no such import and stays at the top of the module.

    Muted is decided from the CONDITION's own mute (ruling A, fix round 2)
    — `notices.muted_keys`, the exact set `notices.py`'s own `_SILENCED`
    (and so the Inbox) reads — checked BEFORE `is_new`, never from the
    fresh row's `state` column. F17 keys a finding on (kind, server), never
    on the event, so EVERY later change to the same server is a reading of
    the SAME condition: once the owner mutes one reading of it, a later one
    is `is_new` (a fresh fingerprint — different facts) just as often as it
    folds, and in BOTH cases the row's own `state` can disagree with the
    mute. `record`'s INSERT already consults `notice_mutes` to decide a
    fresh row's `state` (so `is_new` rows are usually already right) — but
    `set_muted` stamps `state='muted'` on the ONE row it was called with,
    never on a sibling that shares the same finding_key, so a FOLD onto
    that unmuted sibling reads `state='raised'` even though the Inbox
    already has nothing to show for either one. Reading `muted_keys`
    directly is the one source both paths actually need."""
    from app import notices
    from app.checks import mcp as mcp_checks

    finding = mcp_checks.finding_for(event_id, kind, meta)
    if finding is None:
        return None
    try:
        muted = finding.key in await notices.muted_keys(pool, mcp_checks.CHANGES)
        _row, is_new = await notices.record(
            pool, finding, check_name=mcp_checks.CHANGES, turn_id=None, firing_id=None
        )
    except Exception as exc:
        logger.exception("mcp: the notice for governance event %s could not be filed", event_id)
        return (
            f"The notice for the owner could not be filed ({type(exc).__name__}); the change is "
            "in the governance ledger."
        )
    if muted:
        return "The owner has muted notices like this; the change is in the governance ledger."
    if is_new:
        return "A notice about this is in the owner's Inbox."
    return "This was added to a notice already in the owner's Inbox."


async def no_such_server(pool, name: str) -> str:
    """The one sentence for 'that name is not connected', naming what IS —
    the single source (ruling F13) so a tool (Task 7) and `disconnect` never
    say this two different ways."""
    known = [s.name for s in await list_servers(pool)]
    listed = ", ".join(known) if known else "none is connected"
    return f"there is no connected MCP server named {name!r} — connected: {listed}"
