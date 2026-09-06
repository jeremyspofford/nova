"""backend_config resolution: reading, saving, masking, shape validation,
and the live-verification check PUT performs before ever saving."""
from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI, HTTPException

from app import backends
from tests.conftest import requires_db
from tests.fakes import FakeOllama, FakeOpenAICompat, StreamingASGITransport

pytestmark = requires_db


def _app_with(url: str, fake_app) -> FastAPI:
    app = FastAPI()
    app.state.peer_transports = {url: StreamingASGITransport(fake_app)}
    return app


async def test_ensure_default_row_seeds_ollama_from_env(pool, monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.example:11434")
    row = await backends.read_config(pool)
    assert row["kind"] == "ollama"
    assert row["api_key"] is None


async def test_ensure_default_row_is_a_noop_once_a_backend_is_saved(pool):
    await backends.save_config(pool, {"kind": "remote", "url": "http://remote.example"})
    await backends.ensure_default_row(pool)
    row = await backends.read_config(pool)
    assert row["kind"] == "remote"


def test_mask_api_key_shows_only_the_last_four():
    assert backends.mask_api_key("sk-abcdef1234") == "•••1234"
    assert backends.mask_api_key(None) is None
    assert backends.mask_api_key("") is None


def test_to_public_never_exposes_the_raw_key():
    row = {"kind": "cloud", "api_key": "sk-supersecret9999", "url": "https://x"}
    public = backends.to_public(row)
    assert public["api_key"] == "•••9999"
    assert "supersecret" not in str(public)


def test_resolve_base_url_ollama_always_uses_the_live_env_var(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.live:11434")
    row = {"kind": "ollama", "url": "http://stale.example"}
    assert backends.resolve_base_url(row) == "http://ollama.live:11434"


def test_resolve_base_url_remote_and_cloud_use_the_stored_url():
    assert backends.resolve_base_url({"kind": "remote", "url": "http://r.example/"}) == (
        "http://r.example"
    )
    assert backends.resolve_base_url({"kind": "cloud", "url": "https://c.example/"}) == (
        "https://c.example"
    )


def test_auth_headers_only_set_for_cloud():
    assert backends.auth_headers({"kind": "cloud", "api_key": "sk-x"}) == {
        "Authorization": "Bearer sk-x"
    }
    assert backends.auth_headers({"kind": "ollama", "api_key": None}) == {}
    assert backends.auth_headers({"kind": "remote", "api_key": None}) == {}


@pytest.mark.parametrize(
    "payload",
    [
        {"kind": "nonsense"},
        {"kind": "remote"},  # missing url
        {"kind": "cloud", "url": "https://x"},  # missing api_key + model
        {"kind": "cloud", "url": "https://x", "api_key": "sk-x"},  # missing model
    ],
)
def test_validate_shape_refuses_bad_payloads(payload):
    with pytest.raises(HTTPException) as excinfo:
        backends.validate_shape(payload)
    assert excinfo.value.status_code == 400


def test_validate_shape_accepts_a_bare_ollama_payload():
    backends.validate_shape({"kind": "ollama"})  # does not raise


def test_validate_shape_accepts_a_complete_cloud_payload():
    backends.validate_shape(
        {"kind": "cloud", "url": "https://x", "api_key": "sk-x", "model": "gpt-x"}
    )


async def test_verify_live_ollama_success(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama()
    app = _app_with("http://ollama.test", fake.app)
    await backends.verify_live(app, {"kind": "ollama"})  # does not raise


async def test_verify_live_ollama_failure_states_the_reason(monkeypatch):
    monkeypatch.setenv("OLLAMA_URL", "http://ollama.test")
    fake = FakeOllama(version_status=500)
    app = _app_with("http://ollama.test", fake.app)
    with pytest.raises(backends.VerificationFailed) as excinfo:
        await backends.verify_live(app, {"kind": "ollama"})
    assert "ollama" in str(excinfo.value)


async def test_verify_live_ollama_unset_env_is_a_stated_failure(monkeypatch):
    monkeypatch.delenv("OLLAMA_URL", raising=False)
    app = FastAPI()
    with pytest.raises(backends.VerificationFailed) as excinfo:
        await backends.verify_live(app, {"kind": "ollama"})
    assert "OLLAMA_URL" in str(excinfo.value)


async def test_verify_live_remote_hits_v1_models():
    fake = FakeOpenAICompat()
    app = _app_with("http://remote.test", fake.app)
    await backends.verify_live(app, {"kind": "remote", "url": "http://remote.test"})
    assert fake.seen_auth == [None]


async def test_verify_live_cloud_sends_the_api_key():
    fake = FakeOpenAICompat(accepts_key="sk-secret")
    app = _app_with("http://cloud.test", fake.app)
    await backends.verify_live(
        app, {"kind": "cloud", "url": "http://cloud.test", "api_key": "sk-secret", "model": "m"}
    )
    # The real key, then the certainly-wrong key that learns whether the
    # listing is public (S10-pre's key proof); this fake's listing is not, so
    # nothing else was sent.
    assert fake.seen_auth == ["Bearer sk-secret", "Bearer nova-verify-this-key-is-wrong"]


async def test_verify_live_unreachable_is_stated():
    app = FastAPI()  # nothing mounted, but a real socket to a closed port
    with pytest.raises(backends.VerificationFailed):
        await backends.verify_live(app, {"kind": "remote", "url": "http://127.0.0.1:1"})


async def test_save_and_read_round_trip(pool):
    saved = await backends.save_config(
        pool, {"kind": "cloud", "url": "https://api.example", "api_key": "sk-x", "model": "m"}
    )
    assert saved["kind"] == "cloud"
    read_back = await backends.read_config(pool)
    assert read_back == saved


def test_http_client_uses_a_mounted_fake_when_present():
    fake = FakeOllama()
    app = _app_with("http://ollama.test", fake.app)
    mounted = app.state.peer_transports["http://ollama.test"]
    client = backends.http_client(app, httpx.Timeout(1.0), base_url="http://ollama.test")
    assert client._transport is mounted


def test_http_client_falls_back_to_a_real_transport_when_nothing_is_mounted():
    app = FastAPI()
    client = backends.http_client(app, httpx.Timeout(1.0), base_url="http://ollama.test")
    assert not isinstance(client._transport, StreamingASGITransport)


def _accept_encoding_values(client: httpx.AsyncClient) -> list[str]:
    """Every header on this client whose name matches accept-encoding
    case-insensitively — a dict-merge bug that keeps both casings as two
    separate entries would leave more than one."""
    return [v for k, v in client.headers.multi_items() if k.lower() == "accept-encoding"]


def test_http_client_defaults_accept_encoding_to_identity_with_no_caller_headers():
    app = FastAPI()
    client = backends.http_client(app, httpx.Timeout(1.0), base_url="http://ollama.test")
    assert _accept_encoding_values(client) == ["identity"]


def test_http_client_caller_header_overrides_the_default_same_casing():
    app = FastAPI()
    client = backends.http_client(
        app, httpx.Timeout(1.0), base_url="http://ollama.test",
        headers={"Accept-Encoding": "gzip"},
    )
    assert _accept_encoding_values(client) == ["gzip"]


def test_http_client_caller_header_overrides_the_default_different_casing():
    """S2 seam-hygiene (slice-01-carries.md): the merge used to be a plain
    dict spread, `{"Accept-Encoding": "identity", **headers}` — case-
    sensitive, so a caller header spelled with different casing than the
    default rode alongside it as a SECOND header instead of replacing it.
    Dormant today (nothing calls http_client with its own accept-encoding
    yet), but a caller header of any casing must genuinely override, not
    duplicate."""
    app = FastAPI()
    client = backends.http_client(
        app, httpx.Timeout(1.0), base_url="http://ollama.test",
        headers={"accept-encoding": "gzip"},
    )
    assert _accept_encoding_values(client) == ["gzip"]
