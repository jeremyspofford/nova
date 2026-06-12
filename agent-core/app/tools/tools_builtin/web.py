"""Web tools: real search providers + readability extraction.

v1's web.search (DuckDuckGo instant answers) returned empty for most real
queries, and web.fetch dumped raw HTML tag soup into the context window — the
continuity spec's "out on the internet" gap, increment 3. Now:

- web.search tries SearXNG (self-hosted metasearch sidecar, compose profile
  `search`), then Brave (a `brave_api_key` secret), then DDG instant answers
  as the last resort. The response names which provider answered.
- web.fetch extracts readable article text via trafilatura, with raw
  passthrough for JSON/plain text and a stripped-text fallback when
  extraction finds nothing.
"""
import logging
import re

import httpx

from ...config import settings
from ...secrets import store as secrets_store
from ..context import ToolContext
from ..registry import Tier, tool

logger = logging.getLogger(__name__)

try:
    import trafilatura
except ImportError:  # pragma: no cover — requirements install it; stay alive without
    trafilatura = None
    logger.warning("trafilatura not installed — web.fetch returns raw text only")

_MAX_CONTENT = 50_000
_BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search"


async def _http_get(url: str, *, params: dict | None = None,
                    headers: dict | None = None, timeout: float = 25.0) -> httpx.Response:
    """Single HTTP helper for every web-tool request — one seam for tests."""
    base_headers = {"User-Agent": "Nova/2.0"}
    if headers:
        base_headers.update(headers)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        return await client.get(url, params=params, headers=base_headers)


def _extract_readable(html: str) -> tuple[str | None, str | None]:
    """(title, readable_text) via trafilatura; (None, None) when it finds nothing."""
    if trafilatura is None:
        return None, None
    try:
        text = trafilatura.extract(html, include_comments=False, include_tables=True)
        title = None
        try:
            meta = trafilatura.extract_metadata(html)
            title = meta.title if meta else None
        except Exception:
            pass
        return title, (text or None)
    except Exception as exc:
        logger.warning("readability extraction failed: %s", exc)
        return None, None


@tool(tier=Tier.READ, cap_scope="web:fetch:{url}", timeout_s=30, name="web.fetch")
async def web_fetch(url: str, *, ctx: ToolContext) -> dict:
    """Fetch a URL as READABLE text: HTML pages arrive as extracted article
    text (title + body), not tag soup. JSON/plain text pass through raw.
    Max 50K chars."""
    r = await _http_get(url)
    ct = r.headers.get("content-type", "")

    if not any(t in ct for t in ("text", "json", "xml")):
        return {"url": url, "status": r.status_code, "content": f"[binary: {ct}]",
                "extracted": False}

    raw = r.text
    if "html" in ct:
        title, readable = _extract_readable(raw)
        if readable:
            return {
                "url": url, "status": r.status_code,
                "title": title,
                "content": readable[:_MAX_CONTENT],
                "extracted": True,
                "truncated": len(readable) > _MAX_CONTENT,
            }
        # Extraction found nothing (link farms, SPAs, feeds) — strip tags
        # crudely rather than dumping markup into the context window.
        stripped = re.sub(r"<[^>]+>", " ", raw)
        stripped = re.sub(r"\s+", " ", stripped).strip()
        return {"url": url, "status": r.status_code, "content": stripped[:_MAX_CONTENT],
                "extracted": False, "truncated": len(stripped) > _MAX_CONTENT}

    return {"url": url, "status": r.status_code, "content": raw[:_MAX_CONTENT],
            "extracted": False, "truncated": len(raw) > _MAX_CONTENT}


async def _search_searxng(query: str, limit: int) -> list[dict]:
    r = await _http_get(
        f"{settings.searxng_url.rstrip('/')}/search",
        params={"q": query, "format": "json"},
        timeout=15.0,
    )
    r.raise_for_status()
    return [
        {"title": item.get("title", ""), "url": item.get("url", ""),
         "snippet": item.get("content", "")}
        for item in r.json().get("results", [])[:limit]
    ]


async def _search_brave(query: str, limit: int, api_key: str) -> list[dict]:
    r = await _http_get(
        _BRAVE_ENDPOINT,
        params={"q": query, "count": limit},
        headers={"X-Subscription-Token": api_key, "Accept": "application/json"},
        timeout=15.0,
    )
    r.raise_for_status()
    return [
        {"title": item.get("title", ""), "url": item.get("url", ""),
         "snippet": item.get("description", "")}
        for item in r.json().get("web", {}).get("results", [])[:limit]
    ]


async def _search_ddg(query: str, limit: int) -> list[dict]:
    """DuckDuckGo instant answers — last resort; empty for most real queries."""
    r = await _http_get(
        "https://api.duckduckgo.com/",
        params={"q": query, "format": "json", "no_html": "1", "skip_disambig": "1"},
    )
    data = r.json()
    results = []
    if data.get("AbstractText"):
        results.append({"title": data.get("Heading", ""), "snippet": data["AbstractText"],
                        "url": data.get("AbstractURL", "")})
    for topic in data.get("RelatedTopics", [])[:limit]:
        if isinstance(topic, dict) and "Text" in topic:
            results.append({"title": topic["Text"][:100], "snippet": topic["Text"],
                            "url": topic.get("FirstURL", "")})
    return results[:limit]


async def _brave_key(ctx: ToolContext) -> str | None:
    if not settings.credential_master_key:
        return None
    try:
        return await secrets_store.get_secret(
            ctx.pool, "brave_api_key", settings.credential_master_key
        )
    except Exception:
        return None


@tool(tier=Tier.READ, cap_scope="web:search", timeout_s=30, name="web.search")
async def web_search(query: str, limit: int = 5, *, ctx: ToolContext) -> dict:
    """Search the web. Providers in order: SearXNG sidecar (SEARXNG_URL),
    Brave (brave_api_key secret), DuckDuckGo instant answers (last resort).
    Returns {query, provider, results: [{title, url, snippet}]}."""
    limit = max(1, min(int(limit), 10))
    errors: list[str] = []

    if settings.searxng_url:
        try:
            results = await _search_searxng(query, limit)
            if results:
                return {"query": query, "provider": "searxng", "results": results}
            errors.append("searxng: no results")
        except Exception as exc:
            logger.warning("searxng search failed: %s", exc)
            errors.append(f"searxng: {exc}")

    brave_key = await _brave_key(ctx)
    if brave_key:
        try:
            results = await _search_brave(query, limit, brave_key)
            if results:
                return {"query": query, "provider": "brave", "results": results}
            errors.append("brave: no results")
        except Exception as exc:
            logger.warning("brave search failed: %s", exc)
            errors.append(f"brave: {exc}")

    try:
        results = await _search_ddg(query, limit)
        out = {"query": query, "provider": "ddg-instant", "results": results}
        if not results:
            out["note"] = ("instant answers only — configure SEARXNG_URL or a "
                           "brave_api_key secret for real web search")
        return out
    except Exception as exc:
        errors.append(f"ddg: {exc}")
        return {"query": query, "provider": "none", "results": [], "error": "; ".join(errors)}
