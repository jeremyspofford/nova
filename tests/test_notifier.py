"""Push-notification channel (ntfy) — config, test-send, delivery.

Requires the ntfy container (always-on core) and the orchestrator.
"""
from __future__ import annotations

import json

import httpx
import pytest
from conftest import ORCHESTRATOR_URL

NTFY_URL = "http://localhost:8290"


@pytest.fixture
def notify_config(admin_headers):
    r = httpx.get(f"{ORCHESTRATOR_URL}/api/v1/notify/config", headers=admin_headers, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()


def test_ntfy_server_healthy():
    r = httpx.get(f"{NTFY_URL}/v1/health", timeout=5)
    assert r.status_code == 200
    assert r.json().get("healthy") is True


def test_notify_config_requires_admin():
    r = httpx.get(f"{ORCHESTRATOR_URL}/api/v1/notify/config", timeout=10)
    # Trusted-network deployments answer 200; hardened ones 401/403 —
    # both are acceptable postures, but a 404 would mean the router is gone.
    assert r.status_code in (200, 401, 403)


def test_notify_config_shape(notify_config):
    assert set(notify_config) >= {"enabled", "server_url", "topic", "subscribe_hint"}
    assert notify_config["topic"].startswith("nova-"), "topic must be seeded at startup"


def test_send_and_deliver(notify_config, admin_headers):
    """POST /notify/test then poll the topic — the message must be retrievable."""
    r = httpx.post(f"{ORCHESTRATOR_URL}/api/v1/notify/test", headers=admin_headers, timeout=15)
    assert r.status_code == 200, r.text
    assert r.json()["sent"] is True

    topic = notify_config["topic"]
    poll = httpx.get(f"{NTFY_URL}/{topic}/json?poll=1", timeout=10)
    assert poll.status_code == 200
    messages = [json.loads(line) for line in poll.text.splitlines() if line.strip()]
    titles = [m.get("title", "") for m in messages if m.get("event") == "message"]
    assert any("Nova test notification" in t for t in titles), (
        f"test notification not found in topic cache; saw {titles[-5:]}"
    )
