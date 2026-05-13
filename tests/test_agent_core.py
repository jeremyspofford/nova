"""Integration tests for agent-core — requires services at localhost:8000 + 8001.
LLM-dependent tests skip if no provider is configured.
"""
import json
import os
import time
import uuid

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


def test_auth_providers_includes_admin_secret():
    """GET /api/v1/auth/providers includes admin_secret so the dashboard can auto-configure."""
    r = httpx.get(f"{BASE}/api/v1/auth/providers", timeout=5.0)
    assert r.status_code == 200
    data = r.json()
    assert "admin_secret" in data
    assert data["admin_secret"], "admin_secret should be non-empty"


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


def test_api_health_ready_route():
    """GET /api/health/ready returns 200 — the nginx-proxied alias for /health/ready."""
    r = httpx.get(f"{BASE}/api/health/ready", timeout=5.0)
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_llm_providers_via_api():
    """GET /api/v1/llm/providers returns providers list through agent-core proxy."""
    r = httpx.get(f"{BASE}/api/v1/llm/providers", headers=ADMIN, timeout=5.0)
    assert r.status_code == 200
    data = r.json()
    assert "providers" in data
    assert "routing_strategy" in data


def test_llm_providers_requires_auth():
    """GET /api/v1/llm/providers without auth is 401."""
    r = httpx.get(f"{BASE}/api/v1/llm/providers", timeout=5.0)
    assert r.status_code == 401


# ── Conversation history ──────────────────────────────────────────────────────

def test_task_messages_history_persists():
    """Second message in a task includes the first exchange in LLM context.
    Verified indirectly: GET /api/v1/tasks/{id}/messages returns all turns."""
    if not _llm_available():
        pytest.skip("no LLM provider configured")

    task_id = str(uuid.uuid4())

    # First turn
    r = httpx.post(
        f"{BASE}/api/v1/tasks/{task_id}/message",
        json={"text": "My name is TestUser. Please acknowledge this."},
        headers=ADMIN,
        timeout=30.0,
    )
    assert r.status_code == 200
    # Consume the stream
    first_response = "".join(
        json.loads(line).get("text", "")
        for line in r.text.strip().splitlines()
        if line
    )
    assert first_response, "first response should be non-empty"

    # Check history endpoint has 2 messages (user + assistant)
    r2 = httpx.get(f"{BASE}/api/v1/tasks/{task_id}/messages", headers=ADMIN, timeout=5.0)
    assert r2.status_code == 200
    msgs = r2.json()
    assert len(msgs) == 2
    roles = [m["role"] for m in msgs]
    assert roles == ["user", "assistant"]

    # Second turn — ask something that requires remembering the first
    r3 = httpx.post(
        f"{BASE}/api/v1/tasks/{task_id}/message",
        json={"text": "What is my name?"},
        headers=ADMIN,
        timeout=30.0,
    )
    assert r3.status_code == 200
    second_response = "".join(
        json.loads(line).get("text", "")
        for line in r3.text.strip().splitlines()
        if line
    )
    assert "TestUser" in second_response, (
        f"LLM should recall the name from history but got: {second_response!r}"
    )

    # History should now have 4 messages
    r4 = httpx.get(f"{BASE}/api/v1/tasks/{task_id}/messages", headers=ADMIN, timeout=5.0)
    assert len(r4.json()) == 4


def test_task_messages_endpoint_empty_for_new_task():
    """GET /api/v1/tasks/{id}/messages on a brand-new task returns empty list."""
    # Create task first
    r = httpx.post(
        f"{BASE}/api/v1/tasks",
        json={"goal": "nova-test: messages endpoint"},
        headers=ADMIN,
        timeout=5.0,
    )
    task_id = r.json()["id"]

    r2 = httpx.get(f"{BASE}/api/v1/tasks/{task_id}/messages", headers=ADMIN, timeout=5.0)
    assert r2.status_code == 200
    assert r2.json() == []


def test_task_messages_requires_auth():
    """GET /api/v1/tasks/{id}/messages without auth is 401."""
    r = httpx.get(f"{BASE}/api/v1/tasks/00000000-0000-0000-0000-000000000000/messages")
    assert r.status_code == 401
