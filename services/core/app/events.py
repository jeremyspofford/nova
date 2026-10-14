"""S37c: events from other programs (docs/plans/rebuild/s37c/spec.md).

T1 — the senders store. A sender is a program that may start a turn of hers:
another program holding its own token (kind `token`), or one of core's own
built-ins (`monitor`, `github_ci`), which hold no token and are filed by code,
never through the intake. Tokens are kept as sha256 (identity.hash_token, the
sessions' pattern) and compared in constant time.
"""

from __future__ import annotations

import hmac
import logging
import re
import secrets
from dataclasses import dataclass

import asyncpg

from app import identity

logger = logging.getLogger(__name__)

# The name is the suffix of the sender's routing role `event_<name>`, which
# the gateway takes only when it matches ROLE_RE ^[a-z_]{1,32}$: 6 + 26 = 32.
# Migration 051 holds the same rule as a CHECK.
NAME_RE = re.compile(r"^[a-z][a-z_]{0,25}$")
ROLE_PREFIX = "event_"

# Core's own senders and their kind. Seeded at startup (ensure_builtins); no
# token, so the intake refuses them.
BUILTINS: dict[str, str] = {"monitor": "monitor", "github_ci": "poll"}

# Who added a sender: the owner on Settings > Events, Nova with her tool, or
# core itself for a built-in.
ADDED_BY = ("owner", "nova", "builtin")

# Refusal reasons, stated on the refused row and in the log (by sender name).
WRONG_TOKEN = "wrong token"
UNKNOWN_SENDER = "unknown sender"
SENDER_OFF = "sender is off"
BUILTIN_SENDER = "built-in sender takes no calls"

# Compared against when there is no stored hash, so an unknown sender costs
# the same work as a known one with a wrong token.
_NO_HASH = identity.hash_token("")


class SenderError(ValueError):
    """A sender could not be added: the message says why."""


@dataclass(frozen=True)
class Sender:
    name: str
    kind: str
    role: str
    enabled: bool
    added_by: str

    @classmethod
    def from_row(cls, row) -> Sender:
        return cls(
            name=row["name"],
            kind=row["kind"],
            role=row["role"],
            enabled=row["enabled"],
            added_by=row["added_by"],
        )


@dataclass(frozen=True)
class Verdict:
    """What the intake's token check found. `reason` is empty when ok."""

    ok: bool
    reason: str
    sender: Sender | None = None


def check_name(name: str) -> str:
    """Return `name` when it is a valid sender name, else raise SenderError."""
    if not isinstance(name, str) or not NAME_RE.fullmatch(name):
        raise SenderError(
            f"a sender name is 1-26 characters: a lowercase letter, then lowercase "
            f"letters or underscores (got {name!r})"
        )
    return name


def role_for(name: str) -> str:
    """The routing role a sender's turns run under."""
    return ROLE_PREFIX + check_name(name)


async def add_sender(
    pool: asyncpg.Pool, name: str, *, added_by: str, reveal_once: bool = False
) -> tuple[Sender, str]:
    """Add a token sender; return it and its token, which is stored only hashed.

    The returned token is the only copy the caller gets. reveal_once=True (a
    sender Nova adds) also keeps it for ONE read by take_token_once, so the
    owner's screen can show it while her context never holds it."""
    check_name(name)
    if name in BUILTINS:
        raise SenderError(f"{name!r} is a built-in sender; pick another name")
    if added_by not in ADDED_BY or added_by == "builtin":
        raise SenderError(f"added_by must be 'owner' or 'nova' (got {added_by!r})")
    token = secrets.token_urlsafe(32)
    row = await pool.fetchrow(
        "INSERT INTO event_senders (name, kind, token_hash, token_once, role, added_by) "
        "VALUES ($1, 'token', $2, $3, $4, $5) ON CONFLICT (name) DO NOTHING RETURNING *",
        name,
        identity.hash_token(token),
        token if reveal_once else None,
        role_for(name),
        added_by,
    )
    if row is None:
        raise SenderError(f"a sender named {name!r} already exists")
    logger.info("event sender %r added by %s", name, added_by)
    return Sender.from_row(row), token


async def take_token_once(pool: asyncpg.Pool, name: str) -> str | None:
    """Return a sender's kept plaintext token and null it: one read, ever."""
    return await pool.fetchval(
        "UPDATE event_senders s SET token_once = NULL FROM "
        "(SELECT name, token_once FROM event_senders WHERE name = $1 FOR UPDATE) old "
        "WHERE s.name = old.name AND old.token_once IS NOT NULL RETURNING old.token_once",
        name,
    )


async def verify(pool: asyncpg.Pool, name: str, token: str) -> Verdict:
    """Check `token` against sender `name`. Never says more than the reason."""
    row = None
    if isinstance(name, str) and NAME_RE.fullmatch(name):
        row = await pool.fetchrow("SELECT * FROM event_senders WHERE name = $1", name)
    stored = row["token_hash"] if row is not None and row["token_hash"] else _NO_HASH
    matches = hmac.compare_digest(identity.hash_token(token or ""), stored)
    if row is None:
        return Verdict(False, UNKNOWN_SENDER)
    sender = Sender.from_row(row)
    if row["kind"] != "token":
        return Verdict(False, BUILTIN_SENDER, sender)
    if not token or not matches:
        return Verdict(False, WRONG_TOKEN, sender)
    if not row["enabled"]:
        return Verdict(False, SENDER_OFF, sender)
    return Verdict(True, "", sender)


async def ensure_builtins(pool: asyncpg.Pool) -> list[str]:
    """Seed each built-in sender that has no row; return the names seeded.

    Called at startup (main.lifespan), the timers.ensure_jobs pattern: ON
    CONFLICT DO NOTHING, so an existing row — and his on/off choice on it —
    is never touched."""
    seeded: list[str] = []
    for name, kind in BUILTINS.items():
        added = await pool.fetchval(
            "INSERT INTO event_senders (name, kind, role, added_by) "
            "VALUES ($1, $2, $3, 'builtin') ON CONFLICT (name) DO NOTHING RETURNING name",
            name,
            kind,
            role_for(name),
        )
        if added is not None:
            seeded.append(added)
            logger.info("seeded built-in event sender %r (%s)", name, kind)
    return seeded
