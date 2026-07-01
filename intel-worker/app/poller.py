"""Main feed polling loop — fetches due feeds and processes them."""
import asyncio
import logging
from datetime import datetime, timezone

from app.client import get_client
from app.config import settings
from app.fetchers import fetch_feed
from app.queue import push_to_engram_queue

log = logging.getLogger(__name__)


def _is_due(feed: dict) -> bool:
    """Check if a feed is due for checking based on interval and backoff."""
    last = feed.get("last_checked_at")
    if not last:
        return True
    interval = feed.get("check_interval_seconds", 3600)
    error_count = feed.get("error_count", 0)
    if error_count > 0:
        interval = min(interval * (2 ** error_count), 86400)
    if isinstance(last, str):
        last_dt = datetime.fromisoformat(last.replace("Z", "+00:00"))
    else:
        last_dt = last
    if last_dt.tzinfo is None:
        last_dt = last_dt.replace(tzinfo=timezone.utc)
    elapsed = (datetime.now(timezone.utc) - last_dt).total_seconds()
    return elapsed >= interval


async def _update_feed_status(
    feed_id: str,
    *,
    success: bool,
    current_error_count: int = 0,
    last_hash: str | None = None,
) -> None:
    """Report feed check result to orchestrator."""
    client = get_client()
    body: dict = {
        "last_checked_at": datetime.now(timezone.utc).isoformat(),
        "error_count": 0 if success else current_error_count + 1,
    }
    if last_hash is not None:
        body["last_hash"] = last_hash
    try:
        await client.patch(f"/api/v1/intel/feeds/{feed_id}/status", json=body)
    except Exception as e:
        log.warning("Failed to update feed status %s: %s", feed_id, e)


async def run_polling_loop() -> None:
    """Main loop: fetch due feeds from orchestrator, process, push to queues."""
    log.info("Polling loop started (interval=%ds)", settings.poll_interval)
    while True:
        try:
            client = get_client()
            resp = await client.get("/api/v1/intel/feeds", params={"enabled": "true"})
            if resp.status_code != 200:
                log.warning("Failed to fetch feeds: %s", resp.status_code)
                await asyncio.sleep(settings.poll_interval)
                continue

            feeds = resp.json()
            due_count = 0

            for feed in feeds:
                if not _is_due(feed):
                    continue
                due_count += 1
                feed_name = feed.get("name", "unknown")
                feed_id = feed["id"]

                try:
                    items = await fetch_feed(feed)
                    if not items:
                        await _update_feed_status(
                            feed_id,
                            success=True,
                            last_hash=feed.get("last_hash"),
                        )
                        continue

                    # Post content to orchestrator (handles dedup)
                    post_resp = await client.post("/api/v1/intel/content", json={
                        "items": [{**item, "feed_id": feed_id} for item in items],
                    })

                    if post_resp.status_code == 200:
                        stored = post_resp.json()
                        for item in stored:
                            item["feed_name"] = feed_name
                            item["category"] = feed.get("category")
                            await push_to_engram_queue(item)
                        log.info("Feed %s: %d fetched, %d new", feed_name, len(items), len(stored))
                    else:
                        log.warning("Feed %s: content POST failed (%s)", feed_name, post_resp.status_code)

                    new_hash = items[0].get("content_hash") if items else feed.get("last_hash")
                    await _update_feed_status(feed_id, success=True, last_hash=new_hash)

                except Exception as e:
                    log.warning("Feed %s failed: %s", feed_name, e)
                    await _update_feed_status(
                        feed_id,
                        success=False,
                        current_error_count=feed.get("error_count", 0),
                    )

            if due_count > 0:
                log.info("Polling cycle complete: %d/%d feeds due", due_count, len(feeds))

        except Exception as e:
            log.error("Polling loop error: %s", e)

        await asyncio.sleep(settings.poll_interval)
