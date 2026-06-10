"""Watchdog event handler that enqueues schedule fire events."""
from __future__ import annotations

import fnmatch
import logging
import queue
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler

logger = logging.getLogger(__name__)

# Module-level queue shared between the handler and the scheduler loop drain.
_fire_queue: queue.Queue = queue.Queue()

_EVENT_TYPE_MAP = {
    "created": "created",
    "modified": "modified",
    "deleted": "deleted",
    "moved": "moved",
}


class ScheduleWatchHandler(FileSystemEventHandler):
    """Watches a directory for file events that match a schedule's trigger config."""

    def __init__(self, schedule_id: str, on_events: list[str], pattern: str) -> None:
        super().__init__()
        self.schedule_id = schedule_id
        self.on_events = set(on_events)
        self.pattern = pattern

    def on_any_event(self, event: FileSystemEvent) -> None:
        # Ignore directory events — we only care about files.
        if event.is_directory:
            return

        event_type = _EVENT_TYPE_MAP.get(event.event_type)
        if event_type is None or event_type not in self.on_events:
            return

        src_path = event.src_path if isinstance(event.src_path, str) else str(event.src_path)
        filename = Path(src_path).name

        if not fnmatch.fnmatch(filename, self.pattern):
            return

        _fire_queue.put_nowait({
            "schedule_id": self.schedule_id,
            "file_path": src_path,
            "file_event": event_type,
        })
        logger.debug(
            "fs_watch fire enqueued: schedule=%s path=%s event=%s",
            self.schedule_id, src_path, event_type,
        )
