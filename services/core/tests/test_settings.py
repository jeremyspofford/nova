"""The settings registry: a key exists because a def says so."""
from __future__ import annotations

from tests.conftest import requires_db

pytestmark = requires_db

S1_KEYS = {"onboarding.completed", "chat.model", "appearance.default_preset"}


async def _by_key(client) -> dict:
    resp = await client.get("/api/v1/settings")
    assert resp.status_code == 200, resp.text
    return {item["key"]: item for item in resp.json()["settings"]}


async def test_every_def_is_listed_with_its_default_when_unset(owner_client):
    items = await _by_key(owner_client)
    assert set(items) == S1_KEYS
    assert items["onboarding.completed"]["type"] == "bool"
    assert items["onboarding.completed"]["default"] is False
    assert items["onboarding.completed"]["value"] is False
    assert items["chat.model"]["value"] == ""
    assert items["appearance.default_preset"]["value"] == "default"
    assert all(item["description"] for item in items.values())


async def test_a_written_value_round_trips_and_is_persisted(owner_client, pool):
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "chat.model", "value": "qwen3:8b"}
    )
    assert resp.status_code == 200
    assert resp.json() == {"key": "chat.model", "value": "qwen3:8b"}

    assert await pool.fetchval("SELECT value FROM settings WHERE key = 'chat.model'") == "qwen3:8b"
    assert (await _by_key(owner_client))["chat.model"]["value"] == "qwen3:8b"


async def test_writing_twice_updates_the_one_row(owner_client, pool):
    await owner_client.put("/api/v1/settings", json={"key": "onboarding.completed", "value": True})
    await owner_client.put("/api/v1/settings", json={"key": "onboarding.completed", "value": False})

    rows = await pool.fetch("SELECT value FROM settings WHERE key = 'onboarding.completed'")
    assert len(rows) == 1
    assert rows[0]["value"] is False


async def test_an_unknown_key_is_refused_by_name(owner_client, pool):
    resp = await owner_client.put("/api/v1/settings", json={"key": "chat.modle", "value": "x"})
    assert resp.status_code == 400
    assert "chat.modle" in resp.json()["error"]
    assert await pool.fetchval("SELECT count(*) FROM settings") == 0


async def test_a_bool_setting_refuses_a_string(owner_client):
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "onboarding.completed", "value": "yes"}
    )
    assert resp.status_code == 400
    assert "bool" in resp.json()["error"]


async def test_a_bool_setting_refuses_a_number(owner_client):
    # JSON 1 is not JSON true, however forgiving python feels about it.
    resp = await owner_client.put(
        "/api/v1/settings", json={"key": "onboarding.completed", "value": 1}
    )
    assert resp.status_code == 400


async def test_a_string_setting_refuses_a_bool(owner_client):
    resp = await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": True})
    assert resp.status_code == 400
    assert "str" in resp.json()["error"]


async def test_a_string_setting_refuses_null(owner_client):
    resp = await owner_client.put("/api/v1/settings", json={"key": "chat.model", "value": None})
    assert resp.status_code == 400
