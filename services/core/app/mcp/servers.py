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

import hashlib
import json
import logging
import re
from collections.abc import Mapping, Sequence
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

from app.mcp import client

logger = logging.getLogger("core")

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{1,31}$")
BY_OWNER = "owner"
BY_NOVA = "nova"
# The roster names a server's tools when it has this many or fewer, and gives
# a count otherwise: one 87-tool server must not flood a small model's prompt.
ROSTER_NAMES_UP_TO = 12


class ServerError(Exception):
    """Why a server was not connected, removed or read, in words. Nothing was
    written. `reachable` is what the client found, when it got that far."""

    def __init__(self, reason: str, *, reachable: bool | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.reachable = reachable


@dataclass(frozen=True)
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
    costs the roster's failure clause, never the call's own answer."""
    now = datetime.now(UTC)
    overlay = OVERLAY.get()
    if overlay is not None:
        current = overlay.servers.get(name)
        if current is not None:
            overlay.servers[name] = (
                replace(current, last_ok_at=now)
                if ok
                else replace(current, last_error=_clip(reason or "failed", 500), last_error_at=now)
            )
        return
    try:
        if ok:
            await pool.execute(
                "UPDATE mcp_servers SET last_ok_at = now(), updated_at = now() WHERE name = $1",
                name,
            )
        else:
            await pool.execute(
                "UPDATE mcp_servers SET last_error = $2, last_error_at = now(), updated_at = now() "
                "WHERE name = $1",
                name,
                _clip(reason or "failed", 500),
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
