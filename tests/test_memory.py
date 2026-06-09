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


# ── continuity memory: profile (Task 3) ──────────────────────────────────────


def test_profile_returns_facts_and_preferences_by_importance():
    pref = _write_full({
        "content": "Nova profile test: user prefers tabs over spaces",
        "source_kind": "chat", "kind": "preference", "importance": 0.95,
    })
    hi_fact = _write_full({
        "content": "Nova profile test: user works on the Nova platform",
        "source_kind": "chat", "kind": "fact", "importance": 0.9,
    })
    lo_fact = _write_full({
        "content": "Nova profile test: user mentioned a one-off lunch order",
        "source_kind": "chat", "kind": "fact", "importance": 0.05,
    })
    event = _write_full({
        "content": "Nova profile test: user restarted docker yesterday",
        "source_kind": "chat", "kind": "event", "importance": 0.99,
    })

    r = httpx.get(f"{BASE}/memories/profile", params={"limit": 50})
    assert r.status_code == 200, r.text
    entries = r.json()["profile"]
    ids = [e["id"] for e in entries]

    assert pref in ids, "high-importance preference missing from profile"
    assert hi_fact in ids, "high-importance fact missing from profile"
    assert event not in ids, "event kind must never appear in profile"
    # Importance ordering, not just kind filtering:
    if lo_fact in ids:
        assert ids.index(hi_fact) < ids.index(lo_fact), "profile not importance-ordered"


# ── continuity memory: extraction (Task 4) ───────────────────────────────────


def _llm_responsive(timeout: float = 20.0) -> bool:
    """Probe llm-gateway with a tiny completion. CPU-only boxes with a 7B
    default model fail this — extraction quality tests skip honestly there."""
    try:
        r = httpx.post(
            "http://localhost:8001/complete",
            json={"messages": [{"role": "user", "content": "Say OK"}], "max_tokens": 5},
            timeout=timeout,
        )
        return r.status_code == 200 and bool(r.json().get("content"))
    except Exception:
        return False


def _purge_marker_rows(marker: str) -> None:
    """Delete any rows containing the marker — keeps reruns deterministic even
    when a previous failed run leaked rows before tracking them. Uses a prefix
    of the marker: small extraction models sometimes misspell the tail of a
    nonsense token, and the leaked row must still match."""
    _db_execute("DELETE FROM memories WHERE content ILIKE $1", f"%{marker[:8]}%")


def _collect_extracted(marker: str, deadline_s: float = 150.0, predicate=None) -> list[dict]:
    """Poll keyword search until extraction (or its fallback) lands rows
    containing the marker token and satisfying `predicate`. Tracks ids for
    cleanup. Keeps polling past non-matching hits — the extract worker may
    still be mid-flight when the first row shows up."""
    deadline = time.monotonic() + deadline_s
    last_hits: list[dict] = []
    while time.monotonic() < deadline:
        r = httpx.post(f"{BASE}/memories/search", json={"query": marker, "limit": 20})
        if r.status_code == 200:
            hits = [m for m in r.json()["results"] if marker.lower() in m["content"].lower()]
            for h in hits:
                if h["id"] not in _test_ids:
                    _test_ids.append(h["id"])
            if hits:
                last_hits = hits
                if predicate is None or any(predicate(h) for h in hits):
                    return hits
        time.sleep(2)
    return last_hits


def test_extract_returns_202_and_never_loses_content():
    marker = "flombozzle"  # nonsense token that survives extraction or fallback
    _purge_marker_rows(marker)
    exchange = (
        f"User: Remember that my project codename is {marker} and I want weekly status updates.\n"
        f"Nova: Got it — {marker} it is, weekly updates noted."
    )
    r = httpx.post(f"{BASE}/memories", json={
        "content": exchange, "source_kind": "chat", "extract": True,
    })
    assert r.status_code == 202, r.text
    assert r.json().get("queued") is True

    hits = _collect_extracted(marker)
    assert hits, "extraction lost the exchange — no memory row contains the marker"


def test_extract_produces_structured_kinds():
    if not _llm_responsive():
        pytest.skip("llm-gateway completion too slow/unavailable (CPU-only local model)")

    marker = "grimblewock"
    _purge_marker_rows(marker)
    exchange = (
        f"User: My favorite editor is neovim and my dog is named {marker}.\n"
        f"Nova: Noted — neovim fan with a dog called {marker}."
    )
    r = httpx.post(f"{BASE}/memories", json={
        "content": exchange, "source_kind": "chat", "extract": True,
    })
    assert r.status_code == 202

    valid_kinds = {"fact", "preference", "event", "insight"}

    def _is_structured(m: dict) -> bool:
        return m["kind"] in valid_kinds and "User:" not in m["content"]

    hits = _collect_extracted(marker, predicate=_is_structured)
    assert hits, "no extracted memories appeared"
    structured = [h for h in hits if _is_structured(h)]
    assert structured, f"no structured (non-transcript) memories among: {[h['content'][:60] for h in hits]}"


def test_extract_ignores_assistant_claims():
    """Nova's own assertions must never become user facts — otherwise a
    hallucinated answer poisons memory and outranks the truth on recency
    (observed live: model answered 'blue', extraction stored 'Favorite color
    is blue' at importance 0.95, burying the user's actual 'teal')."""
    if not _llm_responsive():
        pytest.skip("llm-gateway completion too slow/unavailable (CPU-only local model)")

    marker = "vermilliox"
    _purge_marker_rows(marker)
    exchange = (
        "User: What's my favorite color?\n"
        f"Nova: Your favorite color is {marker}."
    )
    r = httpx.post(f"{BASE}/memories", json={
        "content": exchange, "source_kind": "chat", "extract": True,
    })
    assert r.status_code == 202

    hits = _collect_extracted(marker, deadline_s=60.0)
    poisoned = [
        h for h in hits
        if h["kind"] in ("fact", "preference") and "User:" not in h["content"]
    ]
    assert not poisoned, (
        f"assistant's claim was laundered into user facts: "
        f"{[h['content'][:60] for h in poisoned]}"
    )
