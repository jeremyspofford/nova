"""S47 — GET /api/v1/network/address, the Settings panels' one source."""

from __future__ import annotations

from app import network
from tests.conftest import requires_db

pytestmark = requires_db


async def test_the_address_route_answers_with_the_reader(owner_client, tmp_path, monkeypatch):
    path = tmp_path / "tailscale.json"
    monkeypatch.setenv(network.STATUS_FILE_ENV, str(path))
    resp = await owner_client.get("/api/v1/network/address")
    assert resp.status_code == 200
    body = resp.json()
    assert body["address"] is None and "has not written its status" in body["reason"]
    assert set(body) == {"address", "reason", "read_at"}


async def test_the_address_route_needs_a_session(client):
    resp = await client.get("/api/v1/network/address")
    assert resp.status_code == 401
