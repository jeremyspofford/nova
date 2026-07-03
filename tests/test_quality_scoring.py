"""Integration tests for AI quality measurement system."""
import httpx
import pytest
import pytest_asyncio

MEMORY_BASE = "http://localhost:8002"
ORCH_BASE = "http://localhost:8000"


@pytest_asyncio.fixture
async def memory_client():
    async with httpx.AsyncClient(base_url=MEMORY_BASE, timeout=10) as client:
        yield client


@pytest_asyncio.fixture
async def orchestrator_client():
    async with httpx.AsyncClient(base_url=ORCH_BASE, timeout=10) as client:
        yield client


@pytest.fixture
def admin_headers() -> dict[str, str]:
    return {"X-Admin-Secret": "nova-admin-secret-change-me"}


class TestMemoryItemEndpoint:
    """GET /api/v1/memory/item/{id} returns full item content (quality scorer path)."""

    async def test_item_nonexistent_returns_404(self, memory_client: httpx.AsyncClient):
        r = await memory_client.get("/api/v1/memory/item/topics/nova-test-does-not-exist.md")
        assert r.status_code == 404

    async def test_item_roundtrip(self, memory_client: httpx.AsyncClient):
        """Ingest a memory as a concept file, fetch it by id, then delete it."""
        ingest_r = await memory_client.post("/api/v1/memory/ingest", json={
            "raw_text": "nova-test-quality: Python is my favorite language",
            "source_type": "chat",
            "metadata": {"okf": {
                "type": "note",
                "title": "nova-test-quality item",
                "target": "topics/nova-test-quality-item.md",
            }},
        })
        assert ingest_r.status_code == 201
        item_ids = ingest_r.json().get("item_ids", [])
        assert item_ids, "Ingest must return item_ids"

        try:
            r = await memory_client.get(f"/api/v1/memory/item/{item_ids[0]}")
            assert r.status_code == 200
            item = r.json()
            assert item["memory_id"] == item_ids[0]
            assert "Python is my favorite language" in item["content"]
        finally:
            d = await memory_client.delete(f"/api/v1/memory/item/{item_ids[0]}")
            assert d.status_code in (204, 404)


class TestQualityAPI:
    """Quality score API endpoints."""

    async def test_scores_endpoint_returns_200(
        self, orchestrator_client: httpx.AsyncClient, admin_headers: dict
    ):
        r = await orchestrator_client.get(
            "/api/v1/quality/scores?granularity=daily",
            headers=admin_headers,
        )
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    async def test_summary_endpoint_returns_200(
        self, orchestrator_client: httpx.AsyncClient, admin_headers: dict
    ):
        r = await orchestrator_client.get(
            "/api/v1/quality/summary?period=7d",
            headers=admin_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert "dimensions" in data
        assert "composite" in data
        assert "period_days" in data

    async def test_summary_requires_admin(
        self, orchestrator_client: httpx.AsyncClient
    ):
        from conftest import REQUIRE_AUTH
        if not REQUIRE_AUTH:
            pytest.skip("REQUIRE_AUTH=false — auth enforcement not active")
        r = await orchestrator_client.get("/api/v1/quality/summary?period=7d")
        assert r.status_code in (401, 403)


class TestBenchmarkAPI:
    """Quality benchmark run API endpoints."""

    async def test_benchmark_results_endpoint(
        self, orchestrator_client: httpx.AsyncClient, admin_headers: dict
    ):
        r = await orchestrator_client.get(
            "/api/v1/benchmarks/quality-results",
            headers=admin_headers,
        )
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    async def test_benchmark_results_requires_admin(
        self, orchestrator_client: httpx.AsyncClient
    ):
        from conftest import REQUIRE_AUTH
        if not REQUIRE_AUTH:
            pytest.skip("REQUIRE_AUTH=false — auth enforcement not active")
        r = await orchestrator_client.get("/api/v1/benchmarks/quality-results")
        assert r.status_code in (401, 403)
