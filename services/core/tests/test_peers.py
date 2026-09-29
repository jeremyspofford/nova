"""peers.client(): the one httpx client every outbound call to the gateway
or memory goes through."""
from __future__ import annotations

from urllib.parse import quote

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
    """core's own pull relay (proxies.py `pull()`) uses aiter_raw() to hand a
    browser the gateway's raw wire bytes, exactly the same shape as
    gateway's backend relay. That is only safe to read as text if nothing
    between here and there was ever invited to compress it — dormant today
    (the gateway never compresses its own responses), but latent the moment
    anyone adds gateway-side compression. Pinned so a regression here fails
    loudly rather than silently, the same way gateway's own default is
    pinned (one hop down, ruling R26)."""
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


def test_route_fields_reads_x_nova_route_the_one_way_chat_and_decisions_share():
    """The gateway's X-Nova-Route is `role=…;link=N;reason=…`, the reason
    percent-quoted because it is free text that can carry `;` and `=`. One
    reader, so a chat round and a decision call never decode it two ways."""
    reason = "fell back to link 2 (ollama:qwen3:8b) — openrouter: over its cap $10.00; walled"
    header = f"role=chat;link=2;reason={quote(reason, safe='')}"
    assert peers.route_fields(header) == {"role": "chat", "link": "2", "reason": reason}
    assert peers.route_fields("role=decisions;link=1") == {"role": "decisions", "link": "1"}
    assert peers.route_fields(None) == {}
    assert peers.route_fields("") == {}
