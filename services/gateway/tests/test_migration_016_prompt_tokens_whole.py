"""Migration 016 (S38c T7): the ledger's prompt_tokens is the whole input.

Before S38c T7 the anthropic-messages adapter stated Anthropic's
`input_tokens` (the UNCACHED remainder) as `prompt_tokens`; every
OpenAI-shaped provider states the whole input with the cached part inside
it. T7 makes the adapter state the whole. The rows already stored from an
Anthropic provider were in the old frame, so a Spend sum would add an old
remainder to a new whole. 016 moves them into the new frame, losslessly:
prompt_tokens += cache reads + cache writes (the cache columns and the
billed dollars stay as they were), so the table holds one frame and no
reader needs to tell two apart.
"""

from __future__ import annotations

import shutil
from decimal import Decimal

import asyncpg
import pytest

import tests.conftest as conftest
from app import usage
from app.main import MIGRATIONS_DIR
from app.migrations_runner import run_migrations
from tests.conftest import TEST_DSN, requires_db

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "016_prompt_tokens_whole.sql"

HAIKU = usage.Price(
    prompt=Decimal("0.000001"),
    completion=Decimal("0.000005"),
    cache_read=Decimal("0.1"),
    cache_write=Decimal("1.25"),
    basis="curated",
)


async def _migrate_to(tmp_path, upto: int) -> None:
    conn = await asyncpg.connect(TEST_DSN)
    try:
        await conn.execute(
            f"DROP TABLE IF EXISTS {', '.join(conftest._TABLES)}, backend_config CASCADE"
        )
        await conn.execute("DROP TABLE IF EXISTS schema_migrations")
    finally:
        await conn.close()
    partial = tmp_path / f"upto_{upto}"
    partial.mkdir(exist_ok=True)
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        if int(path.name.split("_")[0]) <= upto:
            shutil.copy(path, partial / path.name)
    await run_migrations(TEST_DSN, partial)


@pytest.fixture
async def legacy(tmp_path):
    """A database exactly as 015 left it, handed back REBUILT to the full
    schema (see test_migration_009_engines for why from here)."""
    await _migrate_to(tmp_path, 15)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        yield conn
    finally:
        await conn.close()
        await conftest._build_schema()


# (id, provider, kind, prompt, completion, read, write, cost, basis)
ROWS = [
    # The four live Anthropic rows (gateway usage_events 17-20, 2026-09-08).
    (17, "anthropic", "completion", 3677, 10, 0, 4863, "0.009806", "curated-price"),
    (18, "anthropic", "completion", 65, 6, 0, 0, "0.000095", "curated-price"),
    (19, "anthropic", "completion", 3686, 10, 4863, 0, "0.004222", "curated-price"),
    (20, "anthropic", "completion", 62, 6, 0, 0, "0.000092", "curated-price"),
    # An Anthropic row whose cache counts were never stated (NULL, not 0).
    (21, "anthropic", "completion", 40, 3, None, None, "0.000055", "curated-price"),
    # An Anthropic refusal: no counts at all — stays unmetered.
    (22, "anthropic", "refusal", None, None, None, None, None, None),
    # OpenAI-shaped rows: already the whole input, never touched.
    (23, "openrouter", "completion", 63958, 300, 61625, None, "0.006474", "provider-reported"),
    (24, "dell", "completion", 15061, 80, 14000, None, None, None),
]


async def _seed(conn) -> None:
    await conn.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) VALUES "
        "('anthropic', 'anthropic-messages', 'https://anthropic.test/v1', 'api-key-header', "
        "'sk-ant'), "
        "('openrouter', 'openai-chat', 'https://openrouter.test/v1', 'static-bearer', 'sk-1'), "
        "('dell', 'openai-chat', 'http://dell.test/v1', 'static-bearer', 'sk-2')"
    )
    for rid, provider, kind, prompt, completion, read, write, cost, basis in ROWS:
        await conn.execute(
            "INSERT INTO usage_events (id, provider, model, served_by, kind, purpose, "
            "prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, "
            "duration_ms, local, cost_usd, cost_basis, status) VALUES "
            "($1, $2, 'm', $2 || ':m', $3, 'chat', $4, $5, $6, $7, 10, false, $8, $9, 200)",
            rid,
            provider,
            kind,
            prompt,
            completion,
            read,
            write,
            Decimal(cost) if cost is not None else None,
            basis,
        )


async def _by_id(conn) -> dict[int, asyncpg.Record]:
    rows = await conn.fetch(
        "SELECT id, prompt_tokens, completion_tokens, cache_read_tokens, cache_write_tokens, "
        "cost_usd, cost_basis, metered FROM usage_events ORDER BY id"
    )
    return {r["id"]: r for r in rows}


async def test_s38c_t7_c6_an_anthropic_row_is_moved_into_the_whole_input_frame(legacy):
    assert MIGRATION.exists(), MIGRATION
    await _seed(legacy)
    before = await _by_id(legacy)

    await run_migrations(TEST_DSN, MIGRATIONS_DIR)

    after = await _by_id(legacy)
    assert after[17]["prompt_tokens"] == 3677 + 4863
    assert after[19]["prompt_tokens"] == 3686 + 4863
    assert after[18]["prompt_tokens"] == 65 and after[20]["prompt_tokens"] == 62
    # A NULL cache count is no part: the prompt stays what it was.
    assert after[21]["prompt_tokens"] == 40
    # Lossless: everything but prompt_tokens is exactly as stored.
    for rid in before:
        for column in (
            "completion_tokens",
            "cache_read_tokens",
            "cache_write_tokens",
            "cost_usd",
            "cost_basis",
            "metered",
        ):
            assert after[rid][column] == before[rid][column], (rid, column)


async def test_s38c_t7_c6_a_row_without_a_prompt_and_other_adapters_rows_are_untouched(
    legacy,
):
    await _seed(legacy)
    before = await _by_id(legacy)
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    after = await _by_id(legacy)
    assert after[22]["prompt_tokens"] is None and after[22]["metered"] is False
    for rid in (23, 24):
        assert dict(after[rid]) == dict(before[rid]), rid


async def test_s38c_t7_c6_a_moved_row_reprices_to_the_dollars_it_was_billed(legacy):
    await _seed(legacy)
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    after = await _by_id(legacy)
    for rid in (17, 18, 19, 20):
        r = after[rid]
        captured = usage.Captured(
            prompt_tokens=r["prompt_tokens"],
            completion_tokens=r["completion_tokens"],
            cache_read_tokens=r["cache_read_tokens"],
            cache_write_tokens=r["cache_write_tokens"],
        )
        assert usage.cost_from_price(HAIKU, captured) == r["cost_usd"], rid
