"""Memory-service tools: search, write."""
import httpx
from ..registry import tool, Tier
from ..context import ToolContext
from ...config import settings


@tool(tier=Tier.READ, cap_scope="memory:search", timeout_s=10, name="memory.search")
async def memory_search(query: str, limit: int = 10, *, ctx: ToolContext) -> dict:
    """Semantic + keyword search across stored memories."""
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.post(
            f"{settings.memory_service_url}/api/v1/memories/search",
            json={"query": query, "limit": limit, "mode": "hybrid"},
        )
        r.raise_for_status()
        return r.json()


@tool(tier=Tier.MUTATE, reversible=True, cap_scope="memory:write", timeout_s=10, name="memory.write")
async def memory_write(content: str, source_kind: str = "task_output", *, ctx: ToolContext) -> dict:
    """Store a piece of knowledge in the memory service."""
    async with httpx.AsyncClient(timeout=8.0) as client:
        r = await client.post(
            f"{settings.memory_service_url}/api/v1/memories",
            json={"content": content, "source_kind": source_kind},
        )
        r.raise_for_status()
        return r.json()
