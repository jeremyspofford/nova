"""Integration tests for /api/v1/secrets — requires agent-core running at localhost:8000."""
import os
import pytest
import httpx

BASE = os.environ.get("AGENT_CORE_URL", "http://localhost:8000")
HEADERS = {"X-Admin-Secret": "nova-dev-secret"}

TEST_NAMES = ["nova_test_secret_a", "nova_test_secret_b"]


@pytest.fixture(autouse=True)
def cleanup():
    yield
    for name in TEST_NAMES:
        httpx.delete(f"{BASE}/api/v1/secrets/{name}", headers=HEADERS)


def test_create_returns_201():
    r = httpx.post(
        f"{BASE}/api/v1/secrets",
        json={"name": "nova_test_secret_a", "value": "sk-test", "purpose": "test"},
        headers=HEADERS,
    )
    assert r.status_code == 201


def test_list_contains_created_secret():
    httpx.post(f"{BASE}/api/v1/secrets", json={"name": "nova_test_secret_a", "value": "sk-test"}, headers=HEADERS)
    r = httpx.get(f"{BASE}/api/v1/secrets", headers=HEADERS)
    assert r.status_code == 200
    names = [s["name"] for s in r.json()]
    assert "nova_test_secret_a" in names


def test_value_never_appears_in_list_response():
    httpx.post(f"{BASE}/api/v1/secrets", json={"name": "nova_test_secret_a", "value": "ultra-secret-12345"}, headers=HEADERS)
    r = httpx.get(f"{BASE}/api/v1/secrets", headers=HEADERS)
    assert "ultra-secret-12345" not in r.text


def test_resolve_returns_plaintext():
    httpx.post(f"{BASE}/api/v1/secrets", json={"name": "nova_test_secret_a", "value": "resolved-value-xyz"}, headers=HEADERS)
    r = httpx.post(f"{BASE}/api/v1/secrets/resolve", json={"name": "nova_test_secret_a"}, headers=HEADERS)
    assert r.status_code == 200
    assert r.json()["value"] == "resolved-value-xyz"


def test_resolve_missing_returns_404():
    r = httpx.post(f"{BASE}/api/v1/secrets/resolve", json={"name": "nova_test_nonexistent"}, headers=HEADERS)
    assert r.status_code == 404


def test_update_value():
    httpx.post(f"{BASE}/api/v1/secrets", json={"name": "nova_test_secret_a", "value": "original"}, headers=HEADERS)
    httpx.patch(f"{BASE}/api/v1/secrets/nova_test_secret_a", json={"value": "rotated"}, headers=HEADERS)
    r = httpx.post(f"{BASE}/api/v1/secrets/resolve", json={"name": "nova_test_secret_a"}, headers=HEADERS)
    assert r.json()["value"] == "rotated"


def test_update_purpose_only():
    httpx.post(f"{BASE}/api/v1/secrets", json={"name": "nova_test_secret_a", "value": "val", "purpose": "old purpose"}, headers=HEADERS)
    httpx.patch(f"{BASE}/api/v1/secrets/nova_test_secret_a", json={"purpose": "new purpose"}, headers=HEADERS)
    r = httpx.get(f"{BASE}/api/v1/secrets", headers=HEADERS)
    secret = next(s for s in r.json() if s["name"] == "nova_test_secret_a")
    assert secret["purpose"] == "new purpose"


def test_delete_removes_secret():
    httpx.post(f"{BASE}/api/v1/secrets", json={"name": "nova_test_secret_a", "value": "to-delete"}, headers=HEADERS)
    r = httpx.delete(f"{BASE}/api/v1/secrets/nova_test_secret_a", headers=HEADERS)
    assert r.status_code == 204
    r = httpx.delete(f"{BASE}/api/v1/secrets/nova_test_secret_a", headers=HEADERS)
    assert r.status_code == 404


def test_invalid_name_rejected():
    r = httpx.post(f"{BASE}/api/v1/secrets", json={"name": "Has-Uppercase", "value": "x"}, headers=HEADERS)
    assert r.status_code == 422


def test_requires_admin_secret():
    r = httpx.get(f"{BASE}/api/v1/secrets")
    assert r.status_code in (401, 403, 422)


def test_wrong_admin_secret_rejected():
    r = httpx.get(f"{BASE}/api/v1/secrets", headers={"X-Admin-Secret": "wrong-secret"})
    assert r.status_code == 403
