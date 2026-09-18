"""Migration 009 (S40): the bundled engine is `hub`, engines get their own
rows, and every measurement gains the columns that say what produced it.

The rule it encodes: SETTINGS follow the owner's intent (the row, its chain
links, its caps and prices are renamed); MEASUREMENTS keep the name that was
true when they were written (usage rows and probes still say 'ollama').
Walls are transient and go."""

from __future__ import annotations

import json
import shutil
from decimal import Decimal

import asyncpg
import pytest

import tests.conftest as conftest
from app.main import MIGRATIONS_DIR
from app.migrations_runner import run_migrations
from tests.conftest import TEST_DSN, requires_db

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "009_engines.sql"
GPU = "gpu:cuda:GPU-5f3b8b36-0d6e-4c1a-9f2e-7a1b2c3d4e5f"


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
    """A database exactly as S39 left it (001-008). Handed back afterwards:
    the next `pool` fixture rebuilds the suite's schema from empty."""
    await _migrate_to(tmp_path, 8)
    conn = await asyncpg.connect(TEST_DSN)
    try:
        yield conn
    finally:
        await conn.close()
        conftest._schema_built = False


async def _seed(conn) -> None:
    await conn.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) VALUES "
        "('openrouter', 'openai-chat', 'https://openrouter.test/v1', 'static-bearer', 'sk-1')"
    )
    chains = {
        "chat": ["ollama:qwen3:4b", "openrouter:x/y", "qwen3:8b"],
        "judge": ["ollama:qwen3:8b"],
        # A stale `hub:` link (a provider since deleted) and its twin's rewrite
        # are the same link twice: kept once, where it came first.
        "scheduled": ["hub:qwen3:8b", "ollama:qwen3:8b", "ollama:qwen3:4b"],
        "vision": [],
    }
    for role, chain in chains.items():
        await conn.execute(
            "INSERT INTO routes (role, chain) VALUES ($1, $2::jsonb)", role, json.dumps(chain)
        )
    await conn.execute(
        "INSERT INTO provider_walls (provider, model, walled_until, reason, status) VALUES "
        "('ollama', 'qwen3.8:27b', now() + interval '1 hour', 'ollama:qwen3.8:27b refused', 502),"
        "('openrouter', '', now() + interval '1 hour', 'openrouter refused (402)', 402)"
    )
    await conn.execute(
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, "
        "local, status) VALUES ('ollama', 'qwen3:8b', 'ollama:qwen3:8b', 'completion', "
        "'chat', 1200, true, 200)"
    )
    await conn.execute(
        "INSERT INTO probes (model, kind, ok, latency_ms, vram_mb, frame) VALUES "
        "('qwen3:8b', 'ollama', true, 100, 9508, 'model'), "
        "('gpt-x', 'cloud', true, 300, NULL, 'model')"
    )
    await conn.execute(
        "INSERT INTO spend_caps (provider, monthly_usd) VALUES "
        "('ollama', 5), ('hub', 7), ('openrouter', 10)"
    )
    await conn.execute(
        "INSERT INTO provider_prices (provider, model, basis, prompt_usd_per_token, "
        "completion_usd_per_token, verified_at) VALUES "
        "('ollama', 'qwen3:8b', 'owner', 0.000001, 0.000002, now()), "
        "('hub', 'qwen3:8b', 'owner', 0.000009, 0.000009, now()), "
        "('openrouter', 'x/y', 'listing', 0.000001, 0.000002, now())"
    )


