"""Web search provider chain: bundled SearXNG first, keyless DDG HTML fallback.

Product principles: batteries-included (no API keys, ever, in the core loop)
and privacy-first (primary provider is Nova's own self-hosted metasearch
service; queries never touch a service the user holds an account with).
Keyed providers are deliberately absent; the seam for adding an opt-in one is
`_PROVIDERS` below.
"""

import logging
import re
from html.parser import HTMLParser
from urllib.parse import quote_plus, unquote

import httpx

from app.config import settings

log = logging.getLogger(__name__)

TIMEOUT_S = 15.0
MAX_RESULTS_CAP = 8
_UA = "Mozilla/5.0 (X11; Linux x86_64) Nova/0.1"


async def _searxng(query: str, max_results: int) -> list[dict]:
    url = f"{settings.searxng_url.rstrip('/')}/search"
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
        resp = await client.get(url, params={"q": query, "format": "json"},
                                headers={"User-Agent": _UA})
        resp.raise_for_status()
        data = resp.json()
    return [{"title": r.get("title", ""), "url": r.get("url", ""),
             "snippet": re.sub(r"\s+", " ", r.get("content") or "").strip()}
            for r in data.get("results", [])[:max_results]
            if r.get("url")]


class _DDGParser(HTMLParser):
    """Parses html.duckduckgo.com result markup (result__a / result__snippet)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.results: list[dict] = []
        self._current: dict = {}
        self._in_title = False
        self._in_snippet = False
        self._buf: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        a = dict(attrs)
        classes = (a.get("class") or "").split()
        if "result__a" in classes:
            self._in_title = True
            self._buf = []
            href = a.get("href", "")
            if "uddg=" in href:  # DDG wraps target URLs in a redirect param
                try:
                    href = unquote(href.split("uddg=")[1].split("&")[0])
                except (IndexError, ValueError):
                    pass
            self._current["url"] = href
        elif "result__snippet" in classes:
            self._in_snippet = True
            self._buf = []

    def handle_endtag(self, tag):
        if tag != "a":
            return
        if self._in_title:
            self._in_title = False
            self._current["title"] = " ".join(self._buf).strip()
        elif self._in_snippet:
            self._in_snippet = False
            self._current["snippet"] = " ".join(self._buf).strip()
            if self._current.get("url") and self._current.get("title"):
                self.results.append(self._current)
            self._current = {}

    def handle_data(self, data):
        if self._in_title or self._in_snippet:
            self._buf.append(data.strip())


async def _ddg(query: str, max_results: int) -> list[dict]:
    async with httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=True,
                                 headers={"User-Agent": _UA}) as client:
        resp = await client.get(
            f"https://html.duckduckgo.com/html/?q={quote_plus(query)}")
        resp.raise_for_status()
    parser = _DDGParser()
    parser.feed(resp.text)
    return parser.results[:max_results]


_PROVIDERS = [("searxng", _searxng), ("duckduckgo", _ddg)]


async def search(query: str, max_results: int = 6) -> str:
    """Try providers in order; return formatted results or an Error string."""
    max_results = max(1, min(max_results, MAX_RESULTS_CAP))
    errors = []

    for name, provider in _PROVIDERS:
        try:
            results = await provider(query, max_results)
        except Exception as e:
            log.warning("search provider %s failed: %s", name, e)
            errors.append(f"{name}: {e}")
            continue
        if not results:
            errors.append(f"{name}: no results")
            continue

        lines = [f"Search results for: {query}  (via {name})", ""]
        for i, r in enumerate(results, 1):
            lines.append(f"{i}. {r['title']}")
            lines.append(f"   {r['url']}")
            if r.get("snippet"):
                lines.append(f"   {r['snippet'][:300]}")
            lines.append("")
        return "\n".join(lines)

    return "Error: all search providers failed — " + "; ".join(errors)
