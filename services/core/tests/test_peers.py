"""peers.client(): the one httpx client every outbound call to the gateway
or memory goes through."""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from app import peers


def _app() -> FastAPI:
    return FastAPI()


def test_client_raises_when_url_is_unset(monkeypatch):
    monkeypatch.delenv("GATEWAY_URL", raising=False)
    monkeypatch.setenv("CORE_GATEWAY_TOKEN", "tok")
    with pytest.raises(peers.PeerUnconfigured):
        peers.client(_app(), peers.GATEWAY, httpx.Timeout(5.0))


def test_client_carries_the_bearer_token(monkeypatch):
    monkeypatch.setenv("GATEWAY_URL", "http://gateway.test")
    monkeypatch.setenv("CORE_GATEWAY_TOKEN", "the-token")
    client = peers.client(_app(), peers.GATEWAY, httpx.Timeout(5.0))
    assert client.headers["authorization"] == "Bearer the-token"


def test_client_defaults_accept_encoding_to_identity(monkeypatch):
    """Mirror of gateway's R26 fix, one hop up: core's own pull relay
    (proxies.py `pull()`) uses aiter_raw() to hand a browser the gateway's
    raw wire bytes, exactly the same shape as gateway's backend relay. That
    is only safe to read as text if nothing between here and there was ever
    invited to compress it — dormant today (the gateway never compresses its
    own responses), but latent the moment anyone adds gateway-side
    compression. Pinned so a regression here fails loudly rather than
    silently, the same way gateway's own default is pinned."""
    monkeypatch.setenv("GATEWAY_URL", "http://gateway.test")
    monkeypatch.setenv("CORE_GATEWAY_TOKEN", "tok")
    client = peers.client(_app(), peers.GATEWAY, httpx.Timeout(5.0))
    assert client.headers["accept-encoding"] == "identity"


def test_client_uses_a_mounted_fake_when_present(monkeypatch):
    monkeypatch.setenv("GATEWAY_URL", "http://gateway.test")
    monkeypatch.setenv("CORE_GATEWAY_TOKEN", "tok")
    app = _app()
    mounted = httpx.MockTransport(lambda request: httpx.Response(200))
    app.state.peer_transports = {"http://gateway.test": mounted}
    client = peers.client(app, peers.GATEWAY, httpx.Timeout(5.0))
    assert client._transport is mounted