async def test_the_builtin_becomes_hub_its_settings_follow_and_history_keeps_its_name(legacy):
    await _seed(legacy)

    await run_migrations(TEST_DSN, MIGRATIONS_DIR)

    rows = await legacy.fetch(
        "SELECT name, adapter, builtin, is_default FROM providers ORDER BY name"
    )
    assert [tuple(r) for r in rows] == [
        ("hub", "ollama", True, True),
        ("openrouter", "openai-chat", False, False),
    ]
    chains = {
        r["role"]: json.loads(r["chain"])
        for r in await legacy.fetch("SELECT role, chain FROM routes")
    }
    assert chains == {
        "chat": ["hub:qwen3:4b", "openrouter:x/y", "qwen3:8b"],
        "judge": ["hub:qwen3:8b"],
        "scheduled": ["hub:qwen3:8b", "hub:qwen3:4b"],
        "vision": [],
    }
    walls = await legacy.fetch("SELECT provider FROM provider_walls")
    assert [r["provider"] for r in walls] == ["openrouter"]
    usage = await legacy.fetchrow("SELECT provider, served_by, served_on FROM usage_events")
    assert tuple(usage) == ("ollama", "ollama:qwen3:8b", None)
    probes = await legacy.fetch(
        "SELECT model, kind, provider, compute, runtime, path FROM probes ORDER BY id"
    )
    assert [tuple(r) for r in probes] == [
        ("qwen3:8b", "ollama", "ollama", None, None, None),
        ("gpt-x", "cloud", None, None, None, None),
    ]
    caps = await legacy.fetch("SELECT provider, monthly_usd FROM spend_caps ORDER BY provider")
    assert [tuple(r) for r in caps] == [
        ("*", None),
        ("hub", Decimal("5.00")),
        ("openrouter", Decimal("10.00")),
    ]
    prices = await legacy.fetch(
        "SELECT provider, model, basis, prompt_usd_per_token FROM provider_prices ORDER BY provider"
    )
    assert [(r["provider"], r["model"], r["basis"]) for r in prices] == [
        ("hub", "qwen3:8b", "owner"),
        ("openrouter", "x/y", "listing"),
    ]
    assert prices[0]["prompt_usd_per_token"] == Decimal("0.000001")
    engine = await legacy.fetchrow(
        "SELECT provider, lifecycle, serving, hold_s, last_ready_at, last_tags, last_facts "
        "FROM engines"
    )
    assert tuple(engine) == ("hub", "always_on", True, 600, None, None, None)


async def _snapshot(conn) -> dict:
    async def rows(sql: str) -> list[tuple]:
        return [tuple(r) for r in await conn.fetch(sql)]

    return {
        "providers": await rows(
            "SELECT name, builtin, is_default, updated_at FROM providers ORDER BY name"
        ),
        "routes": await rows("SELECT role, chain, updated_at FROM routes ORDER BY role"),
        "engines": await rows("SELECT * FROM engines ORDER BY provider"),
        "caps": await rows("SELECT provider, monthly_usd FROM spend_caps ORDER BY provider"),
        "prices": await rows("SELECT provider, model, basis FROM provider_prices ORDER BY 1, 2, 3"),
        "probes": await rows("SELECT id, provider FROM probes ORDER BY id"),
        "constraints": await rows(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid IN "
            "('providers'::regclass, 'engines'::regclass, 'engine_models'::regclass, "
            "'probes'::regclass, 'usage_events'::regclass) ORDER BY conname"
        ),
    }


async def test_running_009_a_second_time_changes_nothing(legacy):
    await _seed(legacy)
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    before = await _snapshot(legacy)

    await legacy.execute(MIGRATION.read_text())

    assert await _snapshot(legacy) == before


@pytest.mark.parametrize(
    ("name", "words"),
    [
        ("hub", 'a provider named "hub" already exists'),
        ("library", 'a provider named "library" already exists'),
    ],
)
async def test_a_provider_already_holding_a_reserved_name_stops_the_migration(legacy, name, words):
    """A cloud provider called `hub` would be captured: its `hub:x` links would
    start meaning the bundled engine. Refused in words, nothing half-done."""
    await legacy.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape) "
        "VALUES ($1, 'openai-chat', 'https://x.test/v1', 'none')",
        name,
    )
    with pytest.raises(asyncpg.exceptions.RaiseError, match=words):
        await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    names = sorted(r["name"] for r in await legacy.fetch("SELECT name FROM providers"))
    assert names == sorted([name, "ollama"])
    assert (
        await legacy.fetchval(
            "SELECT count(*) FROM schema_migrations WHERE filename = '009_engines.sql'"
        )
        == 0
    )


async def test_an_ollama_that_is_not_the_bundled_engine_stops_the_migration(legacy):
    """'ollama' is the name every pre-S40 usage row and probe carries (ruling
    G3): a provider holding it would take that history over. Only a
    hand-edited database can have one (the wizard and the admin route never
    made one); it is refused in words rather than a bare CHECK violation."""
    await legacy.execute("DELETE FROM providers WHERE name = 'ollama'")
    await legacy.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape) "
        "VALUES ('ollama', 'openai-chat', 'https://x.test/v1', 'none')"
    )
    with pytest.raises(
        asyncpg.exceptions.RaiseError, match='a provider named "ollama" already exists'
    ):
        await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    assert await legacy.fetchval("SELECT builtin FROM providers WHERE name = 'ollama'") is False
    assert await legacy.fetchval("SELECT to_regclass('engines')") is None


