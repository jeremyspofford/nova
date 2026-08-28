"""GET/PUT /admin/backend — PUT validates shape, then verifies the backend
is actually live BEFORE saving; a verification failure leaves the stored
config untouched. GET always masks the key."""
from __future__ import annotations

from app import backends
from tests.conftest import requires_db
from tests.fakes import FakeOpenAICompat

pytestmark = requires_db


async def test_get_backend_masks_the_api_key(client, pool):
    await backends.save_config(
        pool, {"kind": "cloud", "url": "https://x", "api_key": "sk-abcd1234", "model": "m"}
    )

    resp = await client.get("/admin/backend")

    assert resp.status_code == 200
    assert resp.json()["api_key"] == "•••1234"


async def test_put_invalid_shape_is_a_400_and_nothing_is_saved(client, pool):
    await backends.save_config(pool, {"kind": "ollama"})

    resp = await client.put("/admin/backend", json={"kind": "remote"})  # missing url

    assert resp.status_code == 400
    assert (await backends.read_config(pool))["kind"] == "ollama"


async def test_put_cloud_missing_api_key_is_a_400(client):
    resp = await client.put(
        "/admin/backend", json={"kind": "cloud", "url": "https://x", "model": "m"}
    )
    assert resp.status_code == 400


async def test_put_unreachable_backend_is_502_and_config_row_unchanged(
    client, pool, monkeypatch
):
    await backends.save_config(pool, {"kind": "ollama"})
    before = await backends.read_config(pool)

    resp = await client.put(
        "/admin/backend", json={"kind": "remote", "url": "http://127.0.0.1:1"}
    )

    assert resp.status_code == 502
    assert "error" in resp.json()
    after = await backends.read_config(pool)
    assert after == before


async def test_put_success_saves_and_get_reflects_it_masked(client, pool, mount_backend):
    fake = FakeOpenAICompat()
    mount_backend("http://remote.test", fake.app)

    resp = await client.put(
        "/admin/backend", json={"kind": "remote", "url": "http://remote.test"}
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["kind"] == "remote"
    assert body["url"] == "http://remote.test"
    assert body["api_key"] is None

    get_resp = await client.get("/admin/backend")
    assert get_resp.json()["kind"] == "remote"


async def test_put_cloud_success_masks_the_saved_key(client, pool, mount_backend):
    fake = FakeOpenAICompat()
    mount_backend("http://cloud.test", fake.app)

    resp = await client.put(
        "/admin/backend",
        json={
            "kind": "cloud",
            "url": "http://cloud.test",
            "api_key": "sk-newkey9999",
            "model": "gpt-x",
        },
    )

    assert resp.status_code == 200
    assert resp.json()["api_key"] == "•••9999"
    row = await pool.fetchrow("SELECT api_key FROM backend_config WHERE id = 1")
    assert row["api_key"] == "sk-newkey9999"  # stored unmasked, only display is masked
