"""Her repositories as rows (S32.2 T1): migration 046's code_repos table, the
startup sync from what ./install recorded, the live `environment` read, and the
owner's API that alone sets `host`."""

from __future__ import annotations

import logging

import asyncpg
import pytest

from app import code_repo, code_repos, nova_updates
from app.main import app, lifespan
from tests.conftest import requires_db

pytestmark = requires_db

CHECKOUT = "/home/jeremy/workspace/nova"
HOST = "nova-mini"


@pytest.fixture
def recorded(monkeypatch):
    monkeypatch.setenv(code_repo.REPO_HOST_ENV, HOST)
    monkeypatch.setenv(nova_updates.CHECKOUT_ENV, CHECKOUT)
    monkeypatch.setenv(code_repos.REPO_BRANCH_ENV, "main")


async def _rows(pool):
    return [dict(r) for r in await pool.fetch("SELECT * FROM code_repos ORDER BY name")]


# -- C1: the table ---------------------------------------------------------


async def test_the_table_defaults_environment_to_box_and_refuses_any_other_word(pool):
    await pool.execute("INSERT INTO code_repos (name, machine, checkout) VALUES ('x', 'h', '/c')")
    row = await pool.fetchrow("SELECT * FROM code_repos WHERE name = 'x'")
    assert row["environment"] == "box"
    assert row["default_branch"] is None
    assert row["updated_at"] is not None
    with pytest.raises(asyncpg.CheckViolationError):
        await pool.execute(
            "INSERT INTO code_repos (name, machine, checkout, environment) "
            "VALUES ('y', 'h', '/c', 'privileged')"
        )
    with pytest.raises(asyncpg.UniqueViolationError):
        await pool.execute(
            "INSERT INTO code_repos (name, machine, checkout) VALUES ('x', 'h', '/c')"
        )


# -- C2/C3: the sync -------------------------------------------------------


async def test_sync_writes_the_nova_row_from_what_install_recorded(pool, recorded):
    await code_repos.sync_from_env(pool)
    [row] = await _rows(pool)
    assert (row["name"], row["machine"], row["checkout"], row["default_branch"]) == (
        "nova",
        HOST,
        CHECKOUT,
        "main",
    )
    assert row["environment"] == "box"


async def test_sync_is_idempotent_and_follows_a_changed_record(pool, recorded, monkeypatch):
    await code_repos.sync_from_env(pool)
    await code_repos.sync_from_env(pool)
    assert len(await _rows(pool)) == 1
    monkeypatch.setenv(code_repo.REPO_HOST_ENV, "dell")
    monkeypatch.setenv(nova_updates.CHECKOUT_ENV, "/srv/nova")
    monkeypatch.setenv(code_repos.REPO_BRANCH_ENV, "trunk")
    await code_repos.sync_from_env(pool)
    [row] = await _rows(pool)
    assert (row["machine"], row["checkout"], row["default_branch"]) == (
        "dell",
        "/srv/nova",
        "trunk",
    )


async def test_sync_keeps_the_host_the_owner_set(pool, recorded):
    await code_repos.sync_from_env(pool)
    await pool.execute("UPDATE code_repos SET environment = 'host' WHERE name = 'nova'")
    await code_repos.sync_from_env(pool)
    [row] = await _rows(pool)
    assert row["environment"] == "host"


@pytest.mark.parametrize("branch", ["../etc", "", "-x"])
async def test_an_unshaped_or_unset_branch_is_stored_as_unrecorded(
    pool, recorded, monkeypatch, branch
):
    monkeypatch.setenv(code_repos.REPO_BRANCH_ENV, branch)
    await code_repos.sync_from_env(pool)
    [row] = await _rows(pool)
    assert row["default_branch"] is None


# -- C4: unset means no row ------------------------------------------------


@pytest.mark.parametrize(
    ("unset", "malformed"),
    [
        (code_repo.REPO_HOST_ENV, None),
        (nova_updates.CHECKOUT_ENV, None),
        (None, (code_repo.REPO_HOST_ENV, "not a host!")),
        (None, (nova_updates.CHECKOUT_ENV, "relative/path")),
    ],
)
async def test_an_unrecorded_repo_writes_no_row_and_says_so_once(
    pool, recorded, monkeypatch, caplog, unset, malformed
):
    if unset:
        monkeypatch.delenv(unset)
        named = unset
    else:
        monkeypatch.setenv(*malformed)
        named = malformed[0]
    with caplog.at_level(logging.INFO, logger="core"):
        await code_repos.sync_from_env(pool)
    assert await _rows(pool) == []
    said = [r.getMessage() for r in caplog.records if "code_repos" in r.getMessage()]
    assert len(said) == 1, said
    assert named in said[0]


