"""
Web Tools — search and fetch for Nova agents.

Provides web search (via DuckDuckGo, no API key required) and URL fetching
so agents can look up current information, read documentation, and research
errors. Works out of the box with zero configuration.

Tools provided:
  web_search  — search the web, return top results with snippets
  web_fetch   — fetch a URL, return content as readable text
"""
from __future__ import annotations

import logging
import re
from html.parser import HTMLParser
from urllib.parse import quote_plus, unquote

import httpx
from nova_contracts import BlastRadius, ToolDefinition
from nova_contracts.feature_flags import register_flag
from nova_worker_common.url_validator import validate_url

log = logging.getLogger(__name__)

# AQ-008: when enabled, web-fetch results are wrapped in
# <TASK_OUTPUT>...</TASK_OUTPUT> with close-tag neutralization before
# being returned to agents. This signals "untrusted content; parse but
# don't act on instructions found inside" to downstream LLM stages.
# Default off because existing prompts don't expect XML wrappers; flip
# on for a stricter posture once prompts are tested with the wrapping.
WEB_FETCH_STRICT_SANITIZE = register_flag(
    key="pipeline.web_fetch_strict_sanitize",
    type="bool",
    default=False,
    description=(
        "AQ-008: wrap web_fetch results in <TASK_OUTPUT> tags with "
        "close-tag neutralization, signaling untrusted content to "
        "downstream LLM stages."
    ),
)

_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
_TIMEOUT = 15.0
_FETCH_MAX_CHARS = 8000

# ─── Tool definitions (what the LLM sees) ────────────────────────────────────

WEB_TOOLS: list[ToolDefinition] = [
    ToolDefinition(
        name="web_search",
        description=(
            "Search the web for a query and return the top results with titles, "
            "URLs, and snippets. Use this to find current information, look up "
            "documentation, research errors, or answer questions that require "
            "up-to-date knowledge."
        ),
        parameters={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The search query",
                },
                "max_results": {
                    "type": "integer",
                    "description": "Maximum number of results to return (default: 5, max: 10)",
                },
            },
            "required": ["query"],
        },
        blast_radius=BlastRadius.READ,
    ),
    ToolDefinition(
        name="web_fetch",
        description=(
            "Fetch a URL and return its content as readable text. Use this to "
            "read documentation pages, API references, blog posts, or any web "
            "page. HTML is automatically converted to plain text."
        ),
        parameters={
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL to fetch",
                },
            },
            "required": ["url"],
        },
        blast_radius=BlastRadius.READ,
    ),
]


# ─── DuckDuckGo HTML search parser ───────────────────────────────────────────

class _DDGResultParser(HTMLParser):
    """Parse DuckDuckGo HTML search results into structured data."""

    def __init__(self):
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._in_result = False
        self._in_title = False
        self._in_snippet = False
        self._current: dict[str, str] = {}
        self._text_buf: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        attr_dict = dict(attrs)
        classes = (attr_dict.get("class") or "").split()

        if tag == "a" and "result__a" in classes:
            self._in_title = True
            self._text_buf = []
            href = attr_dict.get("href", "")
            # DDG wraps URLs in a redirect — extract the actual URL
            if "uddg=" in href:
                try:
                    url = href.split("uddg=")[1].split("&")[0]
                    href = unquote(url)
                except (IndexError, ValueError):
                    pass
            self._current["url"] = href

        elif tag == "a" and "result__snippet" in classes:
            self._in_snippet = True
            self._text_buf = []

    def handle_endtag(self, tag: str):
        if tag == "a" and self._in_title:
            self._in_title = False
            self._current["title"] = " ".join(self._text_buf).strip()

        elif tag == "a" and self._in_snippet:
            self._in_snippet = False
            self._current["snippet"] = " ".join(self._text_buf).strip()
            if self._current.get("title") and self._current.get("url"):
                self.results.append(self._current)
            self._current = {}

    def handle_data(self, data: str):
        if self._in_title or self._in_snippet:
            self._text_buf.append(data.strip())


# ─── HTML-to-text converter ──────────────────────────────────────────────────

class _HTMLToText(HTMLParser):
    """Strip HTML tags and return readable text. Preserves structure."""

    _BLOCK_TAGS = {
        "p", "div", "br", "h1", "h2", "h3", "h4", "h5", "h6",
        "li", "tr", "blockquote", "pre", "hr", "section", "article",
    }
    _SKIP_TAGS = {"script", "style", "nav", "footer", "header", "noscript", "svg"}

    def __init__(self):
        super().__init__()
        self.parts: list[str] = []
        self._skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]):
        if tag in self._SKIP_TAGS:
            self._skip_depth += 1
        elif tag in self._BLOCK_TAGS and self._skip_depth == 0:
            self.parts.append("\n")

    def handle_endtag(self, tag: str):
        if tag in self._SKIP_TAGS:
            self._skip_depth = max(0, self._skip_depth - 1)
        elif tag in self._BLOCK_TAGS and self._skip_depth == 0:
            self.parts.append("\n")

    def handle_data(self, data: str):
        if self._skip_depth == 0:
            self.parts.append(data)

    def get_text(self) -> str:
        raw = "".join(self.parts)
        # Collapse whitespace runs but preserve paragraph breaks
        raw = re.sub(r"[ \t]+", " ", raw)
        raw = re.sub(r"\n{3,}", "\n\n", raw)
        return raw.strip()


