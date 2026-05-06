"""Integration test configuration — real services, no mocks."""
from __future__ import annotations

import asyncio
import os
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
import redis as redis_lib
from dotenv import load_dotenv

# Load .env from repo root
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# FC-002: services refuse to start with the literal default admin secret.
# In CI / fresh dev environments where .env.example is used as-is, set the
# bypass so services come up. Real deployments must run scripts/install.sh
# (which generates a strong secret) and never need this flag.
os.environ.setdefault("NOVA_ALLOW_DEFAULT_ADMIN_SECRET", "1")

# ---------------------------------------------------------------------------
# Service base URLs (override via env vars if services are on different hosts)
# ---------------------------------------------------------------------------
ORCHESTRATOR_URL = os.getenv("NOVA_ORCHESTRATOR_URL", "http://localhost:8000")
LLM_GATEWAY_URL = os.getenv("NOVA_LLM_GATEWAY_URL", "http://localhost:8001")
MEMORY_URL = os.getenv("NOVA_MEMORY_URL", "http://localhost:8002")
CHAT_API_URL = os.getenv("NOVA_CHAT_API_URL", "http://localhost:8080")
RECOVERY_URL = os.getenv("NOVA_RECOVERY_URL", "http://localhost:8888")
KNOWLEDGE_WORKER_URL = os.getenv("NOVA_KNOWLEDGE_WORKER_URL", "http://localhost:8120")
CORTEX_URL = os.getenv("NOVA_CORTEX_URL", "http://localhost:8100")

ADMIN_SECRET = os.getenv("NOVA_ADMIN_SECRET", "")
REQUIRE_AUTH = os.getenv("REQUIRE_AUTH", "false").lower() == "true"

SERVICE_URLS = {
    "orchestrator": ORCHESTRATOR_URL,
    "llm-gateway": LLM_GATEWAY_URL,
    "memory-service": MEMORY_URL,
    "chat-api": CHAT_API_URL,
    "recovery": RECOVERY_URL,
}

# Optional services started via --profile flags; excluded from parametrized health tests
OPTIONAL_SERVICE_URLS = {
    "knowledge-worker": KNOWLEDGE_WORKER_URL,
    "cortex": CORTEX_URL,
}


# ---------------------------------------------------------------------------
# Markers & session-scoped event loop
# ---------------------------------------------------------------------------
def pytest_configure(config: pytest.Config) -> None:
    config.addinivalue_line("markers", "requires_llm: skip unless an LLM provider is available")
    config.addinivalue_line("markers", "pipeline: full pipeline tests requiring LLM provider")
    config.addinivalue_line("markers", "slow: marker for long-running e2e tests (~3-5 min)")
    config.addinivalue_line(
        "markers",
        "requires_local_ollama: skip if the local-ollama compose profile is not active",
    )
    config.addinivalue_line(
        "markers",
        "requires_github: skip unless REQUIRES_GITHUB=1 and NOVA_GITHUB_PAT are set "
        "(real-GitHub e2e tests against jeremyspofford/nova-test-cap)",
    )


def _local_ollama_in_profiles() -> bool:
    """True iff `local-ollama` is in the active COMPOSE_PROFILES.

    `load_dotenv` at module import has already populated os.environ from the
    repo's `.env`, so this picks up the value `make dev` would see.
    """
    raw = os.environ.get("COMPOSE_PROFILES", "") or ""
    return "local-ollama" in [p.strip() for p in raw.split(",") if p.strip()]


@pytest.fixture(scope="session")
def local_ollama_active() -> bool:
    return _local_ollama_in_profiles()


def pytest_collection_modifyitems(config, items):
    """Skip `requires_local_ollama` and `requires_github` tests when their gating
    env / profile is missing.

    Both markers are evaluated independently — a test marked with both stays
    skipped if either gate is closed.
    """
    # ── requires_local_ollama: tied to COMPOSE_PROFILES=local-ollama ──────────
    if not _local_ollama_in_profiles():
        skip_ollama = pytest.mark.skip(
            reason="local-ollama profile is not active (COMPOSE_PROFILES)"
        )
        for item in items:
            if "requires_local_ollama" in item.keywords:
                item.add_marker(skip_ollama)

    # ── requires_github: tied to REQUIRES_GITHUB=1 + NOVA_GITHUB_PAT ──────────
    # Aligns with tests/test_capability_smoke_real_github.py's gating env vars.
    requires_github_active = (
        os.environ.get("REQUIRES_GITHUB") == "1"
        and bool(os.environ.get("NOVA_GITHUB_PAT", ""))
    )
    if not requires_github_active:
        skip_github = pytest.mark.skip(
            reason="REQUIRES_GITHUB not set (need REQUIRES_GITHUB=1 and NOVA_GITHUB_PAT=ghp_...)"
        )
        for item in items:
            if "requires_github" in item.keywords:
                item.add_marker(skip_github)