async def test_an_unrecorded_repo_leaves_an_existing_row_alone(pool, recorded, monkeypatch):
    await code_repos.sync_from_env(pool)
    await pool.execute("UPDATE code_repos SET environment = 'host' WHERE name = 'nova'")
    before = await _rows(pool)
    monkeypatch.delenv(code_repo.REPO_HOST_ENV)
    await code_repos.sync_from_env(pool)
    assert await _rows(pool) == before


# -- C5: the live read ----------------------------------------------------


async def test_environment_reads_the_row_and_is_box_without_one(pool, recorded):
    assert await code_repos.environment(pool) == "box"
    assert await code_repos.environment(pool, "other") == "box"
    await code_repos.sync_from_env(pool)
    assert await code_repos.environment(pool) == "box"
    await pool.execute("UPDATE code_repos SET environment = 'host' WHERE name = 'nova'")
    assert await code_repos.environment(pool) == "host"
    assert await code_repos.environment(pool, "nova") == "host"
    assert await code_repos.environment(pool, "other") == "box"


# -- C6: the owner's API --------------------------------------------------


async def test_get_lists_the_rows(pool, recorded, owner_client):
    await code_repos.sync_from_env(pool)
    resp = await owner_client.get("/api/v1/code-repos")
    assert resp.status_code == 200, resp.text
    [repo] = resp.json()["repos"]
    assert repo["name"] == "nova"
    assert repo["machine"] == HOST
    assert repo["checkout"] == CHECKOUT
    assert repo["default_branch"] == "main"
    assert repo["environment"] == "box"
    assert repo["updated_at"]


async def test_put_sets_host_and_back(pool, recorded, owner_client):
    await code_repos.sync_from_env(pool)
    resp = await owner_client.put("/api/v1/code-repos/nova", json={"environment": "host"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["repo"]["environment"] == "host"
    assert resp.json()["repo"]["name"] == "nova"
    assert await code_repos.environment(pool) == "host"
    resp = await owner_client.put("/api/v1/code-repos/nova", json={"environment": "box"})
    assert resp.status_code == 200, resp.text
    assert await code_repos.environment(pool) == "box"


@pytest.mark.parametrize("value", ["privileged", "", None, 1, ["host"]])
async def test_put_refuses_another_value_naming_it(pool, recorded, owner_client, value):
    await code_repos.sync_from_env(pool)
    resp = await owner_client.put("/api/v1/code-repos/nova", json={"environment": value})
    assert resp.status_code == 400, resp.text
    assert repr(value) in resp.json()["error"]
    assert await code_repos.environment(pool) == "box"


async def test_put_on_an_unknown_repo_is_404(pool, recorded, owner_client):
    await code_repos.sync_from_env(pool)
    resp = await owner_client.put("/api/v1/code-repos/elsewhere", json={"environment": "host"})
    assert resp.status_code == 404, resp.text
    assert "elsewhere" in resp.json()["error"]


async def test_no_session_is_401(pool, recorded, client):
    await code_repos.sync_from_env(pool)
    assert (await client.get("/api/v1/code-repos")).status_code == 401
    resp = await client.put("/api/v1/code-repos/nova", json={"environment": "host"})
    assert resp.status_code == 401
    assert await code_repos.environment(pool) == "box"


# -- C7: startup ----------------------------------------------------------


async def test_core_startup_syncs_the_row(pool, recorded):
    async with lifespan(app):
        [row] = await _rows(pool)
        assert (row["name"], row["machine"], row["checkout"]) == ("nova", HOST, CHECKOUT)


def test_no_tool_writes_the_environment():
    """D10: the owner's PUT is the only writer. Derived from the tool sources
    on disk, so a new tool that grows a write turns this red."""
    from pathlib import Path

    import app.tools as tools_pkg

    root = Path(tools_pkg.__file__).parent
    offenders = [
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if "set_environment" in (text := path.read_text())
        or "UPDATE code_repos" in text
        or "INSERT INTO code_repos" in text
    ]
    assert offenders == []
