"""Memory-service tools: search, write."""
import httpx
from ..registry import tool, Tier
from ..context import ToolContext
from ...config import settings

_mem_client: httpx.AsyncClient | None = None


def get_mem_client() -> httpx.AsyncClient:
    global _mem_client
    if _mem_client is None:
        _mem_client = httpx.AsyncClient(timeout=8.0)
    return _mem_client


async def close_mem_client() -> None:
    global _mem_client
    if _mem_client:
        await _mem_client.aclose()
        _mem_client = None


@tool(tier=Tier.READ, cap_scope="memory:search", timeout_s=10, name="memory.search")
async def memory_search(query: str, limit: int = 10, *, ctx: ToolContext) -> dict:
    """Semantic + keyword search across stored memories."""
    r = await get_mem_client().post(
        f"{settings.memory_service_url}/memories/search",
        json={"query": query, "limit": limit, "mode": "hybrid"},
    )
    r.raise_for_status()
    return r.json()


@tool(tier=Tier.MUTATE, reversible=True, cap_scope="memory:write", timeout_s=10, name="memory.write")
async def memory_write(
    content: str,
    source_kind: str = "task_output",
    kind: str = "fact",
    importance: float = 0.5,
    *,
    ctx: ToolContext,
) -> dict:
    """Store a piece of knowledge. kind: fact|preference|event|insight;
    importance 0-1 weights how strongly it surfaces in future recall."""
    r = await get_mem_client().post(
        f"{settings.memory_service_url}/memories",
        json={
            "content": content,
            "source_kind": source_kind,
            "kind": kind,
            "importance": max(0.0, min(1.0, importance)),
        },
    )
    r.raise_for_status()
    return r.json()
