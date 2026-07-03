"""Autonomous LLM-guided web crawl engine.

Orchestrates BFS crawling with SSRF protection, robots.txt compliance,
per-domain rate limiting, LLM-scored link relevance, and memory ingestion.
"""
import logging
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine
from urllib.parse import urlparse

from nova_worker_common.content_hash import compute_content_hash
from nova_worker_common.rate_limiter import RateLimiter
from nova_worker_common.url_validator import validate_url

from .content_extractor import extract_metadata, extract_text
from .link_extractor import extract_links
from .relevance import RelevanceScorer
from .robots import RobotsChecker

logger = logging.getLogger(__name__)

# Type alias for the queue push callback
PushFn = Callable[..., Coroutine[Any, Any, None]]

MAX_REDIRECTS = 5


async def _safe_get(client, url: str, timeout: int = 15):
    """GET with manual redirect following and SSRF validation at each hop."""
    resp = await client.get(url, timeout=timeout, follow_redirects=False)
    redirects = 0
    while resp.is_redirect and redirects < MAX_REDIRECTS:
        from urllib.parse import urljoin
        location = resp.headers.get("location", "")
        if not location:
            break
        location = urljoin(str(resp.url), location)
        ssrf_err = validate_url(location)
        if ssrf_err:
            logger.warning("Redirect blocked by SSRF: %s -> %s (%s)", url, location, ssrf_err)
            return None
        resp = await client.get(location, timeout=timeout, follow_redirects=False)
        redirects += 1
    return resp


@dataclass
class CrawlResult:
    pages_visited: int = 0
    pages_skipped: int = 0
    engrams_created: int = 0
    llm_calls_made: int = 0
    status: str = "completed"
    error_detail: str | None = None
    crawl_tree: dict = field(default_factory=dict)
    content_items: list[dict] = field(default_factory=list)


class CrawlEngine:
    """BFS crawl engine with LLM relevance scoring and circuit breaker."""

    def __init__(
        self,
        http_client,
        llm_client,
        queue_push_fn: PushFn,
        max_pages: int = 50,
        max_llm_calls: int = 60,
        max_depth: int = 5,
        relevance_threshold: float = 0.5,
    ):
        self._http = http_client
        self._scorer = RelevanceScorer(llm_client)
        self._rate_limiter = RateLimiter(default_rate=1.0)
        self._robots = RobotsChecker()
        self._queue_push = queue_push_fn
        self._max_pages = max_pages
        self._max_llm_calls = max_llm_calls
        self._max_depth = max_depth
        self._relevance_threshold = relevance_threshold

    async def crawl(self, source: dict) -> CrawlResult:
        """Autonomous crawl of a knowledge source.

        Performs BFS starting from ``source["url"]``, scoring discovered links
        via LLM to decide which to follow. Extracted content is pushed to the
        memory ingestion queue.
        """
        result = CrawlResult()
        visited: set[str] = set()
        # BFS queue: (url, depth)
        queue: list[tuple[str, int]] = [(source["url"], 0)]
        source_context = f"{source.get('name', '')} - {source['url']}"

        try:
            while queue and result.pages_visited < self._max_pages:
                url, depth = queue.pop(0)

                if url in visited:
                    continue
                if depth > self._max_depth:
                    result.pages_skipped += 1
                    continue

                # SSRF check
                if validate_url(url) is not None:
                    result.pages_skipped += 1
                    continue

                # Robots.txt check
                if not await self._robots.is_allowed(url, self._http):
                    result.pages_skipped += 1
                    continue

                # Rate limit (async context manager)
                domain = urlparse(url).netloc
                async with self._rate_limiter.acquire(domain):
                    page_result = await self._fetch_and_process(
                        url, depth, source, source_context, result, visited, queue,
                    )
                    if not page_result:
                        continue

            result.llm_calls_made = self._scorer.total_calls

            if self._scorer.is_circuit_open:
                result.status = "partial"

        except Exception as e:
            logger.error("Crawl failed: %s", e)
            result.status = "failed"
            result.error_detail = str(e)

        return result

    async def _fetch_and_process(
        self,
        url: str,
        depth: int,
        source: dict,
        source_context: str,
        result: CrawlResult,
        visited: set[str],
        queue: list[tuple[str, int]],
    ) -> bool:
        """Fetch a single page, extract content, discover links. Returns True on success."""
        try:
            resp = await _safe_get(self._http, url, timeout=15)
            if resp is None or resp.status_code != 200:
                result.pages_skipped += 1
                return False
        except Exception as e:
            logger.warning("Failed to fetch %s: %s", url, e)
            result.pages_skipped += 1
            return False

        visited.add(url)
        content_type = resp.headers.get("content-type", "")

        # Skip non-HTML
        if "text/html" not in content_type and "application/xhtml" not in content_type:
            result.pages_skipped += 1
            return False

        html = resp.text
        text = extract_text(html)
        metadata = extract_metadata(html)
        title = metadata.get("title", url)

        if text.strip():
            content_hash = compute_content_hash(title, text)
            item = {
                "title": title,
                "body": text[:10_000],
                "url": url,
                "content_hash": content_hash,
                "metadata": metadata,
            }
            result.content_items.append(item)

            await self._queue_push(
                raw_text=f"{title}\n\n{text[:5000]}",
                source_type="knowledge",
                source_id=source.get("id"),
                metadata={"url": url, "source_name": source.get("name", "")},
            )
            result.engrams_created += 1

        result.pages_visited += 1
        result.crawl_tree[url] = {"depth": depth, "title": title}

        # Discover and score links
        links = extract_links(html, url)
        new_links = [link for link in links if link not in visited]

        if new_links and self._scorer.total_calls < self._max_llm_calls:
            scored = await self._scorer.score_links(new_links, text, source_context)
            scored_count = 0
            for link_url, score in scored:
                if score >= self._relevance_threshold:
                    queue.append((link_url, depth + 1))
                scored_count += 1
            result.crawl_tree[url]["links_scored"] = scored_count

        return True

    async def refresh_crawl(
        self, source: dict, page_cache: list[dict],
    ) -> CrawlResult:
        """Re-crawl pages from cache, detect changes, discover new links.

        Only re-ingests pages whose content hash has changed since last crawl.
        """
        result = CrawlResult()

        for cached_page in page_cache:
            url = cached_page["url"]
            old_hash = cached_page.get("content_hash")

            # SSRF + robots check
            if validate_url(url) is not None:
                continue
            if not await self._robots.is_allowed(url, self._http):
                continue

            domain = urlparse(url).netloc
            async with self._rate_limiter.acquire(domain):
                try:
                    resp = await _safe_get(self._http, url, timeout=15)
                    if resp is None or resp.status_code != 200:
                        result.pages_skipped += 1
                        continue
                except Exception:
                    result.pages_skipped += 1
                    continue

                html = resp.text
                text = extract_text(html)
                metadata = extract_metadata(html)
                title = metadata.get("title", url)
                new_hash = compute_content_hash(title, text)

                result.pages_visited += 1

                if new_hash == old_hash:
                    result.pages_skipped += 1
                    continue

                # Content changed -- re-ingest
                if text.strip():
                    await self._queue_push(
                        raw_text=f"{title}\n\n{text[:5000]}",
                        source_type="knowledge",
                        source_id=source.get("id"),
                        metadata={
                            "url": url,
                            "source_name": source.get("name", ""),
                        },
                    )
                    result.engrams_created += 1

                # Track changed pages and new link count
                links = extract_links(html, url)
                result.crawl_tree[url] = {
                    "changed": True,
                    "new_links": len(links),
                }

        return result