def pytest_sessionstart(session):
    """Sweep leaked `nova-test-*` goals from cortex's queue before any test runs.

    Tests that crash mid-poll or are Ctrl-C'd leave goals behind. Cortex's
    serve drive then services those leaked goals ahead of fresh test goals,
    starving new tests within their poll windows. Worst case observed: 10
    leaked goals from accumulated runs; fresh maturation tests timed out
    waiting their turn.

    Not async — uses sync httpx so it runs cleanly in the session-start hook.
    Fail-soft: if the orchestrator isn't reachable, log and continue.
    """
    if not ADMIN_SECRET:
        return
    try:
        with httpx.Client(timeout=5) as client:
            r = client.get(
                f"{ORCHESTRATOR_URL}/api/v1/goals?status=active",
                headers={"X-Admin-Secret": ADMIN_SECRET},
            )
            if r.status_code != 200:
                return
            goals = r.json()
            test_goals = [
                g for g in goals
                if (g.get("title") or "").lower().startswith("nova-test-")
            ]
            if not test_goals:
                return
            print(f"\n[conftest] Sweeping {len(test_goals)} leaked nova-test-* goals…")
            for g in test_goals:
                client.delete(
                    f"{ORCHESTRATOR_URL}/api/v1/goals/{g['id']}?cascade=true",
                    headers={"X-Admin-Secret": ADMIN_SECRET},
                )
    except Exception as e:
        print(f"\n[conftest] Goal-sweep skipped: {e}")


# ---------------------------------------------------------------------------
# Session-scoped async clients (function-scoped to avoid event loop issues)
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def orchestrator():
    async with httpx.AsyncClient(base_url=ORCHESTRATOR_URL, timeout=30) as client:
        yield client


@pytest_asyncio.fixture
async def llm_gateway():
    async with httpx.AsyncClient(base_url=LLM_GATEWAY_URL, timeout=30) as client:
        yield client


@pytest_asyncio.fixture
async def memory():
    async with httpx.AsyncClient(base_url=MEMORY_URL, timeout=30) as client:
        yield client


@pytest_asyncio.fixture
async def chat_api():
    async with httpx.AsyncClient(base_url=CHAT_API_URL, timeout=30) as client:
        yield client


@pytest_asyncio.fixture
async def recovery():
    async with httpx.AsyncClient(base_url=RECOVERY_URL, timeout=30) as client:
        yield client


@pytest_asyncio.fixture
async def knowledge_worker():
    async with httpx.AsyncClient(base_url=KNOWLEDGE_WORKER_URL, timeout=30) as client:
        yield client


@pytest_asyncio.fixture
async def cortex():
    async with httpx.AsyncClient(base_url=CORTEX_URL, timeout=30) as client:
        yield client


# ---------------------------------------------------------------------------
# Redis sync clients (for fixtures that need to set config before HTTP calls)
# ---------------------------------------------------------------------------
@pytest.fixture
def redis_db1():
    """Sync Redis client on db=1 (llm-gateway runtime config). Closes on teardown."""
    client = redis_lib.Redis(host="localhost", port=6379, db=1, decode_responses=True)
    yield client
    client.close()


# ---------------------------------------------------------------------------
# Admin headers helper
# ---------------------------------------------------------------------------
@pytest.fixture
def admin_headers() -> dict[str, str]:
    return {"X-Admin-Secret": ADMIN_SECRET}


# ---------------------------------------------------------------------------
# Test API key — created per test that needs it, revoked at teardown
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def test_api_key(orchestrator: httpx.AsyncClient, admin_headers: dict):
    resp = await orchestrator.post(
        "/api/v1/keys",
        json={"name": "nova-test-key", "rate_limit_rpm": 9999},
        headers=admin_headers,
    )
    if resp.status_code not in (200, 201):
        pytest.skip(f"Could not create test API key: {resp.status_code} {resp.text}")

    data = resp.json()
    raw_key = data["raw_key"]
    key_id = data["id"]

    yield {"raw_key": raw_key, "key_id": key_id, "headers": {"X-API-Key": raw_key}}

    # Teardown: revoke the test key
    if key_id:
        await orchestrator.delete(f"/api/v1/keys/{key_id}", headers=admin_headers)


