"""SSRF-guarded URL fetcher + HTML→text extraction for the fetch_url tool.

Security model (single-operator, localhost-bound v1):
- http/https only, GET only, 20s budget, 200KB raw cap, 3 redirect hops max.
- Before every request (including each redirect hop) the hostname is resolved
  and ALL addresses must be globally routable. That guard now lives in
  `app.net_guard` — it acquired three more callers (media_client, the
  recommendation-action preflight, the MCP client) and one copy is the
  point. The names are re-exported here so this module reads as it did.
"""

import logging
import re
from html.parser import HTMLParser
from urllib.parse import urljoin

import httpx

from app.net_guard import is_public_address, validate_target as _validate_target

log = logging.getLogger(__name__)

__all__ = ["is_public_address", "_validate_target", "fetch_url", "TIMEOUT_S"]

TIMEOUT_S = 20.0
MAX_RAW_BYTES = 200_000
MAX_TEXT_CHARS = 15_000
MAX_REDIRECTS = 3
USER_AGENT = "Nova/0.1 (+local knowledge ingestion)"


class _TextExtractor(HTMLParser):
    _SKIP = {"script", "style", "noscript", "template", "svg", "iframe"}
    _BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6",
              "section", "article", "blockquote", "pre"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._skip_depth = 0
        self._in_title = False
        self.title = ""
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag == "title":
            self._in_title = True
        elif tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._skip_depth:
            self.parts.append(data)


def _html_to_text(html: str) -> tuple[str, str]:
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:
        log.exception("HTML parse failed; falling back to raw text")
        return "", html
    text = "".join(parser.parts)
    text = re.sub(r"[ \t\r]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return parser.title.strip(), text.strip()


async def fetch_url(url: str) -> str:
    """Fetch a public URL and return readable text, or an 'Error: ...' string."""
    current = url.strip()

    async with httpx.AsyncClient(timeout=TIMEOUT_S, follow_redirects=False,
                                 headers={"User-Agent": USER_AGENT}) as client:
        for _hop in range(MAX_REDIRECTS + 1):
            problem = await _validate_target(current)
            if problem:
                return f"Error: {problem}"

            try:
                async with client.stream("GET", current) as resp:
                    if resp.status_code in (301, 302, 303, 307, 308):
                        location = resp.headers.get("location")
                        if not location:
                            return f"Error: redirect from {current} without a Location header"
                        current = urljoin(current, location)
                        continue

                    if resp.status_code >= 400:
                        return f"Error: HTTP {resp.status_code} from {current}"

                    raw = b""
                    async for chunk in resp.aiter_bytes():
                        raw += chunk
                        if len(raw) >= MAX_RAW_BYTES:
                            break
                    content_type = resp.headers.get("content-type", "")
            except httpx.HTTPError as e:
                return f"Error: fetch failed for {current}: {e}"

            body = raw.decode(resp.encoding or "utf-8", errors="replace")

            if "html" in content_type:
                title, text = _html_to_text(body)
            else:
                title, text = "", body.strip()

            if not text:
                return f"Error: no readable text content at {current} ({content_type})"

            header = f"[source: {current}]" + (f"\n[title: {title}]" if title else "")
            return f"{header}\n\n{text[:MAX_TEXT_CHARS]}"

    return f"Error: too many redirects (>{MAX_REDIRECTS}) starting from {url}"
