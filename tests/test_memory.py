"""Integration tests for memory-service — requires memory-service running at localhost:8002."""
import httpx
import pytest

BASE = "http://localhost:8002"

_test_ids: list[str] = []


def _write(content: str, source_kind: str = "chat", source_uri: str | None = None) -> str:
    r = httpx.post(
        f"{BASE}/memories",
        json={"content": content, "source_kind": source_kind, "source_uri": source_uri},
    )
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
