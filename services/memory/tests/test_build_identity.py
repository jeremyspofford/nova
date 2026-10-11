"""Build identity on /status (S32 T5): the commit and the content hash the
image was built from, baked in as ENV by the Dockerfile. A value that is not
exactly 40 or 64 lowercase hex is reported as null, never passed through."""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

import app.main as main
from app.build_identity import build_identity
from app.main import SERVICE_NAME, app

SHA1 = "0123456789abcdef0123456789abcdef01234567"
SHA256 = "0123456789abcdef" * 4
KEYS = {"build_sha": "NOVA_BUILD_SHA", "content_hash": "NOVA_CONTENT_HASH"}


@pytest.fixture
def env(monkeypatch):
    for var in KEYS.values():
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


@pytest.mark.parametrize("value", [SHA1, SHA256])
@pytest.mark.parametrize("key", list(KEYS))
def test_a_full_hex_value_is_reported_as_is(env, key, value):
    env.setenv(KEYS[key], value)
    got = build_identity()
    assert got[key] == value
    other = next(k for k in KEYS if k != key)
    assert got[other] is None


def test_both_keys_are_read_independently(env):
    env.setenv("NOVA_BUILD_SHA", SHA1)
    env.setenv("NOVA_CONTENT_HASH", SHA256)
    assert build_identity() == {"build_sha": SHA1, "content_hash": SHA256}


def test_unset_is_none(env):
    assert build_identity() == {"build_sha": None, "content_hash": None}


@pytest.mark.parametrize("value", ["", "unknown", "none", "null"])
def test_empty_or_a_word_is_none(env, value):
    env.setenv("NOVA_BUILD_SHA", value)
    env.setenv("NOVA_CONTENT_HASH", value)
    assert build_identity() == {"build_sha": None, "content_hash": None}


@pytest.mark.parametrize(
    "value",
    [
        SHA1.upper(),
        SHA1[:39],
        SHA1 + "0",
        SHA256[:63],
        SHA256 + "0",
        SHA1[:39] + "g",
        " " + SHA1,
        SHA1 + "\n",
        SHA1[:12],
        SHA1 + SHA1,
    ],
)
@pytest.mark.parametrize("key", list(KEYS))
def test_a_malformed_value_is_none(env, key, value):
    env.setenv(KEYS[key], value)
    assert build_identity()[key] is None


def test_service_version_is_gone():
    assert not hasattr(main, "SERVICE_VERSION")


def _client() -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _status(env) -> dict:
    env.setenv("SERVICE_TOKEN", "t")
    env.delenv("DATABASE_URL", raising=False)
    async with _client() as client:
        resp = await client.get("/status", headers={"Authorization": "Bearer t"})
    assert resp.status_code == 200
    return resp.json()


async def test_status_reports_the_baked_identity(env):
    env.setenv("NOVA_BUILD_SHA", SHA1)
    env.setenv("NOVA_CONTENT_HASH", SHA256)
    assert await _status(env) == {
        "service": SERVICE_NAME,
        "build_sha": SHA1,
        "content_hash": SHA256,
        "db_reachable": False,
    }


async def test_status_reports_null_for_a_missing_or_malformed_identity(env):
    env.setenv("NOVA_BUILD_SHA", "unknown")
    assert await _status(env) == {
        "service": SERVICE_NAME,
        "build_sha": None,
        "content_hash": None,
        "db_reachable": False,
    }


async def test_status_reads_the_env_per_request(env):
    env.setenv("NOVA_BUILD_SHA", SHA1)
    first = await _status(env)
    env.setenv("NOVA_BUILD_SHA", SHA256)
    second = await _status(env)
    assert (first["build_sha"], second["build_sha"]) == (SHA1, SHA256)
