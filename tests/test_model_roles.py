"""Model roles end-to-end: round trip, validation gates, effective resolution.

The positive path needs at least one installed model (skips otherwise); the
validation tests run everywhere.
"""
import os

import httpx
import pytest
from dotenv import dotenv_values

BASE = "http://localhost:8000"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
_secret = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")
ADMIN = {"X-Admin-Secret": _secret}


def _roles() -> dict:
    r = httpx.get(f"{BASE}/api/v1/llm/models/roles", headers=ADMIN, timeout=15.0)
    assert r.status_code == 200, r.text
    return r.json()


def _installed() -> list[str]:
    r = httpx.get(f"{BASE}/api/v1/llm/models/pulled", headers=ADMIN, timeout=20.0)
    if r.status_code != 200:
        return []
    return [m["name"].removesuffix(":latest") for m in r.json()]


def test_roles_require_auth():
    assert httpx.get(f"{BASE}/api/v1/llm/models/roles").status_code == 401


def test_roles_shape():
    body = _roles()
    assert set(body["roles"]) == {"completion", "extraction", "embedding"}
    for v in body["roles"].values():
        assert v["source"] in ("env", "override")


def test_uninstalled_model_rejected():
    r = httpx.put(f"{BASE}/api/v1/llm/models/roles", headers=ADMIN,
                  json={"completion": "definitely-not-installed:99b"}, timeout=20.0)
    assert r.status_code == 422
    assert "not installed" in r.text


def test_round_trip_with_installed_model():
    names = _installed()
    candidate = next((n for n in names if "embed" not in n), None)
    if candidate is None:
        pytest.skip("no non-embedding model installed")

    original = _roles()["overrides"] if "overrides" in _roles() else {}
    try:
        r = httpx.put(f"{BASE}/api/v1/llm/models/roles", headers=ADMIN,
                      json={"extraction": candidate}, timeout=20.0)
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["roles"]["extraction"]["model"] == candidate
        assert body["roles"]["extraction"]["source"] == "override"
        assert _roles()["roles"]["extraction"]["source"] == "override"
    finally:
        httpx.put(f"{BASE}/api/v1/llm/models/roles", headers=ADMIN,
                  json={"extraction": original.get("extraction") or ""}, timeout=20.0)


def test_embedding_role_refuses_non_embedding_model():
    names = _installed()
    non_embed = next((n for n in names if "embed" not in n), None)
    if non_embed is None:
        pytest.skip("no non-embedding model installed")
    r = httpx.put(f"{BASE}/api/v1/llm/models/roles", headers=ADMIN,
                  json={"embedding": non_embed}, timeout=20.0)
    # Capability-determinable hosts refuse; unknown-capability hosts allow.
    if r.status_code == 422:
        assert "embedding" in r.text
    else:
        assert r.status_code == 200
        httpx.put(f"{BASE}/api/v1/llm/models/roles", headers=ADMIN,
                  json={"embedding": ""}, timeout=20.0)
