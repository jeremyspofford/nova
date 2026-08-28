"""Applies numbered SQL migrations against a service's own database.

Identical across services/core, services/gateway, services/memory — edit
this copy, then paste it verbatim over the other two. Do not let the three
drift.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

import asyncpg

logger = logging.getLogger("migrations")

_FILENAME_RE = re.compile(r"^(\d+)_.*\.sql$")

_CREATE_TRACKING_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
)
"""


class MigrationOrderError(RuntimeError):
    """An unrecorded migration file sorts below the highest applied one."""


def _migration_number(path: Path) -> int:
    match = _FILENAME_RE.match(path.name)
    if not match:
        raise ValueError(f"migration filename has no leading number: {path.name}")
    return int(match.group(1))


def discover_migrations(migrations_dir: Path) -> list[Path]:
    """All *.sql files in the directory, in numeric filename order."""
    files = list(migrations_dir.glob("*.sql"))
    return sorted(files, key=_migration_number)


def plan_pending(files: list[Path], applied: set[str]) -> list[Path]:
    """Which of `files` still need applying, in order.

    Numeric gaps are permitted and permanent — never assume max+1. An
    unrecorded file numbered lower than the highest applied migration is
    out-of-order history: raise rather than silently apply it.
    """
    if not applied:
        return files
    max_applied = max(_migration_number(Path(name)) for name in applied)
    pending = []
    for f in files:
        if f.name in applied:
            continue
        if _migration_number(f) < max_applied:
            raise MigrationOrderError(
                f"{f.name} is unrecorded but numbered below the highest "
                f"applied migration ({max_applied}) — out-of-order history"
            )
        pending.append(f)
    return pending


async def run_migrations(dsn: str, migrations_dir: Path) -> None:
    """Apply pending migrations against dsn, each in its own transaction."""
    files = discover_migrations(migrations_dir)
    conn = await asyncpg.connect(dsn)
    try:
        await conn.execute(_CREATE_TRACKING_TABLE)
        rows = await conn.fetch("SELECT filename FROM schema_migrations")
        applied = {row["filename"] for row in rows}
        pending = plan_pending(files, applied)
        for f in pending:
            sql = f.read_text()
            async with conn.transaction():
                await conn.execute(sql)
                await conn.execute(
                    "INSERT INTO schema_migrations (filename) VALUES ($1)", f.name
                )
            logger.info("applied migration %s", f.name)
    finally:
        await conn.close()
