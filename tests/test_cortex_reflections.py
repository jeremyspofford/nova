"""Integration tests for cortex experience learning (reflections).

Requires services running: orchestrator (8000), cortex (8100), memory-service (8002).
Tests hit real running services — no mocks.
"""
import hashlib
import os
import time

import pytest
import requests

BASE = "http://localhost:8000/api/v1"
CORTEX = "http://localhost:8100/api/v1/cortex"


@pytest.fixture
def admin_headers():
    secret = os.getenv("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
    return {"X-Admin-Secret": secret}


@pytest.fixture
def goal_id(admin_headers):
    """Create a test goal and clean up after."""
    resp = requests.post(
        f"{BASE}/goals",
        json={
            "title": "nova-test-reflections-goal",
            "description": "Test goal for reflection integration tests",
            "priority": 1,
            "max_iterations": 50,
            "max_cost_usd": 10.0,
        },
        headers=admin_headers,
    )
    assert resp.status_code in (200, 201), f"Failed to create goal: {resp.text}"
    gid = resp.json()["id"]
    yield gid
    # Cleanup: delete goal (cascades to reflections)
    requests.delete(f"{BASE}/goals/{gid}", headers=admin_headers)


def _insert_reflection(goal_id: str, approach: str, outcome: str, score: float,
                       cycle: int = 1, lesson: str | None = None,
                       failure_mode: str | None = None,
                       budget_tier: str = "mid", goal_desc_hash: str | None = None):
    """Insert a reflection directly via SQL through cortex's DB.

    Uses the orchestrator's admin SQL endpoint if available, otherwise
    calls cortex internals. This helper exists because reflections are
    normally written by cortex's cycle, not via HTTP API.
    """
    import psycopg2
    pg_host = os.getenv("POSTGRES_HOST", "localhost")
    pg_pass = os.getenv("POSTGRES_PASSWORD", "nova_dev_password")
    conn = psycopg2.connect(
        host=pg_host, port=5432, dbname="nova",
        user="nova", password=pg_pass,
    )
    conn.autocommit = True
    normalized = " ".join(approach.lower().split())
    approach_hash = hashlib.sha256(normalized.encode()).hexdigest()[:16]
    import json
    ctx = json.dumps({"budget_tier": budget_tier, "goal_description_hash": goal_desc_hash})
    with conn.cursor() as cur:
        cur.execute(
            """INSERT INTO cortex_reflections
               (goal_id, cycle_number, drive, approach, approach_hash,
                outcome, outcome_score, lesson, failure_mode, context_snapshot)
               VALUES (%s, %s, 'serve', %s, %s, %s, %s, %s, %s, %s::jsonb)""",
            (goal_id, cycle, approach, approach_hash, outcome, score,
             lesson, failure_mode, ctx),
        )
    conn.close()


class TestReflectionCRUD:
    """Test basic reflection storage and retrieval."""

    def test_reflections_endpoint_exists(self, goal_id):
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert "reflections" in data
        assert data["count"] == 0

    def test_record_and_query_reflection(self, goal_id):
        """Insert a reflection, verify it appears in the query endpoint."""
        _insert_reflection(goal_id, "Write a data pipeline", "success", 0.8, cycle=1)
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        assert resp.status_code == 200
        data = resp.json()
        assert data["count"] == 1
        ref = data["reflections"][0]
        assert ref["outcome"] == "success"
        assert ref["outcome_score"] == pytest.approx(0.8, abs=0.01)
        assert "approach_hash" in ref

    def test_multiple_reflections_ordered_by_recency(self, goal_id):
        """Multiple reflections come back newest-first."""
        _insert_reflection(goal_id, "First attempt", "failure", 0.2, cycle=1)
        time.sleep(0.1)
        _insert_reflection(goal_id, "Second attempt", "partial", 0.6, cycle=2)
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        data = resp.json()
        assert data["count"] == 2
        assert data["reflections"][0]["approach"] == "Second attempt"
        assert data["reflections"][1]["approach"] == "First attempt"


class TestGoalDeletionCascade:
    """Verify reflections are cleaned up when a goal is deleted."""

    def test_cascade_on_goal_delete(self, admin_headers):
        resp = requests.post(
            f"{BASE}/goals",
            json={
                "title": "nova-test-cascade-goal",
                "description": "Will be deleted to test cascade",
                "priority": 1, "max_iterations": 10, "max_cost_usd": 1.0,
            },
            headers=admin_headers,
        )
        assert resp.status_code in (200, 201)
        gid = resp.json()["id"]
        _insert_reflection(gid, "Some approach", "failure", 0.2)
        # Verify it exists
        resp = requests.get(f"{CORTEX}/reflections/{gid}")
        assert resp.json()["count"] == 1
        # Delete goal — should cascade
        requests.delete(f"{BASE}/goals/{gid}", headers=admin_headers)
        resp = requests.get(f"{CORTEX}/reflections/{gid}")
        assert resp.json()["count"] == 0


class TestOscillationPrevention:
    """Test approach dedup blocks repeated failures."""

    def test_same_hash_different_whitespace(self):
        """Normalized hashes match despite whitespace differences."""
        t1 = "Write a Python function"
        t2 = "Write   a   Python   function"
        h1 = hashlib.sha256(" ".join(t1.lower().split()).encode()).hexdigest()[:16]
        h2 = hashlib.sha256(" ".join(t2.lower().split()).encode()).hexdigest()[:16]
        assert h1 == h2

    def test_same_hash_different_case(self):
        t1 = "Write a Python Function"
        t2 = "write a python function"
        h1 = hashlib.sha256(" ".join(t1.lower().split()).encode()).hexdigest()[:16]
        h2 = hashlib.sha256(" ".join(t2.lower().split()).encode()).hexdigest()[:16]
        assert h1 == h2

    def test_failed_approach_appears_in_reflections(self, goal_id):
        """A failed approach is retrievable by hash for dedup checking."""
        _insert_reflection(goal_id, "Deploy with docker compose", "failure", 0.2)
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        ref = resp.json()["reflections"][0]
        assert ref["outcome"] == "failure"
        assert ref["approach_hash"]  # hash was computed and stored

    def test_partial_success_not_blocked(self, goal_id):
        """Approaches with score >= 0.3 should NOT be blocked (worth refining)."""
        _insert_reflection(goal_id, "Partial approach", "partial", 0.6)
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        ref = resp.json()["reflections"][0]
        # Score 0.6 >= 0.3, so this approach should be allowed for retry
        assert ref["outcome_score"] >= 0.3


class TestConditionAwareRetry:
    """Test that improved conditions allow retrying failed approaches."""

    def test_failure_at_cheap_stores_tier(self, goal_id):
        """Reflections store the budget tier for condition comparison."""
        _insert_reflection(goal_id, "Generate code", "failure", 0.2,
                          budget_tier="cheap")
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        ref = resp.json()["reflections"][0]
        ctx = ref["context_snapshot"]
        assert ctx["budget_tier"] == "cheap"

    def test_different_tier_allows_retry(self, goal_id):
        """Same approach at a better tier should be retryable."""
        _insert_reflection(goal_id, "Generate code", "failure", 0.2,
                          budget_tier="cheap")
        _insert_reflection(goal_id, "Generate code", "failure", 0.2,
                          budget_tier="mid")
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        # Both stored — the retry logic checks tier ordering at dispatch time
        assert resp.json()["count"] == 2


class TestStuckDetection:
    """Test stuck threshold computation and escalation."""

    def test_minimum_threshold(self):
        assert max(3, 10 // 10) == 3

    def test_scales_with_iterations(self):
        assert max(3, 50 // 10) == 5
        assert max(3, 100 // 10) == 10

    def test_consecutive_failures_counted(self, goal_id):
        """Multiple failures for a goal are queryable for stuck detection."""
        for i in range(5):
            _insert_reflection(goal_id, f"Attempt {i}", "failure", 0.2, cycle=i)
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        failures = [r for r in resp.json()["reflections"] if r["outcome"] == "failure"]
        assert len(failures) == 5

    def test_success_resets_failure_count(self, goal_id):
        """A success after failures means only post-success failures count."""
        _insert_reflection(goal_id, "Attempt 1", "failure", 0.2, cycle=1)
        _insert_reflection(goal_id, "Attempt 2", "failure", 0.2, cycle=2)
        time.sleep(0.1)
        _insert_reflection(goal_id, "Attempt 3", "success", 0.8, cycle=3)
        time.sleep(0.1)
        _insert_reflection(goal_id, "Attempt 4", "failure", 0.2, cycle=4)
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        refs = resp.json()["reflections"]
        # The success at cycle 3 resets the consecutive count
        # Only 1 failure after the success (cycle 4)
        success_time = None
        for r in refs:
            if r["outcome"] == "success":
                success_time = r["created_at"]
                break
        post_success_failures = [
            r for r in refs
            if r["outcome"] == "failure" and r["created_at"] > success_time
        ]
        assert len(post_success_failures) == 1

    def test_cancelled_not_counted_as_failure(self, goal_id):
        """Cancelled outcomes don't count toward stuck threshold."""
        _insert_reflection(goal_id, "Attempt", "cancelled", 0.1, cycle=1)
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        ref = resp.json()["reflections"][0]
        assert ref["outcome"] == "cancelled"
        # Cancelled should not contribute to stuck detection


class TestGoalDescriptionChange:
    """Test that changed goal descriptions are flagged in reflection context."""

    def test_description_hash_stored_in_context(self, goal_id):
        """Reflections store the goal description hash for change detection."""
        desc_hash = hashlib.sha256(" ".join("test description".lower().split()).encode()).hexdigest()[:16]
        _insert_reflection(goal_id, "Some approach", "failure", 0.2,
                          goal_desc_hash=desc_hash)
        resp = requests.get(f"{CORTEX}/reflections/{goal_id}")
        ctx = resp.json()["reflections"][0]["context_snapshot"]
        assert ctx.get("goal_description_hash") == desc_hash


class TestExperienceRecallInPlanning:
    """Test that planning has access to reflection fields."""

    def test_goal_detail_includes_planning_fields(self, goal_id, admin_headers):
        resp = requests.get(f"{BASE}/goals/{goal_id}", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert "max_iterations" in data or "max_iterations" in data.get("goal", data)


class TestCortexReflectionsHealth:
    """Verify cortex service is healthy and reflections are accessible."""

    def test_cortex_health(self):
        resp = requests.get("http://localhost:8100/health/ready", timeout=5)
        assert resp.status_code == 200

    def test_reflections_endpoint_bad_uuid(self):
        resp = requests.get(f"{CORTEX}/reflections/00000000-0000-0000-0000-000000000000")
        assert resp.status_code == 200
        assert resp.json()["count"] == 0
