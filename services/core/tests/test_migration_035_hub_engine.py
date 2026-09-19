"""Core migration 035 (S40): the bundled engine is named `hub`.

Gateway 009 renames the builtin provider `ollama` -> `hub`; a chat setting that
named the old provider would ask for a provider that no longer exists. Only a
value that NAMED it moves — a bare id already means "the default provider"."""

from __future__ import annotations

from app.main import MIGRATIONS_DIR
from tests.conftest import requires_db

pytestmark = requires_db

MIGRATION = MIGRATIONS_DIR / "035_hub_engine.sql"


async def _set(pool, key: str, value: str) -> None:
    await pool.execute(
        "INSERT INTO settings (key, value) VALUES ($1, $2) "
        "ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        key,
        value,
    )


async def _get(pool, key: str):
    return await pool.fetchval("SELECT value FROM settings WHERE key = $1", key)


async def test_a_setting_that_named_the_old_builtin_names_hub(pool):
    await _set(pool, "chat.model", "ollama:qwen3.8:27b")
    await _set(pool, "chat.vision_model", "ollama:gemma4:12b")
    await pool.execute(MIGRATION.read_text())
    assert await _get(pool, "chat.model") == "hub:qwen3.8:27b"
    assert await _get(pool, "chat.vision_model") == "hub:gemma4:12b"


async def test_bare_and_cloud_values_are_left_as_the_owner_wrote_them(pool):
    await _set(pool, "chat.model", "qwen3.8:27b")
    await _set(pool, "chat.vision_model", "openrouter:openai/gpt-x")
    await pool.execute(MIGRATION.read_text())
    assert await _get(pool, "chat.model") == "qwen3.8:27b"
    assert await _get(pool, "chat.vision_model") == "openrouter:openai/gpt-x"


async def test_no_other_key_is_touched(pool):
    await _set(pool, "nova.timezone", "ollama:not-a-model")
    await pool.execute(MIGRATION.read_text())
    assert await _get(pool, "nova.timezone") == "ollama:not-a-model"


async def test_applied_twice_it_changes_nothing_more(pool):
    await _set(pool, "chat.model", "ollama:qwen3:8b")
    sql = MIGRATION.read_text()
    await pool.execute(sql)
    await pool.execute(sql)
    assert await _get(pool, "chat.model") == "hub:qwen3:8b"


async def test_the_runner_applies_it(pool):
    names = {r["filename"] for r in await pool.fetch("SELECT filename FROM schema_migrations")}
    assert "035_hub_engine.sql" in names
