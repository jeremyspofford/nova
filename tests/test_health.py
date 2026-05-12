"""Integration tests: all services return 200 on /health/ready.
Requires: docker compose up (all services running).
"""
import pytest
import httpx

SERVICES = [
    ("agent-core",    "http://localhost:8000"),
    ("memory-service","http://localhost:8002"),
    ("llm-gateway",   "http://localhost:8001"),
    ("chat-surface",  "http://localhost:8004"),
    ("recovery",      "http://localhost:8888"),
    ("dashboard",     "http://localhost:3000"),
]


@pytest.mark.parametrize("name,base_url", SERVICES)
def test_health_live(name: str, base_url: str):
    r = httpx.get(f"{base_url}/health/live", timeout=5)
    assert r.status_code == 200, f"{name} /health/live returned {r.status_code}"


@pytest.mark.parametrize("name,base_url", [s for s in SERVICES if s[0] != "dashboard"])
def test_health_ready(name: str, base_url: str):
    r = httpx.get(f"{base_url}/health/ready", timeout=5)
    assert r.status_code == 200, f"{name} /health/ready returned {r.status_code}"
    data = r.json()
    assert data["status"] == "ok", f"{name} reported status={data['status']}: {data}"
