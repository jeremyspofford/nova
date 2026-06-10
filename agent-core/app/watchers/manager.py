"""Manages watchdog Observer instances for fs_watch schedules."""
from __future__ import annotations

import logging

from watchdog.observers import Observer

from .handler import ScheduleWatchHandler

logger = logging.getLogger(__name__)


class WatcherManager:
    """Tracks one Observer per schedule_id. Thread-safe start/stop."""

    def __init__(self) -> None:
        self._observers: dict[str, Observer] = {}

    def start(
        self,
        schedule_id: str,
        path: str,
        on_events: list[str],
        pattern: str,
        recursive: bool = False,
    ) -> None:
        """Start watching `path` for this schedule. Idempotent — stops old watcher first."""
        self.stop(schedule_id)
        handler = ScheduleWatchHandler(
            schedule_id=schedule_id,
            on_events=on_events,
            pattern=pattern,
        )
        observer = Observer()
        observer.schedule(handler, path=path, recursive=recursive)
        observer.start()
        self._observers[schedule_id] = observer
        logger.info("Started fs_watch for schedule=%s path=%s pattern=%s", schedule_id, path, pattern)

    def stop(self, schedule_id: str) -> None:
        """Stop and remove the watcher for this schedule_id. No-op if not watching."""
        observer = self._observers.pop(schedule_id, None)
        if observer is not None:
            observer.stop()
            observer.join(timeout=5)
            logger.info("Stopped fs_watch for schedule=%s", schedule_id)

    def stop_all(self) -> None:
        """Gracefully stop all active watchers."""
        for schedule_id in list(self._observers):
            self.stop(schedule_id)

    @property
    def active_ids(self) -> list[str]:
        return list(self._observers)
