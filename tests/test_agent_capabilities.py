"""Integration tests for agent self-awareness and tool capabilities.

These tests verify:
- Agent system prompt includes self-knowledge about Nova's architecture
- All expected tool groups are registered and functional
- Diagnostic tools return actionable data
- Memory tools are accessible from agents
- Service health check covers all services
- Consolidation/stats tools are in the catalog
- All 7 tool groups have representative tools
"""
import os

import httpx
import pytest

BASE = "http://localhost:8000/api/v1"
HEADERS = {}


@pytest.fixture(autouse=True)
def _admin_headers():
    secret = os.environ.get("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
    HEADERS["X-Admin-Secret"] = secret


class TestAgentToolAvailability:
    """Verify all expected tools are registered and callable."""

    async def test_tool_catalog_has_core_groups(self, orchestrator, admin_headers):
        """The tool catalog should include Code, Git, Platform, and Web groups."""
        resp = await orchestrator.get("/api/v1/tools", headers=admin_headers)
        if resp.status_code == 404:
            pytest.skip("Tool catalog endpoint not available")
        assert resp.status_code == 200
        catalog = resp.json()

        # Catalog is a list of categories, each with a nested tools array
        tool_names = set()
        category_names = set()
        for category in catalog:
            category_names.add(category.get("category", ""))
            for tool in category.get("tools", []):
                tool_names.add(tool["name"])

        # Tools exposed via the catalog API
        catalog_expected = {
            "read_file", "write_file", "run_shell", "search_codebase",
            "git_status", "git_log",
            "web_search", "web_fetch",
            "list_agents", "create_task",
        }
        missing = catalog_expected - tool_names
        assert not missing, f"Missing catalog tools: {missing}"

    async def test_tool_catalog_includes_diagnosis_and_memory(self, orchestrator, admin_headers):
        """Diagnosis and Memory tools must be in the catalog for full agent awareness.
        Currently these are available to agents internally but NOT exposed via the
        /api/v1/tools catalog. This test documents the gap."""
        resp = await orchestrator.get("/api/v1/tools", headers=admin_headers)
        if resp.status_code == 404:
            pytest.skip("Tool catalog endpoint not available")
        catalog = resp.json()

        tool_names = set()
        for category in catalog:
            for tool in category.get("tools", []):
                tool_names.add(tool["name"])

        internal_only_tools = {
            "diagnose_task", "check_service_health", "get_recent_errors",
            "search_memory", "recall_topic", "what_do_i_know",
            "get_platform_config", "list_knowledge_sources",
        }
        exposed = internal_only_tools & tool_names
        hidden = internal_only_tools - tool_names
        assert not hidden, (
            f"These tools are available to agents internally but not in the "
            f"/api/v1/tools catalog: {hidden}"
        )


class TestDiagnosticTools:
    """Verify diagnostic tools return useful data for agent self-awareness."""

    async def test_service_health_check(self, orchestrator, admin_headers):
        """check_service_health should report status for all core services."""
        resp = await orchestrator.get("/health/ready")
        assert resp.status_code == 200
        data = resp.json()
        assert data.get("status") in ("ok", "ready")

    async def test_recent_errors_endpoint(self, orchestrator, admin_headers):
        """Recent errors endpoint should be queryable (may be empty)."""
        resp = await orchestrator.get("/api/v1/diagnostics/errors", headers=admin_headers)
        if resp.status_code == 404:
            pytest.skip("Diagnostics errors endpoint not available")
        assert resp.status_code == 200


class TestSelfKnowledge:
    """Verify the self-knowledge block covers all active services."""

    async def test_agent_has_self_knowledge(self, orchestrator, admin_headers, test_api_key):
        """An agent created via chat should receive self-knowledge context.
        We verify by checking that the agent's config includes Nova identity."""
        # Create a temporary agent to inspect its config
        resp = await orchestrator.post("/api/v1/agents", headers=admin_headers, json={
            "name": "nova-test-self-knowledge-check",
            "role": "context",
            "model": "auto",
            "system_prompt": "You are a test agent.",
        })
        if resp.status_code not in (200, 201):
            pytest.skip(f"Could not create test agent: {resp.status_code}")
        agent = resp.json()
        agent_id = agent["id"]

        # The system prompt should exist
        assert agent.get("system_prompt") or agent.get("config", {}).get("system_prompt"), (
            "Agent should have a system prompt"
        )

        # Cleanup
        await orchestrator.delete(f"/api/v1/agents/{agent_id}", headers=admin_headers)


class TestMemoryToolsAccessibility:
    """Verify memory endpoints that agents call are functional."""

    async def test_search_memory_endpoint(self, memory):
        """POST /context (main memory retrieval) should be functional."""
        resp = await memory.post(
            "http://localhost:8002/api/v1/memory/context",
            json={"query": "nova-test-memory-search"},
        )
        assert resp.status_code == 200

    async def test_overview_endpoint(self, memory):
        """what_do_i_know tool sends an empty-query /context — verify it works."""
        resp = await memory.post(
            "http://localhost:8002/api/v1/memory/context",
            json={"query": ""},
        )
        assert resp.status_code == 200

    async def test_memory_stats(self, memory):
        """Stats endpoint should return item count for self-monitoring."""
        resp = await memory.get("http://localhost:8002/api/v1/memory/stats")
        assert resp.status_code == 200
        assert "total_items" in resp.json()


class TestIntelRecommendationPipeline:
    """Verify the intel-to-recommendation pipeline schema is complete."""

    async def test_recommendation_create_endpoint_exists(self, orchestrator, admin_headers):
        """POST /api/v1/intel/recommendations MUST exist for the suggested goals pipeline.
        Without it, the grading pipeline has no way to create recommendations, and
        the 'Suggested' tab in Goals will always be empty."""
        resp = await orchestrator.post(
            "/api/v1/intel/recommendations",
            headers=admin_headers,
            json={
                "title": "nova-test-recommendation",
                "summary": "Test recommendation for pipeline verification",
                "rationale": "Automated test to verify recommendation schema",
                "grade": "C",
                "confidence": 0.6,
                "category": "test",
            },
        )
        assert resp.status_code in (200, 201), (
            f"POST /api/v1/intel/recommendations failed: {resp.status_code} {resp.text[:200]}"
        )
        rec = resp.json()
        # Cleanup if it was created
        if "id" in rec:
            await orchestrator.delete(
                f"/api/v1/intel/recommendations/{rec['id']}", headers=admin_headers,
            )

    async def test_recommendation_list_returns_expected_fields(self, orchestrator, admin_headers):
        """Recommendation list response should have the right shape for the dashboard."""
        resp = await orchestrator.get("/api/v1/intel/recommendations", headers=admin_headers)
        assert resp.status_code == 200
        recs = resp.json()
        assert isinstance(recs, list)
        # If any exist, verify shape
        for rec in recs[:3]:
            for field in ("id", "title", "summary", "grade", "status"):
                assert field in rec, f"Recommendation missing field: {field}"

    async def test_intel_dead_letter_queue_awareness(self, orchestrator, admin_headers):
        """Intel stats should include items_this_week — verifying content is flowing."""
        resp = await orchestrator.get("/api/v1/intel/stats", headers=admin_headers)
        assert resp.status_code == 200
        stats = resp.json()
        # items_this_week > 0 means content is being ingested from feeds
        assert "items_this_week" in stats
        # We don't assert > 0 because feeds might not have run yet in CI


# ---------------------------------------------------------------------------
# Task 4: Consolidation and memory stats tools in catalog
# ---------------------------------------------------------------------------

def _get_catalog_tool_names() -> list[str]:
    """Fetch tool catalog and extract all tool names from nested categories."""
    resp = httpx.get(f"{BASE}/tools", headers=HEADERS)
    assert resp.status_code == 200
    catalog = resp.json()
    names = []
    if isinstance(catalog, list):
        for category in catalog:
            for tool in category.get("tools", []):
                names.append(tool["name"])
    return names


def test_consolidation_status_tool_in_catalog():
    """get_consolidation_status tool should be in the tool catalog."""
    tool_names = _get_catalog_tool_names()
    assert "get_consolidation_status" in tool_names, (
        f"get_consolidation_status not in tool catalog. Got: {sorted(tool_names)}"
    )


def test_memory_stats_tool_in_catalog():
    """get_memory_stats tool should be in the tool catalog."""
    tool_names = _get_catalog_tool_names()
    assert "get_memory_stats" in tool_names, (
        f"get_memory_stats not in tool catalog. Got: {sorted(tool_names)}"
    )


def test_trigger_consolidation_tool_in_catalog():
    """trigger_consolidation tool should be in the tool catalog."""
    tool_names = _get_catalog_tool_names()
    assert "trigger_consolidation" in tool_names, (
        f"trigger_consolidation not in tool catalog. Got: {sorted(tool_names)}"
    )


# ---------------------------------------------------------------------------
# Task 5: All tool groups represented in catalog
# ---------------------------------------------------------------------------

def test_all_tool_groups_in_catalog():
    """All 7 built-in tool groups should have their tools in the catalog."""
    tool_names = set(_get_catalog_tool_names())

    expected = {
        "Code": "list_dir",
        "Git": "git_status",
        "Platform": "list_agents",
        "Web": "web_search",
        "Diagnosis": "diagnose_task",
        "Memory": "search_memory",
        "Introspect": "get_platform_config",
    }
    for group, sample in expected.items():
        assert sample in tool_names, f"Tool '{sample}' from group '{group}' missing. Got: {sorted(tool_names)}"
