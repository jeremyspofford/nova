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


class TestEngramBatchEndpoint:
    """POST /api/v1/engrams/batch returns engram content by ID list."""

    async def test_batch_empty_ids(self, memory_client: httpx.AsyncClient):
        r = await memory_client.post("/api/v1/engrams/batch", json={"ids": []})
        assert r.status_code == 200
        assert r.json() == []

    async def test_batch_nonexistent_ids(self, memory_client: httpx.AsyncClient):
        fake_id = "00000000-0000-0000-0000-000000000099"
        r = await memory_client.post("/api/v1/engrams/batch", json={"ids": [fake_id]})
        assert r.status_code == 200
        assert r.json() == []

    async def test_batch_returns_content(self, memory_client: httpx.AsyncClient):
        """Ingest an engram, then fetch it via batch endpoint."""
        ingest_r = await memory_client.post("/api/v1/engrams/ingest", json={
            "raw_text": "nova-test-quality: Python is my favorite language",
            "source_type": "chat",
        })
        assert ingest_r.status_code == 201
        engram_ids = ingest_r.json().get("engram_ids", [])
        if not engram_ids:
            pytest.skip("Ingest did not return engram_ids (async decomposition)")

        r = await memory_client.post("/api/v1/engrams/batch", json={"ids": engram_ids})
        assert r.status_code == 200
        results = r.json()
        assert len(results) > 0
        assert "id" in results[0]
        assert "content" in results[0]
        assert "node_type" in results[0]


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