# ---------------------------------------------------------------------------
# LLM availability check
# ---------------------------------------------------------------------------
@pytest_asyncio.fixture
async def llm_available(llm_gateway: httpx.AsyncClient) -> bool:
    try:
        resp = await llm_gateway.get("/models")
        if resp.status_code == 200:
            models = resp.json()
            return len(models) > 0
    except Exception:
        pass
    return False


@pytest_asyncio.fixture
async def pool():
    """Direct asyncpg connection pool for tests that need raw DB access (e.g. audit chain).

    Registers the same JSON/JSONB codecs as orchestrator/app/db.py so that dict
    values can be passed to JSONB parameters without manual json.dumps.
    """
    import json

    import asyncpg

    async def _init_connection(conn: asyncpg.Connection) -> None:
        await conn.set_type_codec(
            "json",
            encoder=json.dumps,
            decoder=json.loads,
            schema="pg_catalog",
        )
        await conn.set_type_codec(
            "jsonb",
            encoder=json.dumps,
            decoder=json.loads,
            schema="pg_catalog",
        )

    dsn = os.getenv(
        "DATABASE_URL",
        f"postgresql://nova:{os.getenv('POSTGRES_PASSWORD', 'nova_dev_password')}@localhost:5432/nova",
    )
    # Strip SQLAlchemy driver prefix if present
    dsn = dsn.replace("postgresql+asyncpg://", "postgresql://")
    pg_pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2, init=_init_connection)
    yield pg_pool
    await pg_pool.close()


@pytest_asyncio.fixture
async def create_test_pod(orchestrator: httpx.AsyncClient, admin_headers: dict):
    """Factory fixture — creates a pod with configurable agents, auto-deletes on teardown."""
    created_pod_ids = []

    async def _create(name: str, agents: list[dict], **pod_kwargs) -> dict:
        pod_name = f"nova-test-{name}"
        resp = await orchestrator.post(
            "/api/v1/pods",
            json={"name": pod_name, "description": f"Test pod: {name}", "enabled": True, **pod_kwargs},
            headers=admin_headers,
        )
        assert resp.status_code in (200, 201), f"Failed to create pod: {resp.text}"
        pod = resp.json()
        created_pod_ids.append(pod["id"])

        for agent_cfg in agents:
            resp = await orchestrator.post(
                f"/api/v1/pods/{pod['id']}/agents",
                json=agent_cfg,
                headers=admin_headers,
            )
            assert resp.status_code in (200, 201), f"Failed to create agent: {resp.text}"

        return pod

    yield _create

    for pod_id in created_pod_ids:
        await orchestrator.delete(f"/api/v1/pods/{pod_id}", headers=admin_headers)


@pytest_asyncio.fixture
async def force_cleanup_task(orchestrator: httpx.AsyncClient, admin_headers: dict):
    """Tracks task IDs and force-deletes them on teardown (even non-terminal tasks)."""
    task_ids = []

    def _track(task_id: str):
        task_ids.append(task_id)

    yield _track

    for task_id in task_ids:
        await orchestrator.post(
            f"/api/v1/pipeline/tasks/{task_id}/cancel",
            headers=admin_headers,
        )
        await orchestrator.delete(
            f"/api/v1/pipeline/tasks/{task_id}",
            headers=admin_headers,
        )


@pytest_asyncio.fixture
async def pipeline_task(orchestrator: httpx.AsyncClient, admin_headers: dict, force_cleanup_task):
    """Submit a pipeline task and poll until terminal state."""
    async def _submit(user_input: str, pod_name: str | None = None, timeout: int = 120, poll_interval: int = 3) -> dict:
        body = {"user_input": user_input}
        if pod_name:
            body["pod_name"] = pod_name
        resp = await orchestrator.post(
            "/api/v1/pipeline/tasks",
            json=body,
            headers=admin_headers,
        )
        assert resp.status_code == 202, resp.text
        task_id = resp.json().get("task_id") or resp.json().get("id")
        force_cleanup_task(task_id)

        data = {}
        for _ in range(timeout // poll_interval):
            await asyncio.sleep(poll_interval)
            resp = await orchestrator.get(f"/api/v1/pipeline/tasks/{task_id}", headers=admin_headers)
            assert resp.status_code == 200
            data = resp.json()
            if data["status"] in ("complete", "completed", "failed", "cancelled", "clarification_needed", "pending_human_review"):
                return data

        pytest.fail(f"Task {task_id} did not reach terminal state within {timeout}s (last: {data.get('status')})")

    yield _submit
