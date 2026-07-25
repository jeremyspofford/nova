"""HTTP client for the media worker (yt-dlp + ffmpeg + whisper-fallback
extraction) — the ingest_media tool's only way to reach it. Isolating
extraction in its own service keeps heavy binaries and all outbound media
fetching out of the backend (docs/plans/content-ingestion.md), the same
reasoning as the whisper/kokoro services.
"""

import logging

import httpx

from app.config import settings

log = logging.getLogger(__name__)

# Generous but bounded: caption-only extraction is fast, but the whisper
# fallback on a long, caption-less video can run for many minutes (each
# windowed chunk is its own whisper call). A truly long-running background
# job queue is future work (docs/plans/content-ingestion.md, Polish phase).
TIMEOUT_S = 1800.0


async def _refuse_internal(url: str) -> dict | None:
    """SSRF guard, same one fetch_url uses. The media path had none: the
    model picks the URL for ingest_media/follow_source/poll_sources and it
    went straight to yt-dlp inside a container that can reach
    http://backend:8000, http://inference-control:9911/stop, the metadata
    endpoint, and every tailnet peer. fetch_url refused all of that while
    this door stood open — the asymmetry was the bug, not the policy.

    Returns the {"error": ...} both callers already return, or None."""
    from app.tools.web_fetch import _validate_target
    err = await _validate_target(url)
    if err:
        log.warning("media SSRF guard refused %s: %s", url, err)
        return {"error": err}
    return None


async def extract(url: str) -> dict:
    """{media_key, extractor, id, title, url, duration_s, transcript_source,
    language, chapters, segments:[{start,end,text,deep_link}]} on success;
    {"status": "skipped", "reason": ...} for live/upcoming streams;
    {"error": "..."} on failure. Never raises — callers relay the message."""
    refused = await _refuse_internal(url)
    if refused:
        return refused
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            resp = await client.post(f"{settings.media_worker_url}/extract",
                                     json={"url": url})
    except httpx.ConnectError:
        return {"error": ("the media worker isn't running — start it with "
                          "'docker compose --profile media up -d media'")}
    except httpx.HTTPError as e:
        return {"error": f"media worker request failed: {e}"}

    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        return {"error": str(detail)[:500]}
    return resp.json()


async def enumerate_source(url: str, limit: int = 0) -> dict:
    """List a source's uploads WITHOUT downloading them (yt-dlp extract_flat).
    {is_source: false} when the URL is a single video, not a channel/playlist;
    {source_key, extractor, title, entries:[{media_key, url, title}]} for a
    source (newest first, capped at `limit` when >0); {"error": ...} on failure.
    Each entry's media_key matches what /extract would produce, so the poll
    dedupes against the media_ingests ledger. Never raises."""
    refused = await _refuse_internal(url)
    if refused:
        return refused
    try:
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(f"{settings.media_worker_url}/enumerate",
                                     json={"url": url, "limit": limit})
    except httpx.ConnectError:
        return {"error": ("the media worker isn't running — start it with "
                          "'docker compose --profile media up -d media'")}
    except httpx.HTTPError as e:
        return {"error": f"media worker request failed: {e}"}

    if resp.status_code >= 400:
        try:
            detail = resp.json().get("detail", resp.text)
        except ValueError:
            detail = resp.text
        return {"error": str(detail)[:500]}
    return resp.json()
