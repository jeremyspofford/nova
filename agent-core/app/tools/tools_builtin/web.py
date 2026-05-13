"""Web tools: fetch, search."""
import httpx
from ..registry import tool, Tier
from ..context import ToolContext

_MAX_CONTENT = 50_000


@tool(tier=Tier.READ, cap_scope="web:fetch:{url}", timeout_s=30, name="web.fetch")
async def web_fetch(url: str, *, ctx: ToolContext) -> dict:
    """HTTP GET a URL. Returns text content (max 50K chars)."""
    async with httpx.AsyncClient(timeout=25.0, follow_redirects=True) as client:
        r = await client.get(url, headers={"User-Agent": "Nova/2.0"})
    ct = r.headers.get("content-type", "")
    if any(t in ct for t in ("text", "json", "xml")):
        return {"url": url, "status": r.status_code, "content": r.text[:_MAX_CONTENT]}
    return {"url": url, "status": r.status_code, "content": f"[binary: {ct}]"}


@tool(tier=Tier.READ, cap_scope="web:search", timeout_s=30, name="web.search")
async def web_search(query: str, *, ctx: ToolContext) -> dict:
    """Search the web via DuckDuckGo instant answers."""
    async with httpx.AsyncClient(timeout=25.0) as client:
        r = await client.get(
            "https://api.duckduckgo.com/",
            params={"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"},
        )
    data = r.json()
    results = []
    if data.get("AbstractText"):
        results.append({"title": data.get("Heading", ""), "snippet": data["AbstractText"], "url": data.get("AbstractURL", "")})
    for topic in data.get("RelatedTopics", [])[:5]:
        if isinstance(topic, dict) and "Text" in topic:
            results.append({"title": topic["Text"][:100], "snippet": topic["Text"], "url": topic.get("FirstURL", "")})
    return {"query": query, "results": results}
