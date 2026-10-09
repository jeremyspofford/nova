"""Where her own repository lives, and whether a path is one of her worktrees
(the S32 worktree part, epic .epics/worktrees.md T2).

Derived, never hardcoded: the checkout path is NOVA_CHECKOUT (record_build,
nova_updates.CHECKOUT_ENV) and the machine that holds it is NOVA_REPO_HOST
(record_repo_host, the `hostname` ./install ran on — the value novad reports as
a device row's hostname). Both are read live on every call.

Only `<repo>/.worktrees/nova-<id>` is hers: the checkout itself, and every
other directory under it (another coder's worktree included), is "outside".
"""

from __future__ import annotations

import logging
import os
import posixpath
import re
from typing import Literal

from app import machines, nova_updates
from app.tools.base import ToolFailure

logger = logging.getLogger("core")

Scope = Literal["worktree", "outside"]

REPO_HOST_ENV = "NOVA_REPO_HOST"
WORKTREES_DIR = ".worktrees"
WORKTREE_PREFIX = "nova-"

_HOSTNAME = re.compile(r"[A-Za-z0-9._-]+")
# A character that can be part of a path: a reference to the repo starts
# after a character that cannot, and ends at "/" or one that cannot.
_PATH_CHAR = re.compile(r"[A-Za-z0-9._~@+-]")


def repo_dir() -> str | None:
    """The checkout's absolute path on its machine (NOVA_CHECKOUT), by
    nova_updates.checkout()'s rules; None when unset, or malformed (logged)."""
    raw = os.environ.get(nova_updates.CHECKOUT_ENV, "")
    value = nova_updates.checkout()
    if value is None and raw.strip():
        logger.info(
            "%s=%r is not an absolute path without control characters or '..' — "
            "her repository's checkout is treated as unrecorded",
            nova_updates.CHECKOUT_ENV,
            raw,
        )
    return value


def repo_host() -> str | None:
    """The hostname of the machine holding the checkout (NOVA_REPO_HOST);
    None when unset, or not DNS-ish (logged)."""
    raw = os.environ.get(REPO_HOST_ENV, "")
    value = raw.strip()
    if not value:
        return None
    if not _HOSTNAME.fullmatch(value):
        logger.info(
            "%s=%r is not a hostname — her repository's machine is treated as unrecorded",
            REPO_HOST_ENV,
            raw,
        )
        return None
    return value


async def repo_machine(app):
    """(row, repo_dir): the ONE live device whose hostname is NOVA_REPO_HOST
    (case-insensitive), read through machines.plant(). Anything else is a
    stated ToolFailure "cannot: ..." — a shared hostname is never resolved by
    picking one."""
    where = repo_dir()
    host = repo_host()
    unset = [
        key
        for key, value in ((nova_updates.CHECKOUT_ENV, where), (REPO_HOST_ENV, host))
        if value is None
    ]
    if unset:
        raise ToolFailure(
            f"cannot: where her repository is was not recorded ({' and '.join(unset)} unset or "
            "malformed) — the owner records it by running ./install from the checkout"
        )
    rows = await machines.plant().live_devices(app)
    matches = [row for row in rows if (row["hostname"] or "").lower() == host.lower()]
    if len(matches) == 1:
        return matches[0], where
    if matches:
        names = ", ".join(sorted(row["name"] for row in matches))
        raise ToolFailure(
            f"cannot: {len(matches)} paired devices report the hostname {host!r} "
            f"({REPO_HOST_ENV}) — {names} — so which one holds her repository is not known"
        )
    listed = ", ".join(f"{row['name']} (hostname {row['hostname']!r})" for row in rows)
    known = f"the paired devices are: {listed}" if listed else "no device is paired"
    raise ToolFailure(
        f"cannot: no paired device reports the hostname {host!r} ({REPO_HOST_ENV}, the "
        f"machine that holds her repository) — {known}"
    )


def _normalize(path: str) -> str | None:
    if not path or not path.startswith("/"):
        return None
    return posixpath.normpath(path).replace("//", "/")


def checkout_scope(path: str, repo_dir: str) -> Scope | None:
    """ "worktree" for <repo>/.worktrees/nova-<id>[/...], "outside" for the
    checkout itself and anything else under it, None when not under it."""
    target = _normalize(path)
    repo = _normalize(repo_dir)
    if target is None or repo is None:
        return None
    if target != repo and not target.startswith(repo.rstrip("/") + "/"):
        return None
    parts = target[len(repo) :].strip("/").split("/")
    if (
        len(parts) >= 2
        and parts[0] == WORKTREES_DIR
        and parts[1].startswith(WORKTREE_PREFIX)
        and len(parts[1]) > len(WORKTREE_PREFIX)
    ):
        return "worktree"
    return "outside"


def _references(text: str, repo: str):
    """Each path in `text` that starts with `repo` at a path boundary."""
    start = 0
    while (at := text.find(repo, start)) != -1:
        start = at + 1
        if at > 0 and (_PATH_CHAR.match(text[at - 1]) or text[at - 1] == "/"):
            continue
        end = at + len(repo)
        if end < len(text) and text[end] != "/" and _PATH_CHAR.match(text[end]):
            continue
        tail = end
        while tail < len(text) and (text[tail] == "/" or _PATH_CHAR.match(text[tail])):
            tail += 1
        yield text[at:tail]


def argv_scope(argv: list[str], repo_dir: str) -> Scope | None:
    """Each reference to the checkout inside any argv element, classified by
    checkout_scope: "outside" if any is, else "worktree" if any, else None."""
    repo = _normalize(repo_dir)
    if repo is None:
        return None
    found: set[str] = set()
    for element in argv:
        for ref in _references(element, repo):
            scope = checkout_scope(ref, repo)
            if scope is not None:
                found.add(scope)
    if "outside" in found:
        return "outside"
    return "worktree" if found else None
