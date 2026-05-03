"""Subscribes to screenpipe's /ws/events with auth + exponential backoff reconnect."""

import asyncio
import contextlib
import json
import logging
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse, urlunparse

from websockets.asyncio.client import connect as ws_connect

logger = logging.getLogger(__name__)


_BACKOFF_SCHEDULE = [1, 2, 4, 8, 16, 30, 60]


class ScreenpipeClient:
    def __init__(
        self,
        url: str,
        api_key: str | None,
        on_event: Callable[[dict[str, Any]], None | Any],
    ):
        self._url = url
        self._api_key = api_key
        self._on_event = on_event
        self._task: asyncio.Task | None = None
        self._stopped = False
        self._connected = asyncio.Event()

    async def start(self) -> None:
        self._task = asyncio.create_task(self._run())
        # Wait until the first connection is established so callers can immediately
        # send events without a race condition.
        await self._connected.wait()

    async def stop(self) -> None:
        self._stopped = True
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task

    def _ws_url(self) -> str:
        parsed = urlparse(self._url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return urlunparse((scheme, parsed.netloc, "/ws/events", "", "images=false", ""))

    async def _run(self) -> None:
        attempt = 0
        while not self._stopped:
            try:
                await self._connect_once()
                attempt = 0  # reset backoff on clean disconnect
            except Exception as exc:
                logger.warning("screenpipe ws error: %s", exc)
            if self._stopped:
                break
            delay = _BACKOFF_SCHEDULE[min(attempt, len(_BACKOFF_SCHEDULE) - 1)]
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
