"""Subscribes to screenpipe's /ws/events with auth + exponential backoff reconnect.

Falls back to HTTP polling of /search after repeated WS failures.
"""

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse, urlunparse

import httpx
from websockets.asyncio.client import connect as ws_connect

logger = logging.getLogger(__name__)


_BACKOFF_SCHEDULE = [1, 2, 4, 8, 16, 30, 60]

# How often (seconds) to attempt WS reconnect while in polling mode.
_POLLING_WS_RETRY_INTERVAL = 300  # 5 minutes

# Cap on seen frame_id dedup set before clearing.
_MAX_SEEN_FRAME_IDS = 10_000


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class ScreenpipeClient:
    def __init__(
        self,
        url: str,
        api_key: str | None,
        on_event: Callable[[dict[str, Any]], None | Any],
        startup_connect_timeout: float = 30.0,
        ws_failures_before_polling: int = 5,
        polling_interval_seconds: float = 30.0,
        backoff_schedule_override: list[int | float] | None = None,
    ):
        self._url = url
        self._api_key = api_key
        self._on_event = on_event
        self._startup_connect_timeout = startup_connect_timeout
        self._ws_failures_before_polling = ws_failures_before_polling
        self._polling_interval_seconds = polling_interval_seconds
        self._backoff_schedule = backoff_schedule_override or _BACKOFF_SCHEDULE

        self._task: asyncio.Task | None = None
        self._stopped = False
        self._connected = asyncio.Event()

        # Polling state
        self._polling_mode = False
        self._ws_failure_count = 0
        self._seen_frame_ids: set[str] = set()
        self._last_poll_ts: str = _now_iso()

        # Long-lived HTTP client (closed in stop())
        self._http: httpx.AsyncClient = httpx.AsyncClient(timeout=10.0)

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())
        # Wait briefly for the first connection so tests + healthy boots are
        # deterministic. If screenpipe is offline at boot, return anyway and let
        # the background task keep retrying — bridge stays up so the user can fix
        # screenpipe without restarting Nova.
        try:
            await asyncio.wait_for(
                asyncio.shield(self._connected.wait()),
                timeout=self._startup_connect_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "screenpipe not reachable within %.1fs at startup; "
                "background reconnect continues",
                self._startup_connect_timeout,
            )

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        await self._http.aclose()

    def _ws_url(self) -> str:
        parsed = urlparse(self._url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunparse((scheme, parsed.netloc, "/ws/events", "", "images=false", ""))

    async def _run(self) -> None:
        attempt = 0
        while not self._stopped:
            if self._polling_mode:
                await self._run_polling()
                # _run_polling returns when polling exits (e.g. WS recovery or stop)
            else:
                try:
                    await self._connect_once()
                    # Clean disconnect resets counters
                    attempt = 0
                    self._ws_failure_count = 0
                except Exception as exc:
                    logger.warning("screenpipe ws error: %s", exc)
                    self._ws_failure_count += 1
                    if self._ws_failure_count >= self._ws_failures_before_polling:
                        logger.info(
                            "screenpipe ws failed %d times; switching to HTTP polling",
                            self._ws_failure_count,
                        )
                        self._polling_mode = True
                        continue  # jump directly into polling without sleeping

                if self._stopped:
                    break
                delay = self._backoff_schedule[
                    min(attempt, len(self._backoff_schedule) - 1)
                ]
                attempt += 1
                await asyncio.sleep(delay)

    async def _connect_once(self) -> None:
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        async with ws_connect(self._ws_url(), additional_headers=headers) as ws:
            logger.info("screenpipe ws connected")
            self._connected.set()
            async for raw in ws:
                try:
                    event = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                result = self._on_event(event)
                if asyncio.iscoroutine(result):
                    await result

    async def _run_polling(self) -> None:
        """Poll /search until WS recovers or client is stopped."""
        logger.info("screenpipe: entering HTTP polling mode")
        last_ws_retry = asyncio.get_event_loop().time()

        while not self._stopped and self._polling_mode:
            await self._poll_once()

            # Periodically attempt WS reconnect
            now = asyncio.get_event_loop().time()
            if now - last_ws_retry >= _POLLING_WS_RETRY_INTERVAL:
                logger.info("screenpipe: attempting WS reconnect from polling mode")
                try:
                    await self._connect_once()
                    # If we get here, WS worked — switch back
                    logger.info("screenpipe: WS reconnected; leaving polling mode")
                    self._polling_mode = False
                    self._ws_failure_count = 0
                    return
                except Exception as exc:
                    logger.debug("screenpipe ws retry failed: %s", exc)
                    last_ws_retry = now

            try:
                await asyncio.sleep(self._polling_interval_seconds)
            except asyncio.CancelledError:
                raise

    async def _poll_once(self) -> None:
        """Fetch /search since last poll, dispatch new OCR events."""
        headers = {"Authorization": f"Bearer {self._api_key}"} if self._api_key else {}
        params = {
            "content_type": "ocr",
            "start_time": self._last_poll_ts,
            "end_time": _now_iso(),
            "limit": "1000",
        }
        try:
            resp = await self._http.get(
                f"{self._url}/search",
                headers=headers,
                params=params,
            )
            resp.raise_for_status()
        except Exception as exc:
            logger.warning("screenpipe poll error: %s", exc)
            return

        # Signal readiness the first time we successfully poll.
        if not self._connected.is_set():
            self._connected.set()

        try:
            body = resp.json()
        except Exception:
            logger.warning("screenpipe poll: invalid JSON response")
            return

        items = body.get("data", [])
        latest_ts: str | None = None

        for item in items:
            if item.get("type") != "OCR":
                continue
            content = item.get("content", {})
            frame_id = content.get("frame_id")

            # Dedup: skip events we've already dispatched.
            if frame_id and frame_id in self._seen_frame_ids:
                continue
            if frame_id:
                self._seen_frame_ids.add(frame_id)
                # Prevent unbounded memory growth.
                if len(self._seen_frame_ids) > _MAX_SEEN_FRAME_IDS:
                    self._seen_frame_ids.clear()

            # Normalize to WS shape so _on_event sees a consistent structure.
            event = {"name": "ocr_result", "data": content}
            result = self._on_event(event)
            if asyncio.iscoroutine(result):
                await result

            # Track the latest timestamp seen to advance the poll window.
            ts = content.get("timestamp")
            if ts and (latest_ts is None or ts > latest_ts):
                latest_ts = ts

        if latest_ts:
            self._last_poll_ts = latest_ts
