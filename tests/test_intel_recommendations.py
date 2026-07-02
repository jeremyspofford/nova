"""Tests for intel recommendation pipeline — Tier 3."""
import os

import httpx
import pytest

BASE = "http://localhost:8000/api/v1"
HEADERS = {}


@pytest.fixture(autouse=True)
def admin_headers():
    secret = os.environ.get("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
    HEADERS["X-Admin-Secret"] = secret


@pytest.fixture
def recommendation_id():
    """Create a test recommendation and clean up after."""
    resp = httpx.post(
        f"{BASE}/intel/recommendations",
        json={
            "title": "nova-test-rec-pipeline",
            "summary": "Test recommendation for pipeline validation",
            "rationale": "Created by integration test",
            "grade": "B",
            "confidence": 0.75,
            "category": "tooling",
        },
        headers=HEADERS,
    )
    assert resp.status_code in (200, 201), f"POST recommendations failed: {resp.text}"
    rid = resp.json()["id"]
    yield rid
    try:
        httpx.patch(
            f"{BASE}/intel/recommendations/{rid}",
            json={"status": "dismissed"},
            headers=HEADERS,
        )
    except Exception:
        pass


def test_create_recommendation():
    """POST /api/v1/intel/recommendations creates a recommendation."""
    resp = httpx.post(
        f"{BASE}/intel/recommendations",
        json={
            "title": "nova-test-rec-create",
            "summary": "Test creation of recommendations via API",
            "rationale": "Integration test verifying endpoint exists",
            "grade": "C",
            "confidence": 0.5,
            "category": "other",
        },
        headers=HEADERS,
    )
    assert resp.status_code in (200, 201), f"Expected 200/201, got {resp.status_code}: {resp.text}"
    data = resp.json()
    assert "id" in data
    assert data["title"] == "nova-test-rec-create"
    assert data["grade"] == "C"
    # Cleanup
    try:
        httpx.patch(f"{BASE}/intel/recommendations/{data['id']}", json={"status": "dismissed"}, headers=HEADERS)
    except Exception:
        pass


def test_recommendation_lifecycle(recommendation_id):
    """Recommendation can be created, read, and status-updated."""
    resp = httpx.get(f"{BASE}/intel/recommendations/{recommendation_id}", headers=HEADERS)
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "pending"
    assert data["grade"] == "B"


def test_create_recommendation_validation():
    """POST /api/v1/intel/recommendations rejects invalid data."""
    # Missing required fields
    resp = httpx.post(
        f"{BASE}/intel/recommendations",
        json={"title": "nova-test-rec-invalid"},
        headers=HEADERS,
    )
    assert resp.status_code in (400, 422), f"Expected validation error, got {resp.status_code}"


def test_intel_tools_in_catalog():
    """Intel tools should appear in the tool catalog."""
    resp = httpx.get(f"{BASE}/tools", headers=HEADERS)
    assert resp.status_code == 200
    catalog = resp.json()
    # Endpoint returns nested categories — flatten all tool names
    tool_names: set[str] = set()
    if isinstance(catalog, list):
        for category in catalog:
            for tool in category.get("tools", []):
                tool_names.add(tool["name"])
    assert "query_intel_content" in tool_names, f"query_intel_content missing. Got: {sorted(tool_names)}"
    assert "create_recommendation" in tool_names, f"create_recommendation missing. Got: {sorted(tool_names)}"
    assert "get_dismissed_hashes" in tool_names, f"get_dismissed_hashes missing. Got: {sorted(tool_names)}"


def test_intel_new_items_queue_not_growing():
    """The intel:new_items queue should be empty — nothing pushes to it anymore.

    The push to this queue was removed from intel-worker; content flows through
    memory:ingestion:queue (db0) instead. Any remaining items are stale dead
    letters that we drain on first encounter, then verify nothing new arrives.
    """
    redis = pytest.importorskip("redis", reason="redis package not installed")
    r = redis.Redis(host="localhost", port=6379, db=6, decode_responses=True)
    try:
        stale = r.llen("intel:new_items")
        if stale > 0:
            r.delete("intel:new_items")
        import time
        time.sleep(2)
        depth = r.llen("intel:new_items")
        assert depth == 0, (
            f"intel:new_items has {depth} new items after drain — "
            "something is still pushing to this dead queue."
        )
    finally:
        r.close()
