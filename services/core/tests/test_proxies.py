"""Wizard passthroughs — the browser only ever talks to core (ruling R8)."""
from __future__ import annotations

import pytest

from tests.conftest import requires_db
from tests.fakes import FakeGateway

pytestmark = requires_db

# (method, core path, the gateway path it must land on, body)
ROUTES = [
    ("GET", "/api/v1/system/hardware", "/admin/hardware", None),
    ("GET", "/api/v1/models/suggest", "/admin/suggest", None),
    ("POST", "/api/v1/models/probe", "/admin/probe", {"model": "qwen3:8b"}),
    ("GET", "/api/v1/inference/backend", "/admin/backend", None),
    ("PUT", "/api/v1/inference/backend", "/admin/backend", {"kind": "ollama"}),
]


@pytest.mark.parametrize(("method", "path", "gateway_path", "body"), ROUTES)
async def test_passthrough_reaches_the_gateway_and_returns_it_verbatim(
    owner_client, mount_peers, method, path, gateway_path, body
):
    gateway = FakeGateway(admin_body={"gpus": [{"name": "RTX 3090", "vram_gb": 24}]})
    mount_peers(gateway=gateway)

    resp = await owner_client.request(method, path, json=body)

    assert resp.status_code == 200
    assert resp.json() == {"gpus": [{"name": "RTX 3090", "vram_gb": 24}]}
    assert gateway.seen[-1] == (gateway_path, body)


@pytest.mark.parametrize(("method", "path", "gateway_path", "body"), ROUTES)
async def test_an_unreachable_gateway_is_a_stated_502(
    owner_client, mount_peers, monkeypatch, method, path, gateway_path, body
):
    mount_peers(gateway=FakeGateway())
    # Nothing is mounted on this URL and nothing listens on port 1.
    monkeypatch.setenv("GATEWAY_URL", "http://127.0.0.1:1")

    resp = await owner_client.request(method, path, json=body)

    assert resp.status_code == 502
    assert "gateway" in resp.json()["error"].lower()


async def test_a_gateway_refusal_passes_through_with_its_reason(owner_client, mount_peers):
    mount_peers(
        gateway=FakeGateway(admin_status=502, admin_body={"error": "ollama did not answer"})
    )
    resp = await owner_client.put("/api/v1/inference/backend", json={"kind": "ollama"})
    assert resp.status_code == 502
    assert resp.json() == {"error": "ollama did not answer"}


async def test_pull_streams_the_gateways_progress_lines_through(owner_client, mount_peers):
    gateway = FakeGateway(
        pull_lines=('{"status":"pulling","completed":1}', '{"status":"success"}')
    )
    mount_peers(gateway=gateway)

    resp = await owner_client.post("/api/v1/models/pull", json={"model": "qwen3:8b"})

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/x-ndjson")
    assert resp.text.splitlines() == [
        '{"status":"pulling","completed":1}',
        '{"status":"success"}',
    ]
    assert gateway.seen[-1] == ("/admin/pull", {"model": "qwen3:8b"})


async def test_pull_with_an_unreachable_gateway_is_a_stated_502(
    owner_client, mount_peers, monkeypatch
):
    mount_peers(gateway=FakeGateway())
    monkeypatch.setenv("GATEWAY_URL", "http://127.0.0.1:1")
    resp = await owner_client.post("/api/v1/models/pull", json={"model": "qwen3:8b"})
    assert resp.status_code == 502
    assert "gateway" in resp.json()["error"].lower()


async def test_an_unconfigured_gateway_link_is_a_stated_502(owner_client, monkeypatch):
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    monkeypatch.delenv("CORE_GATEWAY_TOKEN", raising=False)
    resp = await owner_client.get("/api/v1/system/hardware")
    assert resp.status_code == 502
    assert "GATEWAY_URL" in resp.json()["error"]


@pytest.mark.parametrize(("method", "path", "gateway_path", "body"), ROUTES)
async def test_the_proxies_need_an_identity(client, mount_peers, method, path, gateway_path, body):
    mount_peers(gateway=FakeGateway())
    resp = await client.request(method, path, json=body)
    assert resp.status_code == 401
