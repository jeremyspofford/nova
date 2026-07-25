"""SSRF-guarded URL fetcher + HTML→text extraction for the fetch_url tool.

Security model (single-operator, localhost-bound v1):
- http/https only, GET only, 20s budget, 200KB raw cap, 3 redirect hops max.
- Before every request (including each redirect hop) the hostname is resolved
  and ALL addresses must be globally routable (`is_public_address`). This is
  an allow-list on purpose — the deny-list it replaced missed CGNAT
  (100.64.0.0/10), i.e. the whole tailnet.
- Residual risk, documented deliberately: we resolve-then-connect, so a
  hostile DNS server flipping records between check and connect (DNS
  rebinding) could theoretically bypass the guard. Acceptable at this trust
  level; revisit with a pinned-IP transport if Nova is ever exposed.
"""

import asyncio
import ipaddress
import logging
import re
import socket
from html.parser import HTMLParser
from urllib.parse import urljoin, urlparse

import httpx

log = logging.getLogger(__name__)

TIMEOUT_S = 20.0
MAX_RAW_BYTES = 200_000
MAX_TEXT_CHARS = 15_000
MAX_REDIRECTS = 3
USER_AGENT = "Nova/0.1 (+local knowledge ingestion)"


async def _validate_target(url: str) -> str | None:
    """Return an error string if the URL must not be fetched, else None."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return f"scheme '{parsed.scheme}' is not allowed (http/https only)"
    host = parsed.hostname
    if not host:
        return "URL has no hostname"

    try:
        loop = asyncio.get_running_loop()
        infos = await loop.run_in_executor(
            None, lambda: socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP))
    except socket.gaierror as e:
        return f"cannot resolve host '{host}': {e}"

    for info in infos:
        if not is_public_address(info[4][0]):
            log.warning("SSRF guard refused %s (resolves to %s)", url, info[4][0])
            return (f"host '{host}' resolves to a non-public address "
                    f"({info[4][0]}) — fetching internal/private targets is "
                    f"not allowed")
    return None


def is_public_address(raw_ip: str) -> bool:
    """Allow-list, not deny-list: only globally routable addresses pass.

    The old deny-list (private/loopback/link-local/reserved/multicast/
    unspecified) silently missed 100.64.0.0/10 — CGNAT, which is exactly
    Tailscale's range — because CPython's ipaddress classifies it as none of
    those, only as `not is_global`. With the tailscale profile running that
    left every peer on the tailnet (phones, laptops, the pi) fetchable by the
    model. `is_global` covers that block, everything the deny-list had, and
    any future reserved range without another audit.

    Two wrinkles it does not cover on its own: some multicast is is_global,
    and an IPv4-mapped/NAT64 v6 address reports on the v6 wrapper rather
    than the v4 target it reaches, so both are unwrapped first."""
    ip = ipaddress.ip_address(raw_ip)
    if getattr(ip, "ipv4_mapped", None):
        ip = ip.ipv4_mapped
    elif ip.version == 6 and ip in ipaddress.ip_network("64:ff9b::/96"):
        # NAT64: the low 32 bits are the real IPv4 destination
        ip = ipaddress.ip_address(int(ip) & 0xFFFFFFFF)
    return ip.is_global and not ip.is_multicast


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
