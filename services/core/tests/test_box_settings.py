"""The box's limits as settings (S32.2 T2; spec §9.5): box.cpus, box.memory_gb,
box.pids and box.max_running, bounded at the write, read live by
`code_repos.box_limits` for every box.* call core sends."""

from __future__ import annotations

import pytest

from app import code_repos
from tests.conftest import requires_db

pytestmark = requires_db

# key -> (default, minimum, maximum)
BOX_LIMITS = {
    "box.cpus": (2, 1, 16),
    "box.memory_gb": (3, 1, 64),
    "box.pids": (512, 64, 65536),
    "box.max_running": (2, 1, 8),
}


async def _by_key(client) -> dict:
    resp = await client.get("/api/v1/settings")
    assert resp.status_code == 200, resp.text
    return {item["key"]: item for item in resp.json()["settings"]}


# -- C1: listed with their defaults ---------------------------------------


async def test_the_four_limits_are_listed_as_ints_with_their_defaults(owner_client):
    items = await _by_key(owner_client)
    for key, (default, _lo, _hi) in BOX_LIMITS.items():
        assert key in items, key
        assert items[key]["type"] == "int"
        assert items[key]["default"] == default
        assert items[key]["value"] == default
        assert items[key]["description"].strip()


# -- C2: out of range is refused naming the bound --------------------------


@pytest.mark.parametrize(
    ("key", "value", "bound"),
    [(key, lo - 1, lo) for key, (_d, lo, _h) in BOX_LIMITS.items()]
    + [(key, hi + 1, hi) for key, (_d, _l, hi) in BOX_LIMITS.items()],
)
async def test_out_of_range_is_refused_naming_the_bound(owner_client, pool, key, value, bound):
    resp = await owner_client.put("/api/v1/settings", json={"key": key, "value": value})
    assert resp.status_code == 400, resp.text
    error = resp.json()["error"]
    assert key in error
    assert str(bound) in error
    assert str(value) in error
    assert await pool.fetchval("SELECT count(*) FROM settings WHERE key = $1", key) == 0


# -- C3: each bound itself is accepted -------------------------------------


@pytest.mark.parametrize(
    ("key", "value"),
    [(key, lo) for key, (_d, lo, _h) in BOX_LIMITS.items()]
    + [(key, hi) for key, (_d, _l, hi) in BOX_LIMITS.items()],
)
async def test_each_bound_is_accepted(owner_client, pool, key, value):
    resp = await owner_client.put("/api/v1/settings", json={"key": key, "value": value})
    assert resp.status_code == 200, resp.text
    assert await pool.fetchval("SELECT value FROM settings WHERE key = $1", key) == value


# -- C4: the type check covers them ----------------------------------------


@pytest.mark.parametrize("value", [True, "2", 2.5, None])
async def test_a_non_int_is_refused(owner_client, pool, value):
    resp = await owner_client.put("/api/v1/settings", json={"key": "box.cpus", "value": value})
    assert resp.status_code == 400, resp.text
    assert "box.cpus" in resp.json()["error"]
    assert await pool.fetchval("SELECT count(*) FROM settings WHERE key = 'box.cpus'") == 0


# -- C5: box_limits reads them live ----------------------------------------


async def test_box_limits_are_the_defaults_when_unset(pool):
    assert await code_repos.box_limits(pool) == {
        "cpus": 2,
        "memory_gb": 3,
        "pids": 512,
        "max_running": 2,
    }


async def test_box_limits_read_a_written_value_on_the_next_call(owner_client, pool):
    assert (await code_repos.box_limits(pool))["memory_gb"] == 3
    for key, value in (
        ("box.cpus", 4),
        ("box.memory_gb", 6),
        ("box.pids", 1024),
        ("box.max_running", 3),
    ):
        resp = await owner_client.put("/api/v1/settings", json={"key": key, "value": value})
        assert resp.status_code == 200, resp.text
    assert await code_repos.box_limits(pool) == {
        "cpus": 4,
        "memory_gb": 6,
        "pids": 1024,
        "max_running": 3,
    }
    resp = await owner_client.put("/api/v1/settings", json={"key": "box.cpus", "value": 1})
    assert resp.status_code == 200
    assert (await code_repos.box_limits(pool))["cpus"] == 1