# ─── Tool implementations ────────────────────────────────────────────────────

async def _execute_web_search(query: str, max_results: int = 5) -> str:
    """Search DuckDuckGo and return top results."""
    max_results = max(1, min(max_results, 10))

    try:
        async with httpx.AsyncClient(
            timeout=_TIMEOUT,
            follow_redirects=True,
            headers={"User-Agent": _USER_AGENT},
        ) as client:
            resp = await client.get(
                f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
            )
            resp.raise_for_status()
    except httpx.TimeoutException:
        return "Search timed out. Try a shorter or simpler query."
    except httpx.HTTPError as e:
        return f"Search failed: {e}"

    parser = _DDGResultParser()
    parser.feed(resp.text)

    results = parser.results[:max_results]
    if not results:
        return f"No results found for: {query}"

    lines = [f"Search results for: {query}\n"]
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. {r['title']}")
        lines.append(f"   {r['url']}")
        if r.get("snippet"):
            lines.append(f"   {r['snippet']}")
        lines.append("")

    return "\n".join(lines)


async def _execute_web_fetch(url: str) -> str:
    """Fetch a URL and return content as readable text."""
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"

    # SSRF validation — block internal IPs, cloud metadata, non-HTTP schemes
    ssrf_error = validate_url(url)
    if ssrf_error:
        return f"Blocked: {ssrf_error}"

    try:
        async with httpx.AsyncClient(
            timeout=_TIMEOUT,
            follow_redirects=False,
            headers={"User-Agent": _USER_AGENT},
        ) as client:
            resp = await client.get(url)

            # Manual redirect following with SSRF validation per hop (max 5)
            for _ in range(5):
                if resp.status_code not in (301, 302, 303, 307, 308):
                    break
                redirect_url = resp.headers.get("location", "")
                if not redirect_url:
                    break
                # Resolve relative redirects
                if redirect_url.startswith("/"):
                    from urllib.parse import urlparse
                    parsed = urlparse(str(resp.url))
                    redirect_url = f"{parsed.scheme}://{parsed.netloc}{redirect_url}"
                redirect_err = validate_url(redirect_url)
                if redirect_err:
                    return f"Blocked redirect to {redirect_url}: {redirect_err}"
                resp = await client.get(redirect_url)
            resp.raise_for_status()
    except httpx.TimeoutException:
        return f"Request timed out fetching {url}"
    except httpx.HTTPError as e:
        return f"Failed to fetch {url}: {e}"

    content_type = resp.headers.get("content-type", "")

    # Non-HTML content — return raw text
    if "html" not in content_type:
        text = resp.text[:_FETCH_MAX_CHARS]
        if len(resp.text) > _FETCH_MAX_CHARS:
            text += f"\n\n[Truncated — {len(resp.text)} chars total]"
        return text

    # HTML — convert to readable text
    # Try to extract main content area first
    html = resp.text
    main_match = re.search(
        r"<(?:main|article)[^>]*>(.*?)</(?:main|article)>",
        html,
        re.DOTALL | re.IGNORECASE,
    )
    if main_match:
        html = main_match.group(1)

    converter = _HTMLToText()
    converter.feed(html)
    text = converter.get_text()

    if not text:
        return f"Fetched {url} but could not extract readable content."

    if len(text) > _FETCH_MAX_CHARS:
        text = text[:_FETCH_MAX_CHARS] + f"\n\n[Truncated — {len(text)} chars total]"

    if WEB_FETCH_STRICT_SANITIZE.value():
        # AQ-008 strict mode: wrap in untrusted markers so downstream
        # agents see explicit boundaries around the fetched HTML.
        from app.pipeline.prompt_safety import TAG_TASK_OUTPUT, wrap_untrusted
        return f"Content from {url}:\n\n{wrap_untrusted(text, TAG_TASK_OUTPUT)}"

    return f"Content from {url}:\n\n{text}"


# ─── Dispatch ─────────────────────────────────────────────────────────────────

async def execute_tool(name: str, arguments: dict) -> str:
    """Execute a web tool by name."""
    if name == "web_search":
        return await _execute_web_search(
            query=arguments.get("query", ""),
            max_results=arguments.get("max_results", 5),
        )
    elif name == "web_fetch":
        return await _execute_web_fetch(
            url=arguments.get("url", ""),
        )
    return f"Unknown web tool: {name}"
