"""S40 / D21: an ENGINE that could not be reached at all is its own fact.

A connect-phase failure — the connection refused, never answered, or the
proxy that would carry it failing — is `ProviderUnreachable`, a
`ProviderRefused` so every path that relays a refusal still does. It is
raised only for an engine (a row on the ollama adapter), and data_plane
never walls it. An engine that ACCEPTED the request and then failed (a read
timeout while a model loads, a dropped connection) is still a plain refusal
that walls that model — the 2026-09-10 rule in 007_wall_scope.sql (ruling
C12: a ReadTimeout before headers is "unreachable" only on a proxied dial,
which S43a adds). A cloud provider's connect failure is unchanged.
"""

from __future__ import annotations

import types

import httpx
import pytest

from app.adapters import ProviderRefused, ProviderUnreachable, ollama, openai_chat
from app.main import app
from tests.fakes import FailingTransport

REQUEST = types.SimpleNamespace(app=app)  # the adapters read only request.app
BODY = {"messages": [{"role": "user", "content": "hi"}], "stream": True}
ENGINE = {
    "name": "hub",
    "adapter": "ollama",
    "base_url": "",
    "auth_shape": "none",
    "api_key": None,
    "builtin": True,
    "local": True,
    "usage_supported": True,
}
CLOUD = {
    "name": "openrouter",
    "adapter": "openai-chat",
    "base_url": "http://cloud.test/v1",
    "auth_shape": "static-bearer",
    "api_key": "sk-1",
    "local": False,
    "usage_supported": True,
}


@pytest.fixture
def engine_url(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    return "http://ollama.test/v1"


@pytest.mark.parametrize("failure", [httpx.ConnectError, httpx.ConnectTimeout, httpx.ProxyError])
async def test_an_engine_that_never_took_the_request_is_unreachable(
    engine_url, mount_transport, failure
):
    transport = FailingTransport(failure)
    mount_transport(engine_url, transport)

    with pytest.raises(ProviderUnreachable) as caught:
        await ollama.ADAPTER.completions(REQUEST, ENGINE, "qwen3:8b", BODY)

    assert isinstance(caught.value, ProviderRefused), "every relay path still catches it"
    assert caught.value.status == 502
    assert caught.value.detail.startswith(
        f"could not reach hub at {engine_url} — {failure.__name__}"
    )
    assert transport.requests == [("POST", "/v1/chat/completions")]


@pytest.mark.parametrize(
    "failure", [httpx.ReadTimeout, httpx.RemoteProtocolError, httpx.WriteError]
)
async def test_an_engine_that_took_the_request_and_then_failed_is_a_refusal(
    engine_url, mount_transport, failure
):
    mount_transport(engine_url, FailingTransport(failure))

    with pytest.raises(ProviderRefused) as caught:
        await ollama.ADAPTER.completions(REQUEST, ENGINE, "qwen3:8b", BODY)

    assert not isinstance(caught.value, ProviderUnreachable)
    assert caught.value.status == 502


async def test_a_cloud_provider_that_never_connects_is_the_refusal_it_always_was(mount_transport):
    mount_transport("http://cloud.test", FailingTransport(httpx.ConnectError))

    with pytest.raises(ProviderRefused) as caught:
        await openai_chat.ADAPTER.completions(REQUEST, CLOUD, "remote-model", BODY)

    assert not isinstance(caught.value, ProviderUnreachable)
    assert caught.value.detail.startswith(
        "could not reach openrouter at http://cloud.test/v1 — ConnectError"
    )
