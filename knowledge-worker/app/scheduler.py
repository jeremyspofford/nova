"""Scheduling loop that coordinates knowledge source crawls.

Polls the orchestrator for active sources, runs due crawls concurrently
(up to 3), and reports results back.
"""
import asyncio
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

# Max 3 concurrent crawls
_crawl_semaphore = asyncio.Semaphore(3)

# Source IDs currently being crawled — prevents duplicate concurrent crawls
# of the same source if the scheduling loop fires before a crawl finishes.
_active_crawls: set[str] = set()


async def run_scheduling_loop(config, get_orch_client, get_llm_client, push_to_engram):
    """Main scheduling loop. Fetches active sources, runs due crawls."""
    logger.info(
        "Knowledge worker scheduling loop started (interval=%ds)",
        config.poll_interval,
    )

    while True:
        try:
            orch = get_orch_client()
            llm = get_llm_client()

            # Fetch active sources from orchestrator
            resp = await orch.get(
                "/api/v1/knowledge/sources", params={"status": "active"},
            )
            if resp.status_code != 200:
                logger.warning("Failed to fetch sources: %s", resp.status_code)
                await asyncio.sleep(config.poll_interval)
                continue

            sources = resp.json()

            for source in sources:
                sid = source["id"]
                if sid in _active_crawls:
                    logger.debug("Skipping source %s — crawl already in progress", sid)
                    continue
                if _is_due(source, config.poll_interval):
                    _active_crawls.add(sid)
                    # Fire and forget -- semaphore limits concurrency
                    asyncio.create_task(
                        _run_crawl(source, config, orch, llm, push_to_engram)
                    )

        except Exception as e:
            logger.error("Scheduling loop error: %s", e)

        await asyncio.sleep(config.poll_interval)


def _is_due(source: dict, default_interval: int) -> bool:
    """Check if a source is due for a crawl based on interval and last crawl time."""
    last_crawl = source.get("last_crawl_at")
    if not last_crawl:
        return True  # Never crawled

    last = datetime.fromisoformat(last_crawl.replace("Z", "+00:00"))
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    now = datetime.now(timezone.utc)

    # Use source-specific interval from crawl_config, or default
    crawl_config = source.get("crawl_config") or {}
    interval = crawl_config.get("check_interval_seconds", default_interval)

    return (now - last).total_seconds() >= interval


async def _run_crawl(source, config, orch_client, llm_client, push_to_engram):
    """Run a single crawl within the concurrency semaphore."""
    source_id = source["id"]
    source_name = source.get("name", source_id)
    try:
        async with _crawl_semaphore:
            logger.info("Starting crawl for source %s", source_name)

            from .extractors import get_extractor

            extractor = get_extractor(source["url"])

            try:
                if extractor:
                    await _run_extractor(
                        extractor, source, source_id, orch_client, push_to_engram,
                    )
                else:
                    await _run_general_crawl(
                        source, source_id, config, orch_client, llm_client, push_to_engram,
                    )

                logger.info("Crawl complete for source %s", source_name)

            except Exception as e:
                logger.error("Crawl failed for source %s: %s", source_id, e)
                try:
                    await orch_client.patch(
                        f"/api/v1/knowledge/sources/{source_id}/status",
                        json={
                            "status": "error",
                            "error_count": source.get("error_count", 0) + 1,
                        },
                    )
                except Exception:
                    pass
    finally:
        _active_crawls.discard(source_id)


async def _run_extractor(extractor, source, source_id, orch_client, push_to_engram):
    """Run a platform-specific extractor for a source."""
    from .credentials import retrieve_credential

    credential = None
    if source.get("credential_id"):
        token = await retrieve_credential(orch_client, source["credential_id"])
        if token:
            credential = {"token": token}
        else:
            logger.warning(
                "Source %s has credential_id but retrieval failed — crawling unauthenticated",
                source_id,
            )

    items = await extractor.extract(source["url"], credential)
    for item in items:
        await push_to_engram(
            raw_text=f"{item.get('title', '')}\n\n{item.get('body', '')}",
            source_type="knowledge",
            source_id=source_id,
            metadata=item.get("metadata", {}),
        )

    await orch_client.patch(
        f"/api/v1/knowledge/sources/{source_id}/status",
        json={
            "status": "active",
            "last_crawl_at": datetime.now(timezone.utc).isoformat(),
            "last_crawl_summary": {
                "items_extracted": len(items),
                "method": "extractor",
            },
            "error_count": 0,
        },
    )


async def _run_general_crawl(
    source, source_id, config, orch_client, llm_client, push_to_engram,
):
    """Run the general-purpose crawl engine for a source."""
    import httpx

    from .crawler.engine import CrawlEngine
    from .credentials import retrieve_credential

    headers = {"User-Agent": "Nova/1.0"}

    # Add auth header if source has a credential
    if source.get("credential_id"):
        token = await retrieve_credential(orch_client, source["credential_id"])
        if token:
            headers["Authorization"] = f"Bearer {token}"
        else:
            logger.warning(
                "Source %s has credential_id but retrieval failed — crawling unauthenticated",
                source_id,
            )

    crawl_client = httpx.AsyncClient(
        timeout=30,
        headers=headers,
        follow_redirects=False,  # engine._safe_get handles redirects with SSRF validation
    )
    try:
        engine = CrawlEngine(
            http_client=crawl_client,
            llm_client=llm_client,
            queue_push_fn=push_to_engram,
            max_pages=config.max_crawl_pages,
            max_llm_calls=config.max_llm_calls_per_crawl,
        )
        result = await engine.crawl(source)
    finally:
        await crawl_client.aclose()

    # Report crawl results to orchestrator
    await orch_client.post(
        "/api/v1/knowledge/crawl-log",
        json={
            "source_id": source_id,
            "tenant_id": source.get("tenant_id", ""),
            "pages_visited": result.pages_visited,
            "pages_skipped": result.pages_skipped,
            "engrams_created": result.engrams_created,
            "llm_calls_made": result.llm_calls_made,
            "status": result.status,
            "error_detail": result.error_detail,
            "crawl_tree": result.crawl_tree,
        },
    )

    # Update source status
    await orch_client.patch(
        f"/api/v1/knowledge/sources/{source_id}/status",
        json={
            "status": result.status if result.status == "failed" else "active",
            "last_crawl_at": datetime.now(timezone.utc).isoformat(),
            "last_crawl_summary": {
                "pages_visited": result.pages_visited,
                "engrams_created": result.engrams_created,
                "status": result.status,
            },
            "error_count": (
                0 if result.status != "failed"
                else source.get("error_count", 0) + 1
            ),
        },
    )
