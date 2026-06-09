"""Integration tests for memory-service — requires memory-service running at localhost:8002."""
import asyncio
import time
from pathlib import Path

import httpx
import pytest

BASE = "http://localhost:8002"

_test_ids: list[str] = []


def _pg_dsn() -> str:
    """Build a DSN for direct DB pokes (aging rows, checking embeddings)."""
    password = "changeme"
    env_file = Path(__file__).parent.parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("POSTGRES_PASSWORD="):
                password = line.split("=", 1)[1].strip()
    return f"postgresql://nova:{password}@localhost:5432/nova"


def _db_execute(sql: str, *args):
    """Run one statement against postgres synchronously."""
    import asyncpg

    async def _run():
        conn = await asyncpg.connect(_pg_dsn())
        try:
            return await conn.fetchval(sql, *args)
        finally:
            await conn.close()

    return asyncio.run(_run())


def _wait_embedded(memory_id: str, timeout: float = 150.0) -> None:
    """Block until the embed worker has vectorized the row — semantic search
    only sees rows with embeddings, so ranking tests must wait or they race
    the async embed queue."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if _db_execute(
            "SELECT embedding IS NOT NULL FROM memories WHERE id = $1::uuid", memory_id
        ):
            return
        time.sleep(0.5)
    pytest.fail(f"memory {memory_id} never embedded within {timeout}s")


def _write(content: str, source_kind: str = "chat", source_uri: str | None = None) -> str:
    r = httpx.post(
        f"{BASE}/memories",
        json={"content": content, "source_kind": source_kind, "source_uri": source_uri},
    )
    assert r.status_code == 201, r.text
    memory_id = r.json()["id"]
    _test_ids.append(memory_id)
    return memory_id


def _write_full(payload: dict) -> str:
    r = httpx.post(f"{BASE}/memories", json=payload)
    assert r.status_code == 201, r.text
    memory_id = r.json()["id"]
    _test_ids.append(memory_id)
    return memory_id


@pytest.fixture(autouse=True)
def cleanup():
    _test_ids.clear()
    yield
    for mid in _test_ids:
        httpx.delete(f"{BASE}/memories/{mid}")


def test_write_returns_id():
    memory_id = _write("Nova test write returns id content")
    assert isinstance(memory_id, str)
    assert len(memory_id) == 36  # UUID


def test_write_unknown_source_kind_is_accepted():
    memory_id = _write("Nova test content", source_kind="nova_test_kind")
    assert memory_id


def test_get_returns_correct_fields():
    memory_id = _write("Nova test get memory content", source_kind="task_output",
                       source_uri="task:nova-test-xyz")
    r = httpx.get(f"{BASE}/memories/{memory_id}")
    assert r.status_code == 200
    data = r.json()
    assert data["id"] == memory_id
    assert data["content"] == "Nova test get memory content"
    assert data["source_kind"] == "task_output"
    assert data["source_uri"] == "task:nova-test-xyz"
    assert data["used_count"] == 0


def test_get_nonexistent_returns_404():
    r = httpx.get(f"{BASE}/memories/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


def test_mark_used_increments_count():
    memory_id = _write("Nova test mark used")
    httpx.patch(f"{BASE}/memories/{memory_id}/used")
    httpx.patch(f"{BASE}/memories/{memory_id}/used")
    r = httpx.get(f"{BASE}/memories/{memory_id}")
    assert r.json()["used_count"] == 2


def test_stats_has_required_fields():
    r = httpx.get(f"{BASE}/memories/stats")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data["total_rows"], int)
    assert isinstance(data["table_size_bytes"], int)
    assert isinstance(data["embedding_coverage_pct"], float)
    assert isinstance(data["degraded"], bool)


def test_search_returns_results_shape():
    _write("Nova test search anthropic api key setup content")
    r = httpx.post(f"{BASE}/memories/search", json={"query": "anthropic api", "limit": 5})
    assert r.status_code == 200
    data = r.json()
    assert "results" in data
    assert "degraded" in data
    assert isinstance(data["results"], list)


def test_search_source_kind_filter():
    _write("Nova test chat memory abc xyz", source_kind="chat")
    _write("Nova test task memory abc xyz", source_kind="task_output")
    r = httpx.post(
        f"{BASE}/memories/search",
        json={"query": "nova test memory abc xyz", "source_kinds": ["chat"], "limit": 20},
    )
    assert r.status_code == 200
    for result in r.json()["results"]:
        assert result["source_kind"] == "chat"


def test_search_empty_query_returns_ok():
    r = httpx.post(f"{BASE}/memories/search", json={"query": "", "limit": 5})
    assert r.status_code == 200


# ── continuity memory: kind + importance (Task 1) ────────────────────────────


def test_write_kind_importance_roundtrip():
    memory_id = _write_full({
        "content": "Nova test kind importance roundtrip content",
        "source_kind": "chat",
        "kind": "preference",
        "importance": 0.9,
    })
    r = httpx.get(f"{BASE}/memories/{memory_id}")
    assert r.status_code == 200
    data = r.json()
    assert data["kind"] == "preference"
    assert abs(data["importance"] - 0.9) < 1e-6


def test_write_defaults_kind_and_importance():
    memory_id = _write("Nova test default kind importance content")
    data = httpx.get(f"{BASE}/memories/{memory_id}").json()
    assert data["kind"] == "fact"
    assert abs(data["importance"] - 0.5) < 1e-6


def test_write_importance_out_of_range_rejected():
    r = httpx.post(f"{BASE}/memories", json={
        "content": "Nova test bad importance",
        "source_kind": "chat",
        "importance": 1.5,
    })
    assert r.status_code == 422


# ── continuity memory: salience ranking (Task 2) ─────────────────────────────


def _search(query: str, limit: int = 10) -> list[dict]:
    r = httpx.post(f"{BASE}/memories/search", json={"query": query, "limit": limit})
    assert r.status_code == 200, r.text
    return r.json()["results"]


def test_salience_fields_present_in_results():
    mid = _write("Nova salience fields test zanzibar quokka lighthouse")
    _wait_embedded(mid)
    results = _search("zanzibar quokka lighthouse")
    mine = [m for m in results if m["id"] == mid]
    assert mine, "freshly written memory not found in search"
    for key in ("salience", "kind", "importance", "similarity"):
        assert key in mine[0], f"missing {key} in search result"


def test_salience_reinforcement_ranks_used_first():
    # Identical content → identical embeddings → exact similarity tie.
    # Only the reinforcement signal can break it.
    text = "Nova reinforcement test: the sprocket flange calibration is blue-green"
    a = _write(text)
    b = _write(text)
    _wait_embedded(a)
    _wait_embedded(b)
    for _ in range(5):
        httpx.patch(f"{BASE}/memories/{b}/used")
    results = _search("sprocket flange calibration color")
    mine = [m for m in results if m["id"] in (a, b)]
    assert mine, "neither test memory found"
    assert all("salience" in m for m in mine), "salience missing from results"
    assert mine[0]["id"] == b, "reinforced memory should outrank unused twin"


def test_salience_devalue_not_bury():
    """An old, never-recalled memory must still win on a uniquely matching query."""
    old = _write("Nova devalue test: the maroon zeppelin hangar code is 7741")
    fresh = _write("Nova devalue test: today's lunch special is minestrone soup")
    _wait_embedded(old)
    _wait_embedded(fresh)
    _db_execute(
        "UPDATE memories SET created_at = now() - interval '120 days' WHERE id = $1::uuid",
        old,
    )
    results = _search("maroon zeppelin hangar code")
    mine = [m for m in results if m["id"] in (old, fresh)]
    assert mine and all("salience" in m for m in mine)
    assert mine[0]["id"] == old, "high-similarity old memory was buried by freshness"


def test_salience_importance_orders_equal_similarity():
    # Identical content again — similarity tie, importance must decide.
    text = "Nova importance test: the cobalt walrus prefers morning swims"
    lo = _write_full({"content": text, "source_kind": "chat", "importance": 0.1})
    hi = _write_full({"content": text, "source_kind": "chat", "importance": 0.9})
    _wait_embedded(lo)
    _wait_embedded(hi)
    results = _search("cobalt walrus swim preference")
    mine = [m for m in results if m["id"] in (lo, hi)]
    assert mine and all("salience" in m for m in mine)
    assert mine[0]["id"] == hi, "higher-importance memory should rank first"
