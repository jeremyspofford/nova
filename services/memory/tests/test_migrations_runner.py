"""Migrations runner: ordering/discovery logic (asyncpg-free) plus one
live-Postgres integration test, skipped when no dockerized postgres is
available for this run."""
from __future__ import annotations

import os
from pathlib import Path

import asyncpg
import pytest

from app.migrations_runner import (
    MigrationOrderError,
    discover_migrations,
    plan_pending,
    run_migrations,
)


def _touch(tmp_path: Path, name: str) -> Path:
    p = tmp_path / name
    p.write_text("SELECT 1;")
    return p


def test_discover_migrations_numeric_order(tmp_path):
    _touch(tmp_path, "010_second.sql")
    _touch(tmp_path, "001_first.sql")
    _touch(tmp_path, "002_third.sql")
    files = discover_migrations(tmp_path)
    assert [f.name for f in files] == ["001_first.sql", "002_third.sql", "010_second.sql"]


def test_plan_pending_empty_applied_returns_all(tmp_path):
    a = _touch(tmp_path, "001_init.sql")
    b = _touch(tmp_path, "002_next.sql")
    assert plan_pending([a, b], applied=set()) == [a, b]


def test_plan_pending_skips_already_applied(tmp_path):
    a = _touch(tmp_path, "001_init.sql")
    b = _touch(tmp_path, "002_next.sql")
    assert plan_pending([a, b], applied={"001_init.sql"}) == [b]


def test_plan_pending_permits_numeric_gaps(tmp_path):
    # Gaps (001 -> 005) are permitted and permanent — never assume max+1.
    a = _touch(tmp_path, "001_init.sql")
    b = _touch(tmp_path, "005_later.sql")
    assert plan_pending([a, b], applied={"001_init.sql"}) == [b]


def test_plan_pending_raises_on_out_of_order_unrecorded_file(tmp_path):
    a = _touch(tmp_path, "001_init.sql")
    b = _touch(tmp_path, "002_next.sql")
    # 002 is recorded as applied but 001 is not — 001 sorts below the max
    # applied number, so it's out-of-order history, not an ordinary pending
    # migration.
    with pytest.raises(MigrationOrderError):
        plan_pending([a, b], applied={"002_next.sql"})


TEST_DSN = os.environ.get("TEST_DATABASE_URL", "")
_SKIP_REASON = "TEST_DATABASE_URL not set — no dockerized postgres available for this run"


@pytest.fixture
async def clean_schema_migrations():
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute("DROP TABLE IF EXISTS schema_migrations")
    finally:
        await conn.close()


@pytest.mark.skipif(not TEST_DSN, reason=_SKIP_REASON)
async def test_run_migrations_empty_then_apply_and_rerun_is_noop(tmp_path, clean_schema_migrations):
    _touch(tmp_path, "001_init.sql")

    await run_migrations(TEST_DSN, tmp_path)

    conn = await asyncpg.connect(TEST_DSN)
    try:
        row = await conn.fetchrow(
            "SELECT filename FROM schema_migrations WHERE filename = '001_init.sql'"
        )
    finally:
        await conn.close()
    assert row is not None

    await run_migrations(TEST_DSN, tmp_path)  # re-run: applies nothing, does not raise


@pytest.mark.skipif(not TEST_DSN, reason=_SKIP_REASON)
async def test_run_migrations_catches_up_from_n_minus_1_to_n(tmp_path, clean_schema_migrations):
    """The realistic deploy shape (S2 seam-hygiene: slice-01-carries.md): a
    running instance already has every migration but the newest applied, and
    a new release adds exactly one more. Empty-then-apply above cannot prove
    this — it demonstrates the runner recognizes N-1 already-applied
    migrations and applies ONLY the new Nth one, never re-running (or
    skipping) anything."""
    _touch(tmp_path, "001_init.sql")
    _touch(tmp_path, "002_second.sql")
    await run_migrations(TEST_DSN, tmp_path)  # instance is at N-1

    _touch(tmp_path, "003_third.sql")  # the new release adds migration N
    await run_migrations(TEST_DSN, tmp_path)

    conn = await asyncpg.connect(TEST_DSN)
    try:
        rows = await conn.fetch("SELECT filename FROM schema_migrations ORDER BY filename")
    finally:
        await conn.close()
    assert [r["filename"] for r in rows] == ["001_init.sql", "002_second.sql", "003_third.sql"]
