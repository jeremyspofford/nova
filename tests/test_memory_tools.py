"""Integration tests for the neutral memory API + agent memory tools."""
import os

import httpx
import pytest

ORCH = os.getenv("NOVA_ORCHESTRATOR_URL", "http://localhost:8000")
MEM = os.getenv("NOVA_MEMORY_URL", "http://localhost:8002")
ADMIN_SECRET = os.getenv("NOVA_ADMIN_SECRET", "nova-admin-secret-change-me")
_HDRS = {"X-Admin-Secret": ADMIN_SECRET}


@pytest.mark.asyncio
async def test_active_backend_reported():
    """The neutral API reports which backend is live."""
    async with httpx.AsyncClient(timeout=10) as c:
        resp = await c.get(f"{MEM}/api/v1/memory/backend", headers=_HDRS)
        assert resp.status_code == 200
        assert resp.json().get("backend") == "okf"


@pytest.mark.asyncio
async def test_context_endpoint():
    """context retrieval works on the neutral path for any backend."""
    async with httpx.AsyncClient(timeout=15) as c:
        resp = await c.post(
            f"{MEM}/api/v1/memory/context",
            headers=_HDRS,
            json={"query": "nova-test-memory-search"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert "context" in data
        assert "memory_ids" in data


@pytest.mark.asyncio
async def test_stats_endpoint():
    """stats reports the provider name and item count."""
    async with httpx.AsyncClient(timeout=10) as c:
        resp = await c.get(f"{MEM}/api/v1/memory/stats", headers=_HDRS)
        assert resp.status_code == 200
        data = resp.json()
        assert "provider_name" in data
        assert "total_items" in data


@pytest.mark.asyncio
async def test_memory_tools_registered():
    """Memory tools appear in the orchestrator tool catalog."""
    async with httpx.AsyncClient(timeout=10) as c:
        resp = await c.get(f"{ORCH}/api/v1/tools", headers=_HDRS)
        if resp.status_code != 200:
            pytest.skip(f"tool catalog returned {resp.status_code}")
        blob = resp.text
        for name in ("search_memory", "what_do_i_know", "recall_topic",
                     "read_memory", "remember"):
            assert f'"{name}"' in blob, f"{name} missing from tool catalog"


# ── Brain-page endpoints: graph / PUT / events ───────────────────────────────


@pytest.mark.asyncio
async def test_graph_endpoint():
    """graph returns nodes + edges with the expected node shape."""
    async with httpx.AsyncClient(timeout=15) as c:
        resp = await c.get(f"{MEM}/api/v1/memory/graph", headers=_HDRS)
        assert resp.status_code == 200, resp.text
        g = resp.json()
        assert isinstance(g.get("nodes"), list)
        assert isinstance(g.get("edges"), list)
        for n in g["nodes"]:
            assert {"id", "title", "type", "degree"} <= n.keys()
        # edges are index pairs into nodes
        for a, b in g["edges"]:
            assert 0 <= a < len(g["nodes"]) and 0 <= b < len(g["nodes"])


@pytest.mark.asyncio
async def test_put_item_edit_roundtrip():
    """PUT edits frontmatter + body in place; type change is refused."""
    mid = "topics/nova-test-brain-edit.md"
    async with httpx.AsyncClient(timeout=15) as c:
        # create via ingest with an explicit okf concept
        r = await c.post(
            f"{MEM}/api/v1/memory/ingest", headers=_HDRS,
            json={"raw_text": "seed body", "source_type": "chat",
                  "metadata": {"okf": {"type": "topic", "title": "nova-test-brain-edit"}}},
        )
        assert r.status_code == 201, r.text
        try:
            r = await c.put(
                f"{MEM}/api/v1/memory/item/{mid}", headers=_HDRS,
                json={"frontmatter": {"description": "edited", "tags": ["t"]},
                      "content": "new body"},
            )
            assert r.status_code == 200, r.text
            d = r.json()
            assert d["frontmatter"].get("description") == "edited"
            assert d["content"].strip() == "new body"

            # type is fixed after creation
            r = await c.put(f"{MEM}/api/v1/memory/item/{mid}", headers=_HDRS,
                            json={"frontmatter": {"type": "person"}})
            assert r.status_code == 400
        finally:
            await c.delete(f"{MEM}/api/v1/memory/item/{mid}", headers=_HDRS)

        # gone
        r = await c.get(f"{MEM}/api/v1/memory/item/{mid}", headers=_HDRS)
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_put_item_missing_404():
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.put(
            f"{MEM}/api/v1/memory/item/topics/nova-test-does-not-exist.md",
            headers=_HDRS, json={"frontmatter": {"tags": ["x"]}},
        )
        assert r.status_code == 404


@pytest.mark.asyncio
async def test_events_stream_emits_on_retrieval():
    """A retrieval fires a `retrieval` SSE event on the events stream."""
    import asyncio
    async with httpx.AsyncClient(timeout=15) as c:
        async with c.stream("GET", f"{MEM}/api/v1/memory/events", headers=_HDRS) as s:
            assert s.status_code == 200
            assert "text/event-stream" in s.headers.get("content-type", "")

            async def fire():
                await asyncio.sleep(1.0)
                await c.post(f"{MEM}/api/v1/memory/context", headers=_HDRS,
                             json={"query": "nova-test-sse-probe", "session_id": "nova-test-sse"})

            task = asyncio.create_task(fire())
            got = False
            try:
                async with asyncio.timeout(8):
                    async for line in s.aiter_lines():
                        if line.startswith("event: retrieval"):
                            got = True
                            break
            except (asyncio.TimeoutError, TimeoutError):
                pass
            finally:
                task.cancel()
            assert got, "no retrieval event received on the SSE stream"
