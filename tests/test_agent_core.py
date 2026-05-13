"""Integration tests for agent-core — requires services at localhost:8000 + 8001.
LLM-dependent tests skip if no provider is configured.
"""
import json
import os
import time

import httpx
import pytest
from dotenv import dotenv_values

BASE = "http://localhost:8000"
_env = dotenv_values(os.path.join(os.path.dirname(__file__), "..", ".env"))
_secret = _env.get("NOVA_ADMIN_SECRET") or os.getenv("NOVA_ADMIN_SECRET", "nova-dev-secret")
ADMIN = {"X-Admin-Secret": _secret}


def _llm_available() -> bool:
    try:
        r = httpx.get("http://localhost:8001/providers", timeout=3.0)
        return r.status_code == 200 and len(r.json().get("providers", [])) > 0
    except Exception:
        return False


def test_health_ready():
    r = httpx.get(f"{BASE}/health/ready", timeout=5.0)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_create_task_returns_pending():
    r = httpx.post(
        f"{BASE}/api/v1/tasks",
        json={"goal": "nova-test: ping"},
        headers=ADMIN,
        timeout=5.0,
    )
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "pending"
    assert "id" in data


def test_task_unauthenticated_is_401():
    r = httpx.post(f"{BASE}/api/v1/tasks", json={"goal": "test"})
    assert r.status_code == 401


def test_task_runs_to_terminal_state():
    if not _llm_available():
        pytest.skip("no LLM provider configured")

    r = httpx.post(
        f"{BASE}/api/v1/tasks",
        json={"goal": "nova-test: respond with exactly the word DONE and stop"},
        headers=ADMIN,
    )
    task_id = r.json()["id"]

    for _ in range(30):
        r = httpx.get(f"{BASE}/api/v1/tasks/{task_id}", headers=ADMIN)
        status = r.json()["status"]
        if status in ("completed", "failed"):
            break
        time.sleep(1)

    assert status in ("completed", "failed")


def test_task_events_have_chain_hashes():
    if not _llm_available():
        pytest.skip("no LLM provider configured")

    r = httpx.post(
        f"{BASE}/api/v1/tasks",
        json={"goal": "nova-test: chain hash test"},
        headers=ADMIN,
    )
    task_id = r.json()["id"]
    time.sleep(2)

    r = httpx.get(f"{BASE}/api/v1/tasks/{task_id}/events", headers=ADMIN)
    assert r.status_code == 200
    events = r.json()["events"]
    assert len(events) > 0

    event_types = {e["event_type"] for e in events}
    assert "task_started" in event_types

    for e in events:
        assert len(e["chain_hash"]) == 64
        assert all(c in "0123456789abcdef" for c in e["chain_hash"])


def test_list_approvals_unauthenticated():
    r = httpx.get(f"{BASE}/api/v1/approvals")
    assert r.status_code == 401


def test_list_approvals_authenticated():
    r = httpx.get(f"{BASE}/api/v1/approvals", headers=ADMIN)
    assert r.status_code == 200
    assert isinstance(r.json()["approvals"], list)


def test_grant_unknown_approval_is_404():
    r = httpx.post(
        f"{BASE}/api/v1/approvals/00000000-0000-0000-0000-000000000000/grant",
        json={},
        headers=ADMIN,
    )
    assert r.status_code == 404


def test_deny_unknown_approval_is_404():
    r = httpx.post(
        f"{BASE}/api/v1/approvals/00000000-0000-0000-0000-000000000000/deny",
        headers=ADMIN,
    )
    assert r.status_code == 404


def test_auth_providers_returns_trusted_network():
    """GET /api/v1/auth/providers is public and signals trusted-network auth model."""
    r = httpx.get(f"{BASE}/api/v1/auth/providers", timeout=5.0)
    assert r.status_code == 200
    data = r.json()
    assert "trusted_network" in data
    assert data["trusted_network"] is True
    assert "google" in data
    assert "registration_mode" in data


def test_tasks_list_requires_auth():
    """GET /api/v1/tasks without a secret should be 401."""
    r = httpx.get(f"{BASE}/api/v1/tasks", timeout=5.0)
    assert r.status_code == 401


def test_tasks_list_returns_array():
    """GET /api/v1/tasks with admin secret returns a JSON array."""
    r = httpx.get(f"{BASE}/api/v1/tasks", headers=ADMIN, timeout=5.0)
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
