"""Aggregates raw screenpipe events into focus sessions.

Boundaries:
- New focus (different app or window) → finalize current, start new.
- 30-min cap → finalize, start new immediately.
- <30s sessions discarded.
- Within session, dedup lines preserving order.
"""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any

logger = logging.getLogger(__name__)


@dataclass
class FocusSession:
    app: str
    window: str
    url: str | None
    started_at: datetime
    ended_at: datetime
    content: str
    word_count: int
    event_count: int
    frame_ids: list[str] = field(default_factory=list)


@dataclass
class _ActiveSession:
    app: str
    window: str
    url: str | None
    started_at: datetime
    last_event_at: datetime
    seen_lines: set[str] = field(default_factory=set)
    ordered_lines: list[str] = field(default_factory=list)
    event_count: int = 0
    frame_ids: list[str] = field(default_factory=list)

    def absorb(self, text: str, frame_id: str) -> None:
        for line in text.splitlines():
            if line and line not in self.seen_lines:
                self.seen_lines.add(line)
                self.ordered_lines.append(line)
        self.event_count += 1
        if frame_id:
            self.frame_ids.append(frame_id)

    def to_finalized(self) -> FocusSession:
        content = "\n".join(self.ordered_lines)
        return FocusSession(
            app=self.app, window=self.window, url=self.url,
            started_at=self.started_at, ended_at=self.last_event_at,
            content=content, word_count=len(content.split()),
            event_count=self.event_count, frame_ids=self.frame_ids,
        )


class SessionAggregator:
    def __init__(
        self,
        on_session: Callable[[FocusSession], None | Awaitable[None]],
        session_min_seconds: int = 30,
        session_max_minutes: int = 30,
    ):
        self._on_session = on_session
        self._session_min = timedelta(seconds=session_min_seconds)
        self._session_max = timedelta(minutes=session_max_minutes)
        self._active: _ActiveSession | None = None

    async def process(self, event: dict[str, Any]) -> None:
        if event.get("name") != "ocr_result":
            return
        data = event.get("data", {}) or {}
        app = data.get("app_name") or ""
        window = data.get("window_name") or ""
        url = data.get("browser_url")
        text = data.get("text") or ""
        ts_raw = data.get("timestamp")
        try:
            ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00"))
        except (ValueError, AttributeError):
            ts = datetime.now(timezone.utc)
        frame_id = data.get("frame_id") or ""

        if self._active is None:
            self._active = _ActiveSession(
                app=app, window=window, url=url, started_at=ts, last_event_at=ts,
            )
            self._active.absorb(text, frame_id)
            return

        # 30-min cap?
        if ts - self._active.started_at >= self._session_max:
            await self._finalize_active()
            self._active = _ActiveSession(
                app=app, window=window, url=url, started_at=ts, last_event_at=ts,
            )
            self._active.absorb(text, frame_id)
            return

        # Focus change?
        if app != self._active.app or window != self._active.window:
            await self._finalize_active()
            self._active = _ActiveSession(
                app=app, window=window, url=url, started_at=ts, last_event_at=ts,
            )
            self._active.absorb(text, frame_id)
            return

        # Same window, same session
        self._active.last_event_at = ts
        self._active.absorb(text, frame_id)

    async def flush(self) -> None:
        if self._active is not None:
            await self._finalize_active()
            self._active = None

    async def _finalize_active(self) -> None:
        assert self._active is not None
        duration = self._active.last_event_at - self._active.started_at
        if duration < self._session_min:
            logger.debug(
                "dropping <%s session for %s/%s",
                self._session_min, self._active.app, self._active.window,
            )
            self._active = None
            return
        finalized = self._active.to_finalized()
        result = self._on_session(finalized)
        if asyncio.iscoroutine(result):
            await result
        self._active = None
