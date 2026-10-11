"""Her repositories as rows (S32.2 T1; docs/plans/rebuild/s32/spec.md §4.6).

`code_repos` (migration 046) holds, per repository she changes, the machine
that holds it, the checkout's path there, the branch a change starts from, and
`environment`: where her commands inside a change worktree run — 'box' (the
sealed per-change container, the default) or 'host'.

The 'nova' row is derived, never typed: `sync_from_env` writes it at every core
start from what ./install recorded, read through app.code_repo (never
re-parsed here). The sync NEVER touches `environment`; only the owner sets it,
through PUT /api/v1/code-repos/{name}. No tool imports the writer.
"""

from __future__ import annotations

import logging
import os
import re
from typing import Any, Literal

import asyncpg
from fastapi import APIRouter, Body, Depends, HTTPException

from app import code_repo, db, identity, nova_updates, settings_store
from app.identity import Person

logger = logging.getLogger("core")

router = APIRouter(prefix="/api/v1/code-repos", tags=["code-repos"])

Environment = Literal["box", "host"]
ENVIRONMENTS: tuple[str, ...] = ("box", "host")
DEFAULT_ENVIRONMENT: Environment = "box"
NOVA = "nova"
REPO_BRANCH_ENV = "NOVA_REPO_BRANCH"
# A branch name as a change may start from it (app.tools.changes reads the same
# shape); '..' is refused separately.
BRANCH_SHAPE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}")

_COLUMNS = "name, machine, checkout, default_branch, environment, updated_at"


def _branch() -> str | None:
    """NOVA_REPO_BRANCH when it is a branch name; None (unrecorded) otherwise."""
    raw = os.environ.get(REPO_BRANCH_ENV, "")
    value = raw.strip()
    if not value:
        return None
    if not BRANCH_SHAPE.fullmatch(value) or ".." in value:
        logger.info(
            "%s=%r is not a branch name — code_repos stores the default branch as unrecorded",
            REPO_BRANCH_ENV,
            raw,
        )
        return None
    return value


async def sync_from_env(pool: asyncpg.Pool) -> None:
    """Upsert the 'nova' row from what ./install recorded. Leaves
    `environment` alone on an existing row (a new row gets the column default,
    'box'). When the machine or the checkout is unrecorded, writes nothing —
    an existing row stays as it was — and says so in one line."""
    machine = code_repo.repo_host()
    checkout = code_repo.repo_dir()
    unset = [
        key
        for key, value in (
            (code_repo.REPO_HOST_ENV, machine),
            (nova_updates.CHECKOUT_ENV, checkout),
        )
        if value is None
    ]
    if unset:
        logger.info(
            "code_repos: the %r row was not written — %s unset or malformed "
            "(./install from the checkout records it)",
            NOVA,
            " and ".join(unset),
        )
        return
    branch = _branch()
    await pool.execute(
        "INSERT INTO code_repos (name, machine, checkout, default_branch) "
        "VALUES ($1, $2, $3, $4) "
        "ON CONFLICT (name) DO UPDATE SET machine = EXCLUDED.machine, "
        "checkout = EXCLUDED.checkout, default_branch = EXCLUDED.default_branch, "
        "updated_at = now()",
        NOVA,
        machine,
        checkout,
        branch,
    )
    logger.info(
        "code_repos: %r is %s on %s (default branch %s)",
        NOVA,
        checkout,
        machine,
        branch or "unrecorded",
    )


async def environment(pool: asyncpg.Pool | asyncpg.Connection, name: str = NOVA) -> Environment:
    """Where commands in this repository's change worktrees run, read live;
    'box' when the repository has no row."""
    value = await pool.fetchval("SELECT environment FROM code_repos WHERE name = $1", name)
    return value if value in ENVIRONMENTS else DEFAULT_ENVIRONMENT


async def box_limits(pool: asyncpg.Pool | asyncpg.Connection) -> dict[str, int]:
    """The box's limits as the owner set them, read now (spec §9.5):
    {"cpus", "memory_gb", "pids", "max_running"} — the defaults where unset.
    Sent with every box.* call; never cached, so a write applies to the next."""
    return {
        name: await settings_store.read_value(pool, key)
        for name, key in settings_store.BOX_LIMIT_KEYS.items()
    }


def _json(row: asyncpg.Record) -> dict[str, Any]:
    out = dict(row)
    out["updated_at"] = row["updated_at"].isoformat()
    return out


@router.get("")
async def list_repos(_person: Person = Depends(identity.require_person)) -> dict:
    pool = await db.get_pool()
    rows = await pool.fetch(f"SELECT {_COLUMNS} FROM code_repos ORDER BY name")
    return {"repos": [_json(row) for row in rows]}


@router.put("/{name}")
async def set_environment(
    name: str,
    body: Any = Body(...),
    _person: Person = Depends(identity.require_person),
) -> dict:
    """The owner's switch: {"environment": "box"|"host"}. The only writer of
    `environment` — no tool reaches it."""
    value = body.get("environment") if isinstance(body, dict) else body
    if not isinstance(value, str) or value not in ENVIRONMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"environment must be one of {', '.join(ENVIRONMENTS)}; got {value!r}",
        )
    pool = await db.get_pool()
    row = await pool.fetchrow(
        f"UPDATE code_repos SET environment = $2, updated_at = now() WHERE name = $1 "
        f"RETURNING {_COLUMNS}",
        name,
        value,
    )
    if row is None:
        raise HTTPException(status_code=404, detail=f"no repository named {name!r}")
    logger.info("code_repos: %r environment set to %s by %s", name, value, _person.name)
    return {"repo": _json(row)}