async def test_the_new_rows_refuse_what_they_cannot_mean(legacy):
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    usage = (
        "INSERT INTO usage_events (provider, model, served_by, kind, purpose, duration_ms, "
        "local, status, served_on) VALUES ('hub', 'm', 'hub:m', 'completion', 'chat', 1, "
        "true, 200, '')"
    )
    refused = [
        (
            "INSERT INTO providers (name, adapter, base_url, auth_shape) "
            "VALUES ('library', 'openai-chat', 'https://x.test/v1', 'none')",
            "providers_name_not_reserved",
        ),
        (
            "INSERT INTO providers (name, adapter, base_url, auth_shape) "
            "VALUES ('ollama', 'openai-chat', 'https://x.test/v1', 'none')",
            "providers_name_not_reserved",
        ),
        (
            "INSERT INTO providers (name, adapter, base_url, auth_shape) "
            "VALUES ('dell', 'ollama', 'https://dell.test', 'none')",
            "providers_engine_link_has_token",
        ),
        (
            "INSERT INTO providers (name, adapter, base_url, auth_shape, builtin) "
            "VALUES ('box', 'ollama', '', 'none', true)",
            "providers_hub_is_the_builtin",
        ),
        ("UPDATE engines SET hold_s = 30", "engines_hold_s_bounded"),
        ("UPDATE engines SET hold_s = 1801", "engines_hold_s_bounded"),
        ("UPDATE engines SET lifecycle = 'sometimes'", "engines_lifecycle_is_known"),
        ("UPDATE engines SET last_tags = '{}'::jsonb", "engines_tags_dated"),
        ("UPDATE engines SET last_facts_at = now()", "engines_facts_dated"),
        (
            "INSERT INTO probes (model, kind, ok, runtime) VALUES ('m', 'ollama', true, 'docker')",
            "probes_runtime_is_known",
        ),
        (
            "INSERT INTO probes (model, kind, ok, path) VALUES ('m', 'ollama', true, 'local')",
            "probes_path_is_known",
        ),
        (
            "INSERT INTO probes (model, kind, ok, compute) VALUES ('m', 'ollama', true, '')",
            "probes_compute_not_empty",
        ),
        (usage, "usage_served_on_not_empty"),
    ]
    for sql, constraint in refused:
        with pytest.raises(asyncpg.exceptions.CheckViolationError, match=constraint):
            await legacy.execute(sql)
    # What the columns ARE for goes in.
    await legacy.execute(
        "INSERT INTO probes (model, kind, ok, provider, compute, runtime, path) VALUES "
        "('qwen3:8b', 'ollama', true, 'hub', $1, 'container', 'internal')",
        GPU,
    )
    await legacy.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) "
        "VALUES ('dell', 'ollama', 'https://dell.test', 'static-bearer', 'tok')"
    )


async def test_an_engine_and_its_models_follow_their_provider_row(legacy):
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    await legacy.execute(
        "INSERT INTO providers (name, adapter, base_url, auth_shape, api_key) "
        "VALUES ('dell', 'ollama', 'https://dell.test', 'static-bearer', 'tok')"
    )
    await legacy.execute("INSERT INTO engines (provider, lifecycle) VALUES ('dell', 'wake_on_lan')")
    await legacy.execute(
        "INSERT INTO engine_models (provider, name, digest, capabilities, context_length) "
        "VALUES ('dell', 'qwen3.8:27b', 'sha256:ab', $1::jsonb, 40960)",
        json.dumps(["completion", "tools"]),
    )
    await legacy.execute("UPDATE providers SET name = 'xps' WHERE name = 'dell'")
    assert (
        await legacy.fetchval("SELECT provider FROM engines WHERE lifecycle = 'wake_on_lan'")
        == "xps"
    )
    assert await legacy.fetchval("SELECT provider FROM engine_models") == "xps"
    await legacy.execute("DELETE FROM providers WHERE name = 'xps'")
    assert await legacy.fetchval("SELECT count(*) FROM engines WHERE provider = 'xps'") == 0
    assert await legacy.fetchval("SELECT count(*) FROM engine_models") == 0


async def test_fit_reads_probes_by_compute_through_an_index_of_its_own(legacy):
    await run_migrations(TEST_DSN, MIGRATIONS_DIR)
    indexdef = await legacy.fetchval(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'probes_compute_model'"
    )
    assert "(compute, model, created_at DESC)" in indexdef
    assert "WHERE (ok AND (frame = 'model'::text))" in indexdef
