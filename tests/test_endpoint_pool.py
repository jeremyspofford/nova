"""Endpoint pool: config CRUD, per-endpoint scoping, degenerate-case invariance.

Adds a fake second endpoint (unreachable by design) and verifies everything is
endpoint-scoped while the default endpoint keeps working untouched — the pool's
core promise. Restores the single-default pool afterwards.
"""
import os

import httpx
from dotenv import dotenv_values

BASE = "http://localhost:8000"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
_secret = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")
ADMIN = {"X-Admin-Secret": _secret}

FAKE = {
    "id": "fake-gpu", "name": "fake-gpu", "engine": "ollama",
    "url": "http://fake-gpu.invalid:11434", "lifecycle": "wake-on-lan",
    "wol_mac_secret": None, "enabled": True,
}


def _get_pool() -> list[dict]:
    r = httpx.get(f"{BASE}/api/v1/llm/endpoints", headers=ADMIN, timeout=15.0)
    assert r.status_code == 200, r.text
    return r.json()["endpoints"]


def _put_pool(eps: list[dict]) -> None:
    r = httpx.put(f"{BASE}/api/v1/llm/endpoints", headers=ADMIN, json={"endpoints": eps}, timeout=15.0)
    assert r.status_code == 200, r.text


def test_default_pool_is_synthesized_from_env():
    eps = _get_pool()
    assert len(eps) >= 1
    default = next(e for e in eps if e["id"] == "default")
    assert default["enabled"] is True
    assert default["lifecycle"] == "always-on"


def test_pool_requires_auth():
    assert httpx.get(f"{BASE}/api/v1/llm/endpoints").status_code == 401


def test_invalid_pool_rejected():
    default = next(e for e in _get_pool() if e["id"] == "default")
    r = httpx.put(f"{BASE}/api/v1/llm/endpoints", headers=ADMIN,
                  json={"endpoints": [default, {**FAKE, "id": "default"}]}, timeout=15.0)
    assert r.status_code == 422
    assert "duplicate" in r.text


def test_second_endpoint_scopes_everything():
    original = _get_pool()
    default = next(e for e in original if e["id"] == "default")
    try:
        _put_pool([default, FAKE])
        assert {e["id"] for e in _get_pool()} == {"default", "fake-gpu"}

        # Unknown endpoint -> 404.
        r = httpx.get(f"{BASE}/api/v1/llm/hardware", headers=ADMIN,
                      params={"endpoint": "nope"}, timeout=15.0)
        assert r.status_code == 404

        # The fake endpoint: profile unknown, recommended renders (manifest is
        # local), nothing installed, pulled reports unreachable.
        hw = httpx.get(f"{BASE}/api/v1/llm/hardware", headers=ADMIN,
                       params={"endpoint": "fake-gpu"}, timeout=15.0).json()
        assert hw["endpoint"] == "fake-gpu"
        assert hw["source"] == "unknown"
        assert hw["inference_url"] == FAKE["url"]

        rec = httpx.get(f"{BASE}/api/v1/llm/models/recommended", headers=ADMIN,
                        params={"endpoint": "fake-gpu"}, timeout=30.0).json()
        assert rec["endpoint"] == "fake-gpu"
        assert len(rec["local"]) > 10
        assert all(e["installed"] is False for e in rec["local"])

        r = httpx.get(f"{BASE}/api/v1/llm/models/pulled", headers=ADMIN,
                      params={"endpoint": "fake-gpu"}, timeout=20.0)
        assert r.status_code == 503

        # The default endpoint is untouched by the pool growing.
        pulled = httpx.get(f"{BASE}/api/v1/llm/models/pulled", headers=ADMIN,
                           params={"endpoint": "default"}, timeout=20.0)
        assert pulled.status_code == 200, pulled.text
        assert len(pulled.json()) > 0

        rec_default = httpx.get(f"{BASE}/api/v1/llm/models/recommended", headers=ADMIN,
                                timeout=30.0).json()
        assert rec_default["endpoint"] == "default"
        assert any(e["installed"] for e in rec_default["local"])

        # Completions still work: routing tries default first and succeeds there.
        r = httpx.post("http://localhost:8001/complete",
                       json={"messages": [{"role": "user", "content": "Reply with exactly: OK"}],
                             "max_tokens": 10},
                       timeout=120.0)
        assert r.status_code == 200, r.text
    finally:
        _put_pool(original)
    assert {e["id"] for e in _get_pool()} == {e["id"] for e in original}
