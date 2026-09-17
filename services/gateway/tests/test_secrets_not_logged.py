"""api_key never appears in any log line — through the paths that
actually see it: saving a cloud backend, probing a cloud backend, and a
failed verification against a cloud backend."""
from __future__ import annotations

import logging

from app import backends
from tests.conftest import requires_db
from tests.fakes import FakeOpenAICompat

pytestmark = requires_db

SECRET = "sk-do-not-leak-this-9999"


def _assert_never_logged(caplog) -> None:
    assert SECRET not in caplog.text
    for record in caplog.records:
        assert SECRET not in record.getMessage()
        if record.exc_text:
            assert SECRET not in record.exc_text


async def test_saving_a_cloud_backend_never_logs_the_key(client, pool, mount_backend, caplog):
    caplog.set_level(logging.DEBUG)
    fake = FakeOpenAICompat()
    mount_backend("http://cloud.test", fake.app)

    resp = await client.put(
        "/admin/backend",
        json={"kind": "cloud", "url": "http://cloud.test", "api_key": SECRET, "model": "m"},
    )
    assert resp.status_code == 200
    _assert_never_logged(caplog)


async def test_probing_a_cloud_backend_never_logs_the_key(client, pool, mount_backend, caplog):
    caplog.set_level(logging.DEBUG)
    fake = FakeOpenAICompat()
    mount_backend("http://cloud.test", fake.app)
    await backends.save_config(
        pool, {"kind": "cloud", "url": "http://cloud.test", "api_key": SECRET, "model": "m"}
    )

    resp = await client.post("/admin/probe", json={"model": "m"})
    assert resp.status_code == 200
    _assert_never_logged(caplog)


async def test_a_failed_cloud_verification_never_logs_the_key(client, caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    monkeypatch.setenv("OLLAMA_URL", "")

    resp = await client.put(
        "/admin/backend",
        json={"kind": "cloud", "url": "http://127.0.0.1:1", "api_key": SECRET, "model": "m"},
    )
    assert resp.status_code == 502
    _assert_never_logged(caplog)


async def test_a_cloud_chat_completion_never_logs_the_key(client, pool, mount_backend, caplog):
    caplog.set_level(logging.DEBUG)
    fake = FakeOpenAICompat()
    mount_backend("http://cloud.test", fake.app)
    await backends.save_config(
        pool, {"kind": "cloud", "url": "http://cloud.test", "api_key": SECRET, "model": "m"}
    )

    resp = await client.post(
        "/v1/chat/completions", json={"messages": [], "stream": False}
    )
    assert resp.status_code == 200
    _assert_never_logged(caplog)
